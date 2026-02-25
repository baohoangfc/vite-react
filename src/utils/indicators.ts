import { Candle, Analysis } from '../types';
import { CONFIG } from '../config';

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

export const calculateFullEMA = (prices: number[], period: number) => {
    if (prices.length === 0) return [];
    const k = 2 / (period + 1);
    let emaArr = [prices[0]];
    for (let i = 1; i < prices.length; i++) {
        emaArr.push(prices[i] * k + emaArr[i - 1] * (1 - k));
    }
    return emaArr;
};

export const getMACD = (prices: number[]) => {
    if (prices.length < CONFIG.MACD_SLOW) return { macdLine: 0, signalLine: 0, hist: 0 };
    const fastEma = calculateFullEMA(prices, CONFIG.MACD_FAST);
    const slowEma = calculateFullEMA(prices, CONFIG.MACD_SLOW);
    const macdLineArr = fastEma.map((f, i) => f - slowEma[i]);
    const signalLineArr = calculateFullEMA(macdLineArr, CONFIG.MACD_SIGNAL);

    const macdLine = macdLineArr[macdLineArr.length - 1];
    const signalLine = signalLineArr[signalLineArr.length - 1];
    return { macdLine, signalLine, hist: macdLine - signalLine };
};

export const detectSMC = (candles: Candle[]) => {
    let fvg: 'BULLISH' | 'BEARISH' | null = null;
    let ob: 'BULLISH' | 'BEARISH' | null = null;

    if (candles.length < 5) return { fvg, ob };

    const c1 = candles[candles.length - 4];
    const c3 = candles[candles.length - 2];
    if (c3.low > c1.high) fvg = 'BULLISH';
    else if (c3.high < c1.low) fvg = 'BEARISH';

    const recent = candles.slice(-6, -1);
    for (let i = 0; i < recent.length - 2; i++) {
        if (!recent[i].isGreen && recent[i + 1].isGreen && recent[i + 2].isGreen) ob = 'BULLISH';
        if (recent[i].isGreen && !recent[i + 1].isGreen && !recent[i + 2].isGreen) ob = 'BEARISH';
    }

    return { fvg, ob };
};

export const calculateScores = (analysis: Partial<Analysis>, lastCandle: Candle, config: typeof CONFIG) => {
    let score = 0;
    if (analysis.trend === 'UP') score += 1; else score -= 1;
    if (analysis.macd && analysis.macd.hist > 0) score += 1; else if (analysis.macd && analysis.macd.hist < 0) score -= 1;
    if (analysis.rsi! < config.RSI_OVERSOLD) score += 1; else if (analysis.rsi! > config.RSI_OVERBOUGHT) score -= 1;
    if (analysis.fvg === 'BULLISH') score += 1; else if (analysis.fvg === 'BEARISH') score -= 1;
    if (analysis.ob === 'BULLISH') score += 1; else if (analysis.ob === 'BEARISH') score -= 1;
    return score;
};
