import { CONFIG } from '../config'
import { Candle } from '../types'
import { calculateSMA } from './indicators'

export interface BacktestResult {
  initialBalance: number
  finalBalance: number
  totalTrades: number
  winRate: number
  profitFactor: number
  expectancy: number
  maxDrawdownPercent: number
  netPnl: number
}

type TrendBias = 'BULLISH' | 'BEARISH' | 'NEUTRAL'
type Side = 'LONG' | 'SHORT'

type OrderBlock = {
  low: number
  high: number
  open: number
  midpoint: number
}

type PendingOrder = {
  side: Side
  entryPrice: number
  slPrice: number
  tpPrice: number
  setupIndex: number
}

type ActiveTrade = {
  side: Side
  entryPrice: number
  slPrice: number
  tpPrice: number
  size: number
  openFee: number
}

const FEE_RATE = CONFIG.FEE
const RISK_PER_TRADE = 0.01
const DAILY_LOSS_LIMIT = 0.03
const RR_TARGET = 2.2
const ATR_PERIOD = 14
const SWEEP_LOOKBACK = 20
const BOS_LOOKBACK = 8
const MAX_PENDING_BARS = 6
const EQUAL_TOLERANCE_BPS = 0.0008
const HTF_INTERVAL_MIN = 240 // 4H
const LTF_INTERVAL_MIN = 15

const hasMomentumConfirmation = (candle: Candle, side: Side, atr: number): boolean => {
  const range = candle.high - candle.low
  if (range <= 0) return false

  const body = Math.abs(candle.close - candle.open)
  const bodyRatio = body / range
  const rangeVsAtr = atr > 0 ? range / atr : 0
  if (bodyRatio < 0.55 || rangeVsAtr < 0.7) return false

  if (side === 'LONG') {
    const closeInUpperPart = candle.close >= candle.low + range * 0.7
    return candle.close > candle.open && closeInUpperPart
  }

  const closeInLowerPart = candle.close <= candle.high - range * 0.7
  return candle.close < candle.open && closeInLowerPart
}

const aggregateCandles = (candles: Candle[], intervalMinutes: number): Candle[] => {
  if (candles.length === 0) return []

  const bucketMs = intervalMinutes * 60 * 1000
  const buckets = new Map<number, Candle[]>()

  for (const candle of candles) {
    const bucket = Math.floor(candle.time / bucketMs) * bucketMs
    if (!buckets.has(bucket)) buckets.set(bucket, [])
    buckets.get(bucket)!.push(candle)
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucket, items]) => {
      const open = items[0].open
      const close = items[items.length - 1].close
      const high = Math.max(...items.map((c) => c.high))
      const low = Math.min(...items.map((c) => c.low))
      const volume = items.reduce((sum, c) => sum + c.volume, 0)

      return {
        time: bucket,
        open,
        high,
        low,
        close,
        volume,
        isGreen: close >= open,
      }
    })
}

const calculateEMA = (values: number[], period: number): number[] => {
  if (!values.length) return []
  const alpha = 2 / (period + 1)
  const ema = [values[0]]
  for (let i = 1; i < values.length; i++) {
    ema.push(values[i] * alpha + ema[i - 1] * (1 - alpha))
  }
  return ema
}

const calculateATR = (candles: Candle[], period: number): number[] => {
  if (!candles.length) return []
  const trs: number[] = [candles[0].high - candles[0].low]

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]
    const prevClose = candles[i - 1].close
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose))
    trs.push(tr)
  }

  const atr: number[] = []
  for (let i = 0; i < trs.length; i++) {
    if (i < period - 1) {
      atr.push(trs[i])
      continue
    }
    if (i === period - 1) {
      atr.push(trs.slice(0, period).reduce((a, b) => a + b, 0) / period)
      continue
    }
    atr.push((atr[i - 1] * (period - 1) + trs[i]) / period)
  }

  return atr
}

const getHtfTrendBias = (candles: Candle[], ema200: number[]): TrendBias => {
  if (candles.length < 4) return 'NEUTRAL'
  const last = candles[candles.length - 1]
  const prev1 = candles[candles.length - 2]
  const prev2 = candles[candles.length - 3]

  const bullishStructure = last.high > prev1.high && prev1.high > prev2.high && last.low > prev1.low
  const bearishStructure = last.low < prev1.low && prev1.low < prev2.low && last.high < prev1.high

  const lastEma = ema200[ema200.length - 1] ?? last.close

  if (bullishStructure || last.close > lastEma) return 'BULLISH'
  if (bearishStructure || last.close < lastEma) return 'BEARISH'
  return 'NEUTRAL'
}

const getLiquiditySweep = (candles: Candle[], index: number, atr: number): { side: Side; level: number } | null => {
  if (index < SWEEP_LOOKBACK) return null
  const current = candles[index]
  const lookback = candles.slice(index - SWEEP_LOOKBACK, index)

  const highPool = Math.max(...lookback.map((c) => c.high))
  const lowPool = Math.min(...lookback.map((c) => c.low))
  const tolerance = Math.max(atr * 0.2, current.close * EQUAL_TOLERANCE_BPS)

  const equalHighCount = lookback.filter((c) => Math.abs(c.high - highPool) <= tolerance).length
  if (equalHighCount >= 2 && current.high > highPool + tolerance && current.close < highPool) {
    return { side: 'SHORT', level: highPool }
  }

  const equalLowCount = lookback.filter((c) => Math.abs(c.low - lowPool) <= tolerance).length
  if (equalLowCount >= 2 && current.low < lowPool - tolerance && current.close > lowPool) {
    return { side: 'LONG', level: lowPool }
  }

  return null
}

const findOrderBlock = (candles: Candle[], index: number, side: Side): OrderBlock | null => {
  if (index < BOS_LOOKBACK + 2) return null
  const current = candles[index]
  const recent = candles.slice(index - BOS_LOOKBACK, index)

  if (side === 'LONG') {
    const recentSwingHigh = Math.max(...recent.map((c) => c.high))
    if (current.close <= recentSwingHigh) return null

    for (let i = index - 1; i >= index - BOS_LOOKBACK; i--) {
      const c = candles[i]
      if (c.close < c.open) {
        const low = Math.min(c.open, c.close)
        const high = Math.max(c.open, c.close)
        return { low, high, open: c.open, midpoint: (low + high) / 2 }
      }
    }
  }

  if (side === 'SHORT') {
    const recentSwingLow = Math.min(...recent.map((c) => c.low))
    if (current.close >= recentSwingLow) return null

    for (let i = index - 1; i >= index - BOS_LOOKBACK; i--) {
      const c = candles[i]
      if (c.close > c.open) {
        const low = Math.min(c.open, c.close)
        const high = Math.max(c.open, c.close)
        return { low, high, open: c.open, midpoint: (low + high) / 2 }
      }
    }
  }

  return null
}

const isAllowedTradingHourUtc = (timestampMs: number): boolean => {
  const hour = new Date(timestampMs).getUTCHours()
  return (hour >= 13 && hour < 17) || (hour >= 20 && hour < 24)
}

const getDayKey = (timestampMs: number): string => new Date(timestampMs).toISOString().slice(0, 10)

export const runBacktest = (candles: Candle[]): BacktestResult => {
  const ltfCandles = aggregateCandles(candles, LTF_INTERVAL_MIN)
  const htfCandles = aggregateCandles(candles, HTF_INTERVAL_MIN)

  let balance = CONFIG.INITIAL_BALANCE
  const initialBalance = balance
  let peakEquity = balance
  let maxDrawdownPercent = 0
  const tradePnls: number[] = []

  const atr = calculateATR(ltfCandles, ATR_PERIOD)
  const volSmaSeries = ltfCandles.map((_, index) => calculateSMA(ltfCandles.slice(0, index + 1).map((c) => c.volume), 20))
  const ltfCloses = ltfCandles.map((c) => c.close)
  const ltfEma20 = calculateEMA(ltfCloses, 20)
  const ltfEma50 = calculateEMA(ltfCloses, 50)

  let pendingOrder: PendingOrder | null = null
  let activeTrade: ActiveTrade | null = null

  let currentDay = ''
  let dayStartBalance = balance
  let dayRealizedPnl = 0

  for (let i = Math.max(ATR_PERIOD, SWEEP_LOOKBACK, BOS_LOOKBACK); i < ltfCandles.length; i++) {
    const candle = ltfCandles[i]
    const dayKey = getDayKey(candle.time)

    if (dayKey !== currentDay) {
      currentDay = dayKey
      dayStartBalance = balance
      dayRealizedPnl = 0
    }

    if (activeTrade) {
      const isLong = activeTrade.side === 'LONG'
      const hitSl = isLong ? candle.low <= activeTrade.slPrice : candle.high >= activeTrade.slPrice
      const hitTp = isLong ? candle.high >= activeTrade.tpPrice : candle.low <= activeTrade.tpPrice

      if (hitSl || hitTp) {
        const exitPrice = hitSl ? activeTrade.slPrice : activeTrade.tpPrice
        const pnl = isLong
          ? (exitPrice - activeTrade.entryPrice) * activeTrade.size
          : (activeTrade.entryPrice - exitPrice) * activeTrade.size
        const closeFee = Math.abs(exitPrice * activeTrade.size) * FEE_RATE
        const finalPnl = pnl - closeFee - activeTrade.openFee

        balance += finalPnl
        dayRealizedPnl += finalPnl
        tradePnls.push(finalPnl)
        activeTrade = null
      }
    }

    if (balance > peakEquity) peakEquity = balance
    const dd = ((peakEquity - balance) / peakEquity) * 100
    if (dd > maxDrawdownPercent) maxDrawdownPercent = dd

    if (activeTrade) continue

    const dailyLossExceeded = dayStartBalance > 0 && Math.abs(dayRealizedPnl) / dayStartBalance >= DAILY_LOSS_LIMIT && dayRealizedPnl < 0
    if (dailyLossExceeded) {
      pendingOrder = null
      continue
    }

    if (pendingOrder) {
      const orderExpired = i - pendingOrder.setupIndex > MAX_PENDING_BARS
      const orderInvalidated = pendingOrder.side === 'LONG' ? candle.low < pendingOrder.slPrice : candle.high > pendingOrder.slPrice
      if (orderExpired || orderInvalidated) {
        pendingOrder = null
        continue
      }

      const touched = candle.low <= pendingOrder.entryPrice && candle.high >= pendingOrder.entryPrice
      if (touched) {
        const riskCapital = balance * RISK_PER_TRADE
        const slDistance = Math.abs(pendingOrder.entryPrice - pendingOrder.slPrice)
        if (slDistance <= 0) {
          pendingOrder = null
          continue
        }

        const size = riskCapital / slDistance
        const openFee = Math.abs(pendingOrder.entryPrice * size) * FEE_RATE

        activeTrade = {
          side: pendingOrder.side,
          entryPrice: pendingOrder.entryPrice,
          slPrice: pendingOrder.slPrice,
          tpPrice: pendingOrder.tpPrice,
          size,
          openFee,
        }
        pendingOrder = null
      }
      continue
    }

    if (!isAllowedTradingHourUtc(candle.time)) continue

    const volumeSma = volSmaSeries[i]
    if (!volumeSma || candle.volume <= volumeSma * 1.3) continue

    const currentAtr = atr[i]
    if (!currentAtr || currentAtr <= 0) continue

    const htfSlice = htfCandles.filter((c) => c.time <= candle.time)
    if (htfSlice.length < 3) continue
    const htfEma200 = calculateEMA(htfSlice.map((c) => c.close), 200)
    const trendBias = getHtfTrendBias(htfSlice, htfEma200)
    if (trendBias === 'NEUTRAL') continue

    const sweep = getLiquiditySweep(ltfCandles, i, currentAtr)
    if (!sweep) continue

    const side: Side = trendBias === 'BULLISH' ? 'LONG' : 'SHORT'
    if (side !== sweep.side) continue

    const ema20 = ltfEma20[i]
    const ema50 = ltfEma50[i]
    if (!ema20 || !ema50) continue

    const emaAligned = side === 'LONG' ? candle.close > ema20 && ema20 > ema50 : candle.close < ema20 && ema20 < ema50
    if (!emaAligned) continue

    if (!hasMomentumConfirmation(candle, side, currentAtr)) continue

    const ob = findOrderBlock(ltfCandles, i, side)
    if (!ob) continue

    const entryPrice = ob.midpoint
    const slPrice = side === 'LONG' ? ob.low - currentAtr * 0.5 : ob.high + currentAtr * 0.5
    const risk = Math.abs(entryPrice - slPrice)
    if (risk <= 0) continue

    const tpPrice = side === 'LONG' ? entryPrice + risk * RR_TARGET : entryPrice - risk * RR_TARGET
    const rr = Math.abs(tpPrice - entryPrice) / risk
    if (rr < RR_TARGET) continue

    pendingOrder = {
      side,
      entryPrice,
      slPrice,
      tpPrice,
      setupIndex: i,
    }
  }

  const wins = tradePnls.filter((v) => v > 0)
  const losses = tradePnls.filter((v) => v < 0)
  const grossProfit = wins.reduce((a, b) => a + b, 0)
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b, 0))

  return {
    initialBalance,
    finalBalance: balance,
    totalTrades: tradePnls.length,
    winRate: tradePnls.length ? (wins.length / tradePnls.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0,
    expectancy: tradePnls.length ? tradePnls.reduce((a, b) => a + b, 0) / tradePnls.length : 0,
    maxDrawdownPercent,
    netPnl: balance - initialBalance,
  }
}
