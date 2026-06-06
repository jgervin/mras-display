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
  const retryDelay = useRef(1000)
  const retryCount = useRef(0)
  const inFallback = useRef(false)
  const wsRef = useRef<WebSocket | null>(null)

  const playVideo = (url: string, loop: boolean = false) => {
    const video = videoRef.current
    if (!video) return
    video.style.opacity = '0'
    setTimeout(() => {
      video.src = url
      video.loop = loop
      video.load()
      video.play().catch(() => {})
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

  const connect = () => {
    const { WS_URL, STANDARD_VIDEO_URL } = getEnv()
    const ws = new WebSocket(WS_URL)
    wsRef.current = ws

    ws.onopen = () => {
      retryDelay.current = 1000
      retryCount.current = 0
      if (inFallback.current) {
        inFallback.current = false
        playVideo(STANDARD_VIDEO_URL, true)
      }
    }

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data) as { type: string; video_url: string }
      if (msg.type === 'play') {
        playVideo(msg.video_url, false)
      }
    }

    ws.onclose = () => {
      retryCount.current += 1
      if (retryCount.current >= MAX_RETRY_ATTEMPTS) {
        startFallback()
      }
      const delay = retryDelay.current
      retryDelay.current = Math.min(delay * 2, 30000)
      setTimeout(connect, delay)
    }
  }

  const handleEnded = () => {
    const { STANDARD_VIDEO_URL } = getEnv()
    if (!inFallback.current) {
      playVideo(STANDARD_VIDEO_URL, true)
    }
  }

  useEffect(() => {
    const { STANDARD_VIDEO_URL } = getEnv()
    playVideo(STANDARD_VIDEO_URL, true)
    connect()
    return () => wsRef.current?.close()
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
