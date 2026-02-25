
export interface Candle {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    isGreen: boolean;
}

export interface Analysis {
    rsi: number;
    ema: number;
    macd: { macdLine: number; signalLine: number; hist: number };
    volSma: number;
    fvg: 'BULLISH' | 'BEARISH' | null;
    ob: 'BULLISH' | 'BEARISH' | null;
    trend: 'UP' | 'DOWN';
    score: number;
}

export interface TradeHistoryItem {
    id: string;
    type: 'LONG' | 'SHORT';
    entryPrice: number;
    exitPrice: number;
    pnl: number;
    pnlPercent: number;
    reason: string;
    time: number;
    signalDetail?: any;
}

export interface Account {
    balance: number;
    pnlHistory: number;
}

export interface Position {
    type: 'LONG' | 'SHORT';
    entryPrice: number;
    margin: number;
    size: number;
    tpPrice: number;
    slPrice: number;
    liquidationPrice: number;
    openFee: number;
    openTime: number;
    signalDetail?: any;
}

export interface TelegramConfig {
    token: string;
    chatId: string;
}

export interface MTFSentiment {
    '1m': 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    '5m': 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    '15m': 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    '1h': 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    '4h': 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    '1d': 'BULLISH' | 'BEARISH' | 'NEUTRAL';
}
