import { useEffect, useState } from 'react'
import GoldXauTradingBot from './BtcTradingBot'
import { CONFIG } from './config'

type BackendStatus = {
  status: string
  service: string
  timestamp: string
}

function App() {
  const [backend, setBackend] = useState<BackendStatus | null>(null)
  const [backendError, setBackendError] = useState('')
  const [showBackendConnected, setShowBackendConnected] = useState(false)

  useEffect(() => {
    const checkBackend = async () => {
      try {
        const response = await fetch(`${CONFIG.API_URL}/api/health`)
        if (!response.ok) throw new Error('Backend is not responding')

        const data = (await response.json()) as BackendStatus
        setBackend(data)
        setBackendError('')
        setShowBackendConnected(true)
      } catch (error) {
        setBackend(null)
        setBackendError(
          error instanceof Error ? error.message : 'Cannot connect to backend',
        )
        setShowBackendConnected(false)
      }
    }

    checkBackend()
    const interval = setInterval(checkBackend, 15000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (!backend || !showBackendConnected) return
    const timer = setTimeout(() => setShowBackendConnected(false), 1500)
    return () => clearTimeout(timer)
  }, [backend, showBackendConnected])

  const shouldShowBanner = Boolean(backendError) || showBackendConnected

  return (
    <div className="relative w-full min-h-screen text-slate-100 pb-4">
      {shouldShowBanner && (
        <div className="pointer-events-none fixed left-0 right-0 top-0 z-50 px-4 pt-4">
          <div className="mx-auto max-w-6xl ios-card p-3 text-sm text-slate-900">
            {backend && showBackendConnected ? (
              <p>
                Backend connected: <strong>{backend.service}</strong> ({backend.status})
              </p>
            ) : (
              <p className="text-rose-700">Backend disconnected: {backendError}</p>
            )}
          </div>
        </div>
      )}
      <div aria-hidden className={shouldShowBanner ? 'h-20' : 'h-4'} />
      <GoldXauTradingBot />
    </div>
  )
}

export default App
