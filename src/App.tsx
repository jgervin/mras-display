import { useEffect, useRef, useState, type SyntheticEvent } from 'react'
import { createShuffler } from './shuffle'

const MAX_RETRY_ATTEMPTS = 5
const FADE_MS = 500       // crossfade duration (matches the CSS opacity transition)
const VOLUME_STEPS = 10   // audio ramp granularity over FADE_MS

function getEnv() {
  return {
    WS_URL: import.meta.env.VITE_COMPOSER_WS_URL ?? 'ws://localhost:8002/ws',
    STANDARD_VIDEO_URL: import.meta.env.VITE_STANDARD_VIDEO_URL ?? 'http://localhost:8002/assets/standard.mp4',
    PLAYLIST_URL: import.meta.env.VITE_PLAYLIST_URL ?? 'http://localhost:8002/playlist',
    FALLBACK_VIDEO_PATH: import.meta.env.VITE_FALLBACK_VIDEO_PATH ?? '',
  }
}

const videoStyle = (opacity: number) => ({
  position: 'absolute' as const,
  inset: 0,
  width: '100%',
  height: '100%',
  objectFit: 'cover' as const,
  opacity,
  transition: `opacity ${FADE_MS}ms`,
})

export default function App() {
  // Two stacked <video> elements that crossfade. `frontIdx` is the visible one.
  const videoARef = useRef<HTMLVideoElement>(null)
  const videoBRef = useRef<HTMLVideoElement>(null)
  const frontIdx = useRef<0 | 1>(0)
  const transition = useRef<{ timer?: ReturnType<typeof setTimeout>; ramp?: ReturnType<typeof setInterval> }>({})

  const inFallback = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)
  // Non-null while a personalized (composer-pushed) clip is the current video.
  // Holds its clip id + the composer's trigger_id (echoed back on playback
  // start/end so the composer can key God View playback/ad_run events), plus the
  // local start time for duration_ms. Cleared once we hand control back to the composer.
  const personalizedClipRef = useRef<{ clipId: string; triggerId: string; startedAt?: number } | null>(null)
  const screenIdRef = useRef<string | null>(null)
  // Idle-ad rotation: shuffled cycle over the composer /playlist pool (drop a
  // .mp4 into assets/ to add one). Starts as the single default video.
  const shuffler = useRef(createShuffler([getEnv().STANDARD_VIDEO_URL]))
  const currentIdle = useRef<string | null>(null)
  const paused = useRef(false)
  // Debug badge (?debug=1): screen identity + the last play message's person
  // and ad. Plain HTML — independent of the video pipeline, so it shows the
  // chosen ad even when an on-video overlay failed to render.
  const debugEnabled = new URLSearchParams(window.location.search).get('debug') === '1'
  const [debugInfo, setDebugInfo] = useState<{ person?: string; ad?: string }>({})

  const frontEl = () => (frontIdx.current === 0 ? videoARef.current : videoBRef.current)

  const cancelTransition = () => {
    if (transition.current.timer) { clearTimeout(transition.current.timer); transition.current.timer = undefined }
    if (transition.current.ramp) { clearInterval(transition.current.ramp); transition.current.ramp = undefined }
  }

  // Ramp the old element's audio down and the new element's up over FADE_MS.
  const rampVolume = (front: HTMLVideoElement, back: HTMLVideoElement) => {
    let i = 0
    transition.current.ramp = setInterval(() => {
      i += 1
      const t = i / VOLUME_STEPS
      front.volume = Math.max(0, 1 - t)
      back.volume = Math.min(1, t)
      if (i >= VOLUME_STEPS) { clearInterval(transition.current.ramp); transition.current.ramp = undefined }
    }, FADE_MS / VOLUME_STEPS)
  }

  // Crossfade: fade `back` (already loaded + playing) in while `front` fades out.
  const startFade = (front: HTMLVideoElement, back: HTMLVideoElement) => {
    cancelTransition()
    console.log('[kiosk] playing', back.src)
    back.style.opacity = '1'
    front.style.opacity = '0'
    rampVolume(front, back)
    transition.current.timer = setTimeout(() => {
      if (front.style.opacity === '0') front.pause() // stop the now-hidden element
    }, FADE_MS)
  }

  // Playback echo → composer's _handle_display_echo (events journal). Both require
  // a truthy trigger_id AND screen_id; a legacy play without a trigger_id is a
  // no-op (never crash). The composer clock is authoritative — `ts` is informational.
  const emitPlaybackStarted = (clip: { triggerId: string; startedAt?: number }) => {
    if (!clip.triggerId) return
    clip.startedAt = Date.now()
    wsRef.current?.send(JSON.stringify({
      type: 'playback_started',
      trigger_id: clip.triggerId,
      screen_id: screenIdRef.current,
      ts: new Date().toISOString(),
    }))
  }

  const emitPlaybackEnded = (clip: { triggerId: string; startedAt?: number }) => {
    if (!clip.triggerId) return
    const msg: Record<string, unknown> = {
      type: 'playback_ended',
      trigger_id: clip.triggerId,
      screen_id: screenIdRef.current,
      ts: new Date().toISOString(),
    }
    if (clip.startedAt != null) msg.duration_ms = Date.now() - clip.startedAt
    wsRef.current?.send(JSON.stringify(msg))
  }

  // Load `url` into the hidden element and crossfade to it. Loading the hidden
  // element (not the visible one) avoids interrupting the playing video.
  // `onPlaying` fires once playback actually starts (used to echo playback_started
  // for a personalized clip; idle/fallback plays pass nothing).
  const playVideo = (url: string, loop: boolean = false, onPlaying?: () => void) => {
    const a = videoARef.current
    const b = videoBRef.current
    if (!a || !b) return
    console.log('[kiosk] playVideo', { url, loop })
    cancelTransition()
    const front = frontIdx.current === 0 ? a : b
    const back = frontIdx.current === 0 ? b : a
    frontIdx.current = frontIdx.current === 0 ? 1 : 0 // back becomes the new front now
    back.loop = loop
    back.volume = 0
    back.src = url
    back.load()
    back.play()
      .then(() => { startFade(front, back); onPlaying?.() })
      .catch((err) => { console.warn('[kiosk] video.play() rejected:', err); startFade(front, back) })
  }

  // Play the current idle ad (loop=false so onEnded advances the rotation);
  // pulls the first item from the shuffled cycle on the very first call.
  const playCurrentIdle = () => {
    const url = currentIdle.current ?? shuffler.current.next()
    currentIdle.current = url
    playVideo(url, false)
  }

  // Move to the next idle ad in the shuffled cycle and play it.
  const advanceIdle = () => {
    const url = shuffler.current.next()
    currentIdle.current = url
    playVideo(url, false)
  }

  // Re-fetch the drop-in playlist (composer /playlist). Updates the list in
  // place so a newly dropped .mp4 is picked up live, no kiosk restart. Keeps
  // the current list on any failure so the screen is never dark.
  const refreshPlaylist = () =>
    fetch(getEnv().PLAYLIST_URL)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data?.videos) && data.videos.length) {
          shuffler.current.setItems(data.videos)
        }
      })
      .catch(() => {})

  const startFallback = () => {
    const { FALLBACK_VIDEO_PATH } = getEnv()
    if (FALLBACK_VIDEO_PATH && !inFallback.current) {
      inFallback.current = true
      playVideo(`file://${FALLBACK_VIDEO_PATH}`, true)
    }
  }

  const togglePause = () => {
    if (paused.current) {
      paused.current = false
      frontEl()?.play()
    } else {
      paused.current = true
      frontEl()?.pause()
    }
  }

  const handleEnded = (e: SyntheticEvent<HTMLVideoElement>) => {
    // Only the visible/front element drives the rotation (the hidden one is paused).
    if (e.currentTarget !== frontEl()) return
    // Don't advance while the user has the loop paused.
    if (paused.current) return
    if (inFallback.current) return
    // A personalized clip just finished → tell the composer and let IT decide
    // what plays next (next round, or release to idle). Do NOT auto-advance the
    // idle shuffle: the composer owns this display until it says otherwise.
    if (personalizedClipRef.current !== null) {
      const clip = personalizedClipRef.current
      personalizedClipRef.current = null
      // Echo playback_ended (God View journal) THEN clip_ended (orchestrator advance).
      emitPlaybackEnded(clip)
      wsRef.current?.send(JSON.stringify({
        type: 'clip_ended', screen_id: screenIdRef.current, clip_id: clip.clipId,
      }))
      return
    }
    // An idle ad finished → re-check the playlist (picks up drop-ins live) and
    // advance the idle loop.
    refreshPlaylist()
    advanceIdle()
  }

  useEffect(() => {
    // `live` is captured per effect invocation. Under React StrictMode the
    // effect runs twice (mount → cleanup → mount); a shared ref would be reset
    // by the remount and let a stale socket's late onclose reconnect, leaving a
    // zombie socket. A per-invocation closure flag is immune to that race.
    let live = true
    let retryDelay = 1000
    let retryCount = 0
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    const { WS_URL } = getEnv()
    // Multi-display: each kiosk window carries its identity in the query
    // string (electron/main.js sets ?screen_id=display-<n>). Forwarded on the
    // WS URL so the composer can target individual displays later; the
    // composer ignores it today (broadcasts `play` to every client).
    const screenId = new URLSearchParams(window.location.search).get('screen_id')
    screenIdRef.current = screenId  // used by handleEnded to tag clip_ended
    const wsUrl = screenId
      ? `${WS_URL}${WS_URL.includes('?') ? '&' : '?'}screen_id=${encodeURIComponent(screenId)}`
      : WS_URL

    // Load the idle-ad playlist and start rotation from it; keep the single
    // default on failure so the screen is never dark.
    refreshPlaylist().then(() => {
      if (live && !inFallback.current) {
        playCurrentIdle()
      }
    })

    const open = () => {
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        console.log('[kiosk] WS connected')
        retryDelay = 1000
        retryCount = 0
        if (inFallback.current) {
          inFallback.current = false
          playCurrentIdle()
        }
      }

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data) as {
          type: string; video_url: string; person?: string; ad?: string; clip_id?: string; trigger_id?: string
        }
        console.log('[kiosk] WS message', msg)
        if (msg.type === 'play') {
          paused.current = false // generated clips always play; idle resumes un-paused afterward
          // A personalized clip already playing is being superseded → echo its end.
          if (personalizedClipRef.current) emitPlaybackEnded(personalizedClipRef.current)
          // Mark this as a personalized clip so its end emits clip_ended (and
          // does not auto-advance idle). clip_id falls back to the url; trigger_id
          // (echo key) falls back to '' for legacy plays → echo is skipped.
          const clip = { clipId: msg.clip_id ?? msg.video_url, triggerId: msg.trigger_id ?? '' }
          personalizedClipRef.current = clip
          setDebugInfo({ person: msg.person, ad: msg.ad })
          playVideo(msg.video_url, false, () => { if (personalizedClipRef.current === clip) emitPlaybackStarted(clip) })
        } else if (msg.type === 'idle') {
          // Composer released this display → echo the outgoing clip's end, then
          // resume the idle shuffle.
          if (personalizedClipRef.current) emitPlaybackEnded(personalizedClipRef.current)
          personalizedClipRef.current = null
          advanceIdle()
        }
      }

      ws.onclose = () => {
        if (!live) return // this effect was cleaned up — don't reconnect
        retryCount += 1
        if (retryCount >= MAX_RETRY_ATTEMPTS) {
          startFallback()
        }
        const delay = retryDelay
        retryDelay = Math.min(delay * 2, 30000)
        reconnectTimer = setTimeout(open, delay)
      }
    }

    // Idle playback is started above, after refreshPlaylist() resolves (and gated by
    // `live`, so it's StrictMode-safe). Do NOT also start it synchronously here — a second
    // start flips frontIdx an extra time, desyncing it from the visible element and freezing
    // the rotation (handleEnded's front-element guard then never matches).
    open()

    return () => {
      live = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      wsRef.current?.close()
    }
  }, [])

  return (
    <div style={{ position: 'relative', width: '100vw', height: '100vh', background: '#000' }} onClick={togglePause}>
      <video ref={videoARef} style={videoStyle(1)} autoPlay playsInline onEnded={handleEnded} />
      <video ref={videoBRef} style={videoStyle(0)} autoPlay playsInline onEnded={handleEnded} />
      {debugEnabled && (
        <div
          data-testid="debug-badge"
          style={{
            position: 'absolute', top: 8, left: 8, zIndex: 10,
            padding: '4px 10px', borderRadius: 6, fontFamily: 'monospace',
            fontSize: 14, color: '#0f0', background: 'rgba(0,0,0,0.65)',
            pointerEvents: 'none',
          }}
        >
          {new URLSearchParams(window.location.search).get('screen_id') ?? 'display-?'}
          {' · '}{debugInfo.person ?? '—'}{' · '}{debugInfo.ad ?? 'idle'}
        </div>
      )}
    </div>
  )
}
