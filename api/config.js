export default function handler(_req, res) {
  res.status(200).json({
    symbol: 'BTCUSDT',
    mode: 'paper-trading',
    environment: 'vercel-function',
  })
}
