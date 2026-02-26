export default function handler(_req, res) {
  res.status(200).json({
    status: 'ok',
    service: 'btc-trading-bot-backend',
    timestamp: new Date().toISOString(),
    environment: 'vercel-function',
  })
}
