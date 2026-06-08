import { useEffect, useRef } from 'react'

const MAX_RETRY_ATTEMPTS = 5

function getEnv() {
  return {
    WS_URL: import.meta.env.VITE_COMPOSER_WS_URL ?? 'ws://localhost:8002/ws',
    STANDARD_VIDEO_URL: import.meta.env.VITE_STANDARD_VIDEO_URL ?? 'http://localhost:8002/assets/standard.mp4',
    PLAYLIST_URL: import.meta.env.VITE_PLAYLIST_URL ?? 'http://localhost:8002/playlist',
    FALLBACK_VIDEO_PATH: import.meta.env.VITE_FALLBACK_VIDEO_PATH ?? '',
  }
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const inFallback = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)
  const pendingPlay = useRef<ReturnType<typeof setTimeout>>()
  // Idle-ad rotation: sequential playlist, replaced by the composer /playlist
  // response (drop a .mp4 into assets/ to add one). Starts as the single default.
  const playlist = useRef<string[]>([getEnv().STANDARD_VIDEO_URL])
  const idleIndex = useRef(0)

  const playVideo = (url: string, loop: boolean = false) => {
    const video = videoRef.current
    if (!video) return
    console.log('[kiosk] playVideo', { url, loop })
    // Cancel any in-flight fade/load so a new request can't interrupt the
    // previous load() mid-flight (DOMException: play() interrupted by load).
    if (pendingPlay.current) clearTimeout(pendingPlay.current)
    video.style.opacity = '0'
    pendingPlay.current = setTimeout(() => {
      video.src = url
      video.loop = loop
      video.load()
      video.play()
        .then(() => console.log('[kiosk] playing', url))
        .catch((err) => console.warn('[kiosk] video.play() rejected:', err))
      video.style.opacity = '1'
    }, 500)
  }

  // Play the current idle ad (loop=false so onEnded advances the rotation).
  const playCurrentIdle = () => {
    const list = playlist.current
    playVideo(list[idleIndex.current % list.length], false)
  }

  // Move to the next idle ad in the playlist and play it.
  const advanceIdle = () => {
    idleIndex.current = (idleIndex.current + 1) % playlist.current.length
    playCurrentIdle()
  }

  // Re-fetch the drop-in playlist (composer /playlist). Updates the list in
  // place so a newly dropped .mp4 is picked up live, no kiosk restart. Keeps
  // the current list on any failure so the screen is never dark.
  const refreshPlaylist = () =>
    fetch(getEnv().PLAYLIST_URL)
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data?.videos) && data.videos.length) {
          playlist.current = data.videos
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

  const handleEnded = () => {
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

    // Load the idle-ad playlist and start rotation from it; keep the single
    // default on failure so the screen is never dark.
    refreshPlaylist().then(() => {
      if (live && !inFallback.current) {
        idleIndex.current = 0
        playCurrentIdle()
      }
    })

    const open = () => {
      const ws = new WebSocket(WS_URL)
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

    playCurrentIdle()
    open()

    return () => {
      live = false
      if (reconnectTimer) clearTimeout(reconnectTimer)
      wsRef.current?.close()
    }
  }, [])

  return (
    <div style={{ width: '100vw', height: '100vh', background: '#000' }}>
      <video
        ref={videoRef}
        style={{ width: '100%', height: '100%', objectFit: 'cover', transition: 'opacity 0.5s' }}
        autoPlay
        playsInline
        onEnded={handleEnded}
      />
    </div>
  )
}
