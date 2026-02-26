import { CONFIG } from '../config'
import { Analysis, Candle } from '../types'
import {
  calculateRSI,
  calculateSMA,
  calculateScores,
  calculateZLEMA,
  detectSMC,
  getMACD,
} from './indicators'

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

export const runBacktest = (candles: Candle[]): BacktestResult => {
  let balance = CONFIG.INITIAL_BALANCE
  const initialBalance = balance
  let peakEquity = balance
  let maxDrawdownPercent = 0
  let position: null | {
    type: 'LONG' | 'SHORT'
    entryPrice: number
    margin: number
    size: number
    tpPrice: number
    slPrice: number
    openFee: number
  } = null

  const tradePnls: number[] = []

  for (let i = CONFIG.EMA_PERIOD; i < candles.length; i++) {
    const series = candles.slice(0, i + 1)
    const lastCandle = series[series.length - 1]
    const closes = series.map((c) => c.close)
    const volumes = series.map((c) => c.volume)

    const rsi = calculateRSI(closes, CONFIG.RSI_PERIOD)
    const ema = calculateZLEMA(closes, CONFIG.EMA_PERIOD).slice(-1)[0]
    const macd = getMACD(closes)
    const { fvg, ob } = detectSMC(series)
    const trend: Analysis['trend'] = lastCandle.close > ema ? 'UP' : 'DOWN'
    const score = calculateScores({ rsi, ema, macd, fvg, ob, trend }, lastCandle, CONFIG)
    const volSma = calculateSMA(volumes, CONFIG.VOL_SMA_PERIOD)

    if (position) {
      const isLong = position.type === 'LONG'
      const pnl = isLong
        ? (lastCandle.close - position.entryPrice) * (position.size / position.entryPrice)
        : (position.entryPrice - lastCandle.close) * (position.size / position.entryPrice)

      const hitTp = (isLong && lastCandle.close >= position.tpPrice) || (!isLong && lastCandle.close <= position.tpPrice)
      const hitSl = (isLong && lastCandle.close <= position.slPrice) || (!isLong && lastCandle.close >= position.slPrice)

      if (hitTp || hitSl) {
        const closeFee = position.size * CONFIG.FEE
        const finalPnl = pnl - closeFee - position.openFee
        balance += position.margin + (pnl - closeFee)
        tradePnls.push(finalPnl)
        position = null
      }
    }

    if (position) continue
    if (balance < 10 || volSma === 0 || lastCandle.volume < volSma * CONFIG.VOL_MULTIPLIER) continue

    let signalType: 'LONG' | 'SHORT' | null = null
    if (score >= CONFIG.CONFLUENCE_THRESHOLD && rsi <= 45) signalType = 'LONG'
    if (score <= -CONFIG.CONFLUENCE_THRESHOLD && rsi >= 55) signalType = 'SHORT'

    if (!signalType) continue

    const margin = 50
    const size = margin * CONFIG.LEVERAGE
    const openFee = size * CONFIG.FEE
    const realMargin = margin - openFee

    balance -= margin
    position = {
      type: signalType,
      entryPrice: lastCandle.close,
      margin: realMargin,
      size,
      tpPrice:
        signalType === 'LONG'
          ? lastCandle.close * (1 + CONFIG.TP_PERCENT)
          : lastCandle.close * (1 - CONFIG.TP_PERCENT),
      slPrice:
        signalType === 'LONG'
          ? lastCandle.close * (1 - CONFIG.SL_PERCENT)
          : lastCandle.close * (1 + CONFIG.SL_PERCENT),
      openFee,
    }

    if (balance > peakEquity) peakEquity = balance
    const dd = ((peakEquity - balance) / peakEquity) * 100
    if (dd > maxDrawdownPercent) maxDrawdownPercent = dd
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
