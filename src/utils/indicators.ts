import { Candle, Analysis } from '../types';
import { CONFIG } from '../config';

// Standard Simple Moving Average
export const calculateSMA = (data: number[], period: number) => {
    if (data.length < period) return 0;
    const sum = data.slice(-period).reduce((a, b) => a + b, 0);
    return sum / period;
};

// RSI Calculation
export const calculateRSI = (prices: number[], period: number) => {
    if (prices.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = prices.length - period - 1; i < prices.length - 1; i++) {
        const diff = prices[i + 1] - prices[i];
        if (diff >= 0) gains += diff; else losses -= diff;
    }
    let avgGain = gains / period; let avgLoss = losses / period;
    const currentDiff = prices[prices.length - 1] - prices[prices.length - 2];
    if (currentDiff >= 0) {
        avgGain = (avgGain * (period - 1) + currentDiff) / period; avgLoss = (avgLoss * (period - 1)) / period;
    } else {
        avgGain = (avgGain * (period - 1)) / period; avgLoss = (avgLoss * (period - 1) - currentDiff) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + (avgGain / avgLoss)));
};

// Zero-Lag Exponential Moving Average (ZLEMA) for faster reaction
export const calculateZLEMA = (prices: number[], period: number) => {
    if (prices.length === 0) return [];
    const lag = Math.floor((period - 1) / 2);
    const zlemaData = prices.map((p, i) => {
        if (i < lag) return p;
        return p + (p - prices[i - lag]);
    });

    const k = 2 / (period + 1);
    let emaArr = [zlemaData[0]];
    for (let i = 1; i < zlemaData.length; i++) {
        emaArr.push(zlemaData[i] * k + emaArr[i - 1] * (1 - k));
    }
    return emaArr;
};

// MACD using ZLEMA
export const getMACD = (prices: number[]) => {
    if (prices.length < CONFIG.MACD_SLOW) return { macdLine: 0, signalLine: 0, hist: 0 };
    const fastEma = calculateZLEMA(prices, CONFIG.MACD_FAST);
    const slowEma = calculateZLEMA(prices, CONFIG.MACD_SLOW);
    const macdLineArr = fastEma.map((f, i) => f - slowEma[i]);
    const signalLineArr = calculateZLEMA(macdLineArr, CONFIG.MACD_SIGNAL);

    const macdLine = macdLineArr[macdLineArr.length - 1];
    const signalLine = signalLineArr[signalLineArr.length - 1];
    return { macdLine, signalLine, hist: macdLine - signalLine };
};

// Stricter SMC Detection (requires larger candle body for OB and significant gap for FVG)
export const detectSMC = (candles: Candle[]) => {
    let fvg: 'BULLISH' | 'BEARISH' | null = null;
    let ob: 'BULLISH' | 'BEARISH' | null = null;

    if (candles.length < 5) return { fvg, ob };

    const c1 = candles[candles.length - 4];
    const c3 = candles[candles.length - 2];

    // Strict FVG: Gap must be at least 0.05% of price
    const gapThreshold = c1.close * 0.0005;
    if (c3.low - c1.high > gapThreshold) fvg = 'BULLISH';
    else if (c1.low - c3.high > gapThreshold) fvg = 'BEARISH';

    const recent = candles.slice(-6, -1);
    for (let i = 0; i < recent.length - 2; i++) {
        // Strict OB: Require the 3rd candle to be significantly larger (momentum confirmation)
        const body1 = Math.abs(recent[i].close - recent[i].open);
        const body3 = Math.abs(recent[i + 2].close - recent[i + 2].open);

        if (!recent[i].isGreen && recent[i + 1].isGreen && recent[i + 2].isGreen && body3 > body1 * 1.5) ob = 'BULLISH';
        if (recent[i].isGreen && !recent[i + 1].isGreen && !recent[i + 2].isGreen && body3 > body1 * 1.5) ob = 'BEARISH';
    }

    return { fvg, ob };
};

export const calculateScores = (analysis: Partial<Analysis>, lastCandle: Candle, config: typeof CONFIG) => {
    let score = 0;
    // Structural Indicators carry more weight (+2 or +1)
    if (analysis.trend === 'UP') score += 1; else score -= 1;

    // Momentum
    if (analysis.macd && analysis.macd.hist > 0) score += 1; else if (analysis.macd && analysis.macd.hist < 0) score -= 1;

    // Extreme mean reversion conditions (Oscillators)
    if (analysis.rsi! < config.RSI_OVERSOLD) score += 1;
    else if (analysis.rsi! > config.RSI_OVERBOUGHT) score -= 1;

    // Structural Confluence
    if (analysis.fvg === 'BULLISH') score += 1; else if (analysis.fvg === 'BEARISH') score -= 1;
    if (analysis.ob === 'BULLISH') score += 1; else if (analysis.ob === 'BEARISH') score -= 1;

    return score;
};
