export const CONFIG = {
    SYMBOL: 'BTCUSDT',
    INTERVAL: '1m',
    LIMIT_CANDLES: 100,

    // Chỉ báo kỹ thuật
    RSI_PERIOD: 14,
    EMA_PERIOD: 50,
    MACD_FAST: 12,
    MACD_SLOW: 26,
    MACD_SIGNAL: 9,

    // Logic Tín hiệu
    RSI_OVERSOLD: 35,
    RSI_OVERBOUGHT: 65,
    VOL_MULTIPLIER: 1.2,
    CONFLUENCE_THRESHOLD: 4, // Yêu cầu ít nhất 4/5 tín hiệu đồng thuận (Mới)

    // Quản lý vốn & Cloud
    LEVERAGE: 50,
    INITIAL_BALANCE: 10000,
    TP_PERCENT: 0.008,
    SL_PERCENT: 0.004,
    FEE: 0.0004,
    REFRESH_RATE: 2000,
    LOG_INTERVAL_MS: 60000,
    HEARTBEAT_MS: 10 * 60 * 1000, // 10 phút báo cáo Telegram
    COOLDOWN_MS: 60 * 1000,
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
