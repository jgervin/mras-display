import { useEffect, useRef, type SyntheticEvent } from 'react'
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
  // Idle-ad rotation: shuffled cycle over the composer /playlist pool (drop a
  // .mp4 into assets/ to add one). Starts as the single default video.
  const shuffler = useRef(createShuffler([getEnv().STANDARD_VIDEO_URL]))
  const currentIdle = useRef<string | null>(null)
  const paused = useRef(false)

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

  // Load `url` into the hidden element and crossfade to it. Loading the hidden
  // element (not the visible one) avoids interrupting the playing video.
  const playVideo = (url: string, loop: boolean = false) => {
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
      .then(() => startFade(front, back))
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
    // An idle ad or a personalized clip just finished → re-check the playlist
    // (picks up drop-ins live) and advance the idle loop.
    if (!inFallback.current) {
      refreshPlaylist()
      advanceIdle()
    }
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
        const msg = JSON.parse(event.data) as { type: string; video_url: string }
        console.log('[kiosk] WS message', msg)
        if (msg.type === 'play') {
          paused.current = false // generated clips always play; idle resumes un-paused afterward
          playVideo(msg.video_url, false)
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
    </div>
  )
}
