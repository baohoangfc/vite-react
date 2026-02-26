export const CONFIG = {
    SYMBOL: 'BTCUSDT',
    INTERVAL: '1m',
    LIMIT_CANDLES: 2000,

    // Chỉ báo kỹ thuật
    RSI_PERIOD: 14,
    EMA_PERIOD: 50,
    MACD_FAST: 12,
    MACD_SLOW: 26,
    MACD_SIGNAL: 9,

    // Logic Tín hiệu
    RSI_OVERSOLD: 30,
    RSI_OVERBOUGHT: 70,
    RSI_OVERBOUGHT_OVERSOLD: {
        oversold: 30,
        overbought: 70,
        neutral_low: 45,
        neutral_high: 55,
    },
    VOL_MULTIPLIER: 1.2,
    VOL_SMA_PERIOD: 20, // Đường SMA 20 cho Volume Filter
    CONFLUENCE_THRESHOLD: 4,

    // Quản lý vốn & Cloud
    LEVERAGE: 50,
    INITIAL_BALANCE: 1000,
    TP_PERCENT: 0.008,
    SL_PERCENT: 0.004,
    FEE: 0.0004,
    REFRESH_RATE: 2000,
    LOG_INTERVAL_MS: 60000,
    HEARTBEAT_MS: 10 * 60 * 1000, // 10 phút báo cáo Telegram
    COOLDOWN_MS: 60 * 1000,
    ALERT_DRAWDOWN_PERCENT: 5,
    ALERT_DAILY_SUMMARY_MS: 24 * 60 * 60 * 1000,
    API_URL: import.meta.env.VITE_API_URL || 'https://exus-bot-backend.onrender.com',
};

export const getSafeAppId = () => {
    try {
        // @ts-ignore
        if (typeof __app_id !== 'undefined' && __app_id) return String(__app_id).replace(/[^a-zA-Z0-9]/g, '_');
    } catch (e) { }
    return 'trading-bot-v4-cyberpro';
};

export const APP_ID = getSafeAppId();

export const DEFAULT_FIREBASE_CONFIG = {
    apiKey: "AIzaSyA2qyyzovcbtdEZk_SIvOpvLvIkwaIFhYY",
    authDomain: "telebot-557dc.firebaseapp.com",
    projectId: "telebot-557dc",
    storageBucket: "telebot-557dc.firebasestorage.app",
    messagingSenderId: "325760523176",
    appId: "1:325760523176:web:3854a7f29bd17f173ddb9d"
};
