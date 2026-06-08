import ReactDOM from 'react-dom/client'
import App from './App'

// No StrictMode: its dev-only double-invoke of effects double-mounts the kiosk
// (two WebSocket connects, two video loads that interrupt each other). The WS
// lifecycle is StrictMode-safe regardless (see App.test.tsx), but a always-on
// single-screen kiosk gains nothing from StrictMode and only suffers its churn.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
