import { useEffect, useRef } from 'react'

const MAX_RETRY_ATTEMPTS = 5

function getEnv() {
  return {
    WS_URL: import.meta.env.VITE_COMPOSER_WS_URL ?? 'ws://localhost:8002/ws',
    STANDARD_VIDEO_URL: import.meta.env.VITE_STANDARD_VIDEO_URL ?? 'http://localhost:8002/assets/standard.mp4',
    FALLBACK_VIDEO_PATH: import.meta.env.VITE_FALLBACK_VIDEO_PATH ?? '',
  }
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const inFallback = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)

  const playVideo = (url: string, loop: boolean = false) => {
    const video = videoRef.current
    if (!video) return
    console.log('[kiosk] playVideo', { url, loop })
    video.style.opacity = '0'
    setTimeout(() => {
      video.src = url
      video.loop = loop
      video.load()
      video.play()
        .then(() => console.log('[kiosk] playing', url))
        .catch((err) => console.warn('[kiosk] video.play() rejected:', err))
      video.style.opacity = '1'
    }, 500)
  }

  const startFallback = () => {
    const { FALLBACK_VIDEO_PATH } = getEnv()
    if (FALLBACK_VIDEO_PATH && !inFallback.current) {
      inFallback.current = true
      playVideo(`file://${FALLBACK_VIDEO_PATH}`, true)
    }
  }

  const handleEnded = () => {
    const { STANDARD_VIDEO_URL } = getEnv()
    if (!inFallback.current) {
      playVideo(STANDARD_VIDEO_URL, true)
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
    const { WS_URL, STANDARD_VIDEO_URL } = getEnv()

    const open = () => {
      const ws = new WebSocket(WS_URL)
      wsRef.current = ws

      ws.onopen = () => {
        console.log('[kiosk] WS connected')
        retryDelay = 1000
        retryCount = 0
        if (inFallback.current) {
          inFallback.current = false
          playVideo(STANDARD_VIDEO_URL, true)
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

    playVideo(STANDARD_VIDEO_URL, true)
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
