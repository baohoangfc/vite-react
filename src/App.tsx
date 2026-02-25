import { SpeedInsights } from '@vercel/speed-insights/react'
import BitcoinTradingBot from './BtcTradingBot'

function App() {
  return (
    <div className="w-full min-h-screen bg-[#0b0e11]">
      <BitcoinTradingBot />
      <SpeedInsights />
    </div>
  )
}

export default App