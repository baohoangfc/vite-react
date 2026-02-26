export default function handler(req, res) {
  if (req.method === 'GET') {
    res.status(200).json({
      isRunning: false,
      startedAt: null,
      symbol: 'BTCUSDT',
      heartbeatMs: 600000,
      background: false,
      note: 'Background runtime is only available in local backend-server.mjs process.',
    })
    return
  }

  if (req.method === 'POST') {
    res.status(501).json({
      ok: false,
      error: 'Background runtime control is not supported in Vercel serverless mode.',
    })
    return
  }

  res.status(405).json({ ok: false, error: 'Method not allowed' })
}
