import { Analytics } from '@vercel/analytics/react'
import BitcoinTradingBot from './BtcTradingBot'

function App() {
  return (
    <div className="w-full min-h-screen bg-[#0b0e11]">
      <BitcoinTradingBot />
      <Analytics />
    </div>
  )
}

export default App