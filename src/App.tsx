import { useEffect, useState } from 'react'
import BitcoinTradingBot from './BtcTradingBot'
import { CONFIG } from './config'

type BackendStatus = {
  status: string
  service: string
  timestamp: string
}

function App() {
  const [backend, setBackend] = useState<BackendStatus | null>(null)
  const [backendError, setBackendError] = useState('')

  useEffect(() => {
    const checkBackend = async () => {
      try {
        const response = await fetch(`${CONFIG.API_URL}/api/health`)
        if (!response.ok) throw new Error('Backend is not responding')

        const data = (await response.json()) as BackendStatus
        setBackend(data)
        setBackendError('')
      } catch (error) {
        setBackend(null)
        setBackendError(
          error instanceof Error ? error.message : 'Cannot connect to backend',
        )
      }
    }

    checkBackend()
    const interval = setInterval(checkBackend, 15000)
    return () => clearInterval(interval)
  }, [])

  return (
    <div className="relative w-full min-h-screen bg-gradient-to-b from-slate-900 via-slate-800 to-slate-900 text-slate-100">
      <div className="pointer-events-none fixed left-0 right-0 top-0 z-50 px-4 pt-4">
        <div className="mx-auto max-w-6xl rounded-lg border border-slate-500/70 bg-slate-900/75 p-3 text-sm text-slate-100 shadow-lg shadow-slate-950/30 backdrop-blur">
          {backend ? (
            <p>
              Backend connected: <strong>{backend.service}</strong> ({backend.status})
            </p>
          ) : (
            <p className="text-red-400">Backend disconnected: {backendError}</p>
          )}
        </div>
      </div>
      <div aria-hidden className="h-20" />
      <BitcoinTradingBot />
    </div>
  )
}

export default App
