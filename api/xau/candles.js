const normalizeBinance = (rows) => {
  if (!Array.isArray(rows)) return []
  return rows
    .map((k) => {
      const open = Number(k[1])
      const high = Number(k[2])
      const low = Number(k[3])
      const close = Number(k[4])
      const volume = Number(k[5] ?? 0)
      const time = Number(k[0])
      return { time, open, high, low, close, volume, isGreen: close >= open }
    })
    .filter((c) => Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close))
}

const normalizeBingx = (payload) => {
  const rows = payload?.data?.data || payload?.data || []
  if (!Array.isArray(rows)) return []
  return rows
    .map((k) => {
      const open = Number(k.open ?? k.o ?? k[1])
      const high = Number(k.high ?? k.h ?? k[2])
      const low = Number(k.low ?? k.l ?? k[3])
      const close = Number(k.close ?? k.c ?? k[4])
      const volume = Number(k.volume ?? k.v ?? k[5] ?? 0)
      const t = Number(k.time ?? k.t ?? k[0])
      const time = t < 1_000_000_000_000 ? t * 1000 : t
      return { time, open, high, low, close, volume, isGreen: close >= open }
    })
    .filter((c) => Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close))
}

const fetchBinance = async ({ interval, limit, startTime, endTime }) => {
  const params = new URLSearchParams({
    symbol: 'PAXGUSDT',
    interval,
    limit: String(Math.min(limit, 1000)),
  })
  if (startTime > 0) params.set('startTime', String(startTime))
  if (endTime > 0) params.set('endTime', String(endTime))

  const response = await fetch(`https://api.binance.com/api/v3/klines?${params.toString()}`)
  if (!response.ok) throw new Error(`Binance PAXGUSDT lỗi (${response.status})`)
  const data = await response.json()
  return normalizeBinance(data)
}

const fetchBingx = async ({ interval, limit }) => {
  const params = new URLSearchParams({
    symbol: 'XAU-USDT',
    interval,
    limit: String(Math.min(limit, 1000)),
  })

  const response = await fetch(`https://open-api.bingx.com/openApi/swap/v3/quote/klines?${params.toString()}`)
  if (!response.ok) throw new Error(`BingX XAU-USDT lỗi (${response.status})`)
  const data = await response.json()
  return normalizeBingx(data)
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Method not allowed' })
    return
  }

  const interval = String(req.query.interval || '1m')
  const limit = Math.max(1, Math.min(5000, Number(req.query.limit || 2000)))
  const startTime = Number(req.query.startTime || 0)
  const endTime = Number(req.query.endTime || 0)

  try {
    const candles = await fetchBinance({ interval, limit, startTime, endTime })
    if (candles.length > 0) {
      res.status(200).json({ ok: true, source: 'binance', candles: candles.slice(-limit) })
      return
    }
  } catch (_error) {
    // fallback sang BingX
  }

  try {
    const candles = await fetchBingx({ interval, limit })
    res.status(200).json({ ok: true, source: 'bingx', candles: candles.slice(-limit) })
  } catch (error) {
    res.status(500).json({ ok: false, error: error?.message || 'Không thể tải dữ liệu XAU/USD từ Binance/BingX' })
  }
}
