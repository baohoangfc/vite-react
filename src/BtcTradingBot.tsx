import { useState, useEffect, useRef } from 'react';
import { onAuthStateChanged, signOut, User } from 'firebase/auth';
import { doc, setDoc, onSnapshot, collection } from 'firebase/firestore';
import {
  Crosshair, Settings, Layers,
  Terminal, History, Activity
} from 'lucide-react';

// Modules
import { auth, db, isFirebaseConfigured } from './firebase';
import { CONFIG, APP_ID } from './config';
import {
  Candle, Analysis, TradeHistoryItem, Account,
  Position, TelegramConfig, MTFSentiment
} from './types';
import {
  calculateRSI, calculateZLEMA, getMACD,
  detectSMC, calculateScores, calculateSMA
} from './utils/indicators';

// Components
import SetupScreen from './components/SetupScreen';
import AuthScreen from './components/AuthScreen';
import MarketRadar from './components/Dashboard/MarketRadar';
import WalletManager from './components/Dashboard/WalletManager';
import ActivePosition from './components/Dashboard/ActivePosition';
import DailyAggregation from './components/Dashboard/DailyAggregation';
import SentimentIndicators from './components/Dashboard/SentimentIndicators';
import { BacktestResult, runBacktest } from './utils/backtest';

type BacktestSuggestion = {
  level: 'good' | 'warning' | 'info'
  text: string
};

type TrendBias = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
type TradeSide = 'LONG' | 'SHORT';
type SMCOrderBlock = { low: number; high: number; midpoint: number };
type PendingSetup = {
  side: TradeSide;
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  rr: number;
  createdAt: number;
};

type ScalpConfig = {
  margin: number;
  leverage: number;
  tpPercent: number;
  slPercent: number;
};

type ScalpPlan = {
  bias: TradeSide | 'WAIT';
  setup: string;
  leverage: number;
  tpPercent: number;
  slPercent: number;
  hasTrapRisk: boolean;
  trapReason?: string;
  confidence: number;
  confirmations: string[];
};

type BacktestInterval = '1m' | '5m' | '15m' | '1h' | '4h';

const BACKTEST_INTERVAL_OPTIONS: BacktestInterval[] = ['1m', '5m', '15m', '1h', '4h'];

const RISK_PER_TRADE = 0.01;
const DAILY_LOSS_LIMIT = 0.03;
const RR_TARGET = 3;
const ATR_PERIOD = 14;
const HTF_MINUTES = 240;
const LTF_MINUTES = 15;
const SWEEP_LOOKBACK = 20;
const BOS_LOOKBACK = 8;
const EQUAL_TOLERANCE_BPS = 0.0008;
const SCALP_COOLDOWN_MS = 90_000;
const DEFAULT_SCALP_MARGIN = 50;
const BINANCE_GOLD_PROXY_SYMBOL = 'PAXGUSDT';

const isGoldSymbol = (symbol: string) => symbol.toUpperCase().includes('XAU');

const fetchBinanceGoldCandles = async (interval: string, limit: number, startTimeMs?: number, endTimeMs?: number): Promise<Candle[]> => {
  const query = new URLSearchParams({ symbol: BINANCE_GOLD_PROXY_SYMBOL, interval, limit: String(Math.min(limit, 1000)) });
  if (startTimeMs) query.set('startTime', String(startTimeMs));
  if (endTimeMs) query.set('endTime', String(endTimeMs));

  const res = await fetch(`https://api.binance.com/api/v3/klines?${query.toString()}`);
  if (!res.ok) throw new Error(`Binance ${BINANCE_GOLD_PROXY_SYMBOL} lỗi (${res.status})`);
  const data = await res.json();
  if (!Array.isArray(data)) return [];

  return data.map((k: any) => ({
    time: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5] ?? 0),
    isGreen: Number(k[4]) >= Number(k[1]),
  })).filter((c: Candle) => Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close));
};

const fetchBingxGoldCandles = async (interval: string, limit: number): Promise<Candle[]> => {
  const query = new URLSearchParams({ symbol: 'XAU-USDT', interval, limit: String(Math.min(limit, 1000)) });
  const res = await fetch(`https://open-api.bingx.com/openApi/swap/v3/quote/klines?${query.toString()}`);
  if (!res.ok) throw new Error(`BingX XAU-USDT lỗi (${res.status})`);
  const data = await res.json();
  const rows = data?.data?.data || data?.data || [];
  if (!Array.isArray(rows)) return [];

  return rows.map((k: any) => {
    const open = Number(k.open ?? k.o ?? k[1]);
    const high = Number(k.high ?? k.h ?? k[2]);
    const low = Number(k.low ?? k.l ?? k[3]);
    const close = Number(k.close ?? k.c ?? k[4]);
    const volume = Number(k.volume ?? k.v ?? k[5] ?? 0);
    const t = Number(k.time ?? k.t ?? k[0]);
    const time = t < 1_000_000_000_000 ? t * 1000 : t;
    return { time, open, high, low, close, volume, isGreen: close >= open };
  }).filter((c: Candle) => Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close));
};

const fetchGoldCandlesViaApi = async (interval: string, limit: number, startTimeMs?: number, endTimeMs?: number): Promise<Candle[]> => {
  const query = new URLSearchParams({ interval, limit: String(limit) });
  if (startTimeMs) query.set('startTime', String(startTimeMs));
  if (endTimeMs) query.set('endTime', String(endTimeMs));

  const endpoints = ['/api/xau/candles', `${CONFIG.API_URL}/api/xau/candles`];
  const tried = new Set<string>();

  for (const endpoint of endpoints) {
    if (!endpoint || tried.has(endpoint)) continue;
    tried.add(endpoint);

    try {
      const res = await fetch(`${endpoint}?${query.toString()}`);
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data?.candles) && data.candles.length > 0) {
        return data.candles as Candle[];
      }
    } catch (_error) {
      // thử endpoint tiếp theo
    }
  }

  return [];
};

const fetchMarketCandles = async (symbol: string, interval: string, limit: number, startTimeMs?: number, endTimeMs?: number): Promise<Candle[]> => {
  if (isGoldSymbol(symbol)) {
    const apiCandles = await fetchGoldCandlesViaApi(interval, limit, startTimeMs, endTimeMs);
    if (apiCandles.length > 0) return apiCandles;

    try {
      const binanceCandles = await fetchBinanceGoldCandles(interval, limit, startTimeMs, endTimeMs);
      if (binanceCandles.length > 0) return binanceCandles;
    } catch (_error) { }

    return fetchBingxGoldCandles(interval, limit);
  }

  const query = new URLSearchParams({ symbol, interval, limit: String(limit) });
  if (startTimeMs) query.set('startTime', String(startTimeMs));
  if (endTimeMs) query.set('endTime', String(endTimeMs));

  const res = await fetch(`https://api.binance.com/api/v3/klines?${query.toString()}`);
  if (!res.ok) throw new Error(`Không tải được dữ liệu nến (${res.status})`);
  const data = await res.json();

  return data.map((k: any) => ({
    time: Number(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    isGreen: parseFloat(k[4]) >= parseFloat(k[1]),
  }));
};

const buildScalpPlan = (candles: Candle[]): ScalpPlan => {
  if (candles.length < 120) {
    return {
      bias: 'WAIT',
      setup: 'CHỜ ĐỦ DỮ LIỆU SMC',
      leverage: 5,
      tpPercent: 0.8,
      slPercent: 0.45,
      hasTrapRisk: false,
      confidence: 0,
      confirmations: [],
    };
  }

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const last = candles[candles.length - 1];
  const emaSeries = calculateZLEMA(closes, CONFIG.EMA_PERIOD);
  const ema = emaSeries[emaSeries.length - 1];
  const volSma = calculateSMA(volumes, 20);
  const atrSeries = calculateATR(candles, ATR_PERIOD);
  const atr = atrSeries[atrSeries.length - 1] || 0;
  const htfTrend = getHtfTrendBias(aggregateCandles(candles, LTF_MINUTES));
  const sweep = getLiquiditySweep(candles, candles.length - 1, atr);
  const smc = detectSMC(candles);
  const rsi = calculateRSI(closes, CONFIG.RSI_PERIOD);
  const macd = getMACD(closes);

  const recentHigh = Math.max(...closes.slice(-10));
  const recentLow = Math.min(...closes.slice(-10));
  const volumeWeak = Boolean(volSma) && last.volume < volSma * 1.1;
  const breakoutWithoutVolume = last.close > recentHigh && volumeWeak;
  const breakdownWithoutVolume = last.close < recentLow && volumeWeak;
  const trapReason = breakoutWithoutVolume
    ? 'Giá quét đỉnh nhưng volume thấp, ưu tiên chờ retest rõ hơn.'
    : breakdownWithoutVolume
      ? 'Giá quét đáy nhưng volume thấp, ưu tiên chờ retest rõ hơn.'
      : undefined;

  if (!ema || !volSma || !atr || volumeWeak) {
    return {
      bias: 'WAIT',
      setup: 'ĐỨNG NGOÀI - THANH KHOẢN YẾU',
      leverage: 5,
      tpPercent: 0.8,
      slPercent: 0.45,
      hasTrapRisk: Boolean(trapReason),
      trapReason,
      confidence: 20,
      confirmations: ['Volume dưới chuẩn'],
    };
  }

  const longOb = findOrderBlock(candles, candles.length - 1, 'LONG');
  const shortOb = findOrderBlock(candles, candles.length - 1, 'SHORT');
  const nearLongOb = longOb ? last.close <= longOb.high + atr * 0.15 && last.close >= longOb.low - atr * 0.15 : false;
  const nearShortOb = shortOb ? last.close >= shortOb.low - atr * 0.15 && last.close <= shortOb.high + atr * 0.15 : false;

  const longChecks = [
    { ok: htfTrend === 'BULLISH', text: 'HTF bullish' },
    { ok: sweep?.side === 'LONG', text: 'Liquidity sweep đáy' },
    { ok: smc.ob === 'BULLISH', text: 'Bullish OB' },
    { ok: smc.fvg === 'BULLISH', text: 'Bullish FVG' },
    { ok: nearLongOb, text: 'Retest vùng OB' },
    { ok: last.close > ema, text: 'Giá trên EMA' },
    { ok: rsi >= 50, text: 'RSI > 50' },
    { ok: macd.hist > 0, text: 'MACD histogram dương' },
  ];
  const shortChecks = [
    { ok: htfTrend === 'BEARISH', text: 'HTF bearish' },
    { ok: sweep?.side === 'SHORT', text: 'Liquidity sweep đỉnh' },
    { ok: smc.ob === 'BEARISH', text: 'Bearish OB' },
    { ok: smc.fvg === 'BEARISH', text: 'Bearish FVG' },
    { ok: nearShortOb, text: 'Retest vùng OB' },
    { ok: last.close < ema, text: 'Giá dưới EMA' },
    { ok: rsi <= 50, text: 'RSI < 50' },
    { ok: macd.hist < 0, text: 'MACD histogram âm' },
  ];

  const longScore = longChecks.filter((c) => c.ok).length;
  const shortScore = shortChecks.filter((c) => c.ok).length;
  const longMandatory = htfTrend === 'BULLISH' && (sweep?.side === 'LONG' || nearLongOb) && (smc.ob === 'BULLISH' || smc.fvg === 'BULLISH');
  const shortMandatory = htfTrend === 'BEARISH' && (sweep?.side === 'SHORT' || nearShortOb) && (smc.ob === 'BEARISH' || smc.fvg === 'BEARISH');

  if (longMandatory && longScore >= 6 && longScore >= shortScore) {
    return {
      bias: 'LONG',
      setup: 'SMC LONG xác nhận cao',
      leverage: 7,
      tpPercent: 0.9,
      slPercent: 0.45,
      hasTrapRisk: Boolean(trapReason),
      trapReason,
      confidence: Math.min(95, longScore * 12),
      confirmations: longChecks.filter((c) => c.ok).map((c) => c.text),
    };
  }

  if (shortMandatory && shortScore >= 6 && shortScore > longScore) {
    return {
      bias: 'SHORT',
      setup: 'SMC SHORT xác nhận cao',
      leverage: 7,
      tpPercent: 0.9,
      slPercent: 0.45,
      hasTrapRisk: Boolean(trapReason),
      trapReason,
      confidence: Math.min(95, shortScore * 12),
      confirmations: shortChecks.filter((c) => c.ok).map((c) => c.text),
    };
  }

  return {
    bias: 'WAIT',
    setup: 'SMC CHƯA ĐỦ ĐỒNG THUẬN (>=6 điều kiện)',
    leverage: 6,
    tpPercent: 0.8,
    slPercent: 0.45,
    hasTrapRisk: false,
    confidence: Math.max(longScore, shortScore) * 10,
    confirmations: [],
  };
};

const aggregateCandles = (candles: Candle[], intervalMinutes: number): Candle[] => {
  if (!candles.length) return [];
  const bucketMs = intervalMinutes * 60 * 1000;
  const buckets = new Map<number, Candle[]>();

  candles.forEach((candle) => {
    const bucket = Math.floor(candle.time / bucketMs) * bucketMs;
    const items = buckets.get(bucket) || [];
    items.push(candle);
    buckets.set(bucket, items);
  });

  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([time, items]) => {
    const open = items[0].open;
    const close = items[items.length - 1].close;
    return {
      time,
      open,
      close,
      high: Math.max(...items.map((c) => c.high)),
      low: Math.min(...items.map((c) => c.low)),
      volume: items.reduce((sum, c) => sum + c.volume, 0),
      isGreen: close >= open,
    };
  });
};

const calculateEMA = (values: number[], period: number): number[] => {
  if (!values.length) return [];
  const alpha = 2 / (period + 1);
  const ema = [values[0]];
  for (let i = 1; i < values.length; i++) ema.push(values[i] * alpha + ema[i - 1] * (1 - alpha));
  return ema;
};

const calculateATR = (candles: Candle[], period: number): number[] => {
  if (!candles.length) return [];
  const tr = [candles[0].high - candles[0].low];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose)));
  }
  const atr: number[] = [];
  for (let i = 0; i < tr.length; i++) {
    if (i < period - 1) atr.push(tr[i]);
    else if (i === period - 1) atr.push(tr.slice(0, period).reduce((a, b) => a + b, 0) / period);
    else atr.push((atr[i - 1] * (period - 1) + tr[i]) / period);
  }
  return atr;
};

const getHtfTrendBias = (candles: Candle[]): TrendBias => {
  if (candles.length < 4) return 'NEUTRAL';
  const closes = candles.map((c) => c.close);
  const ema200 = calculateEMA(closes, 200);
  const last = candles[candles.length - 1];
  const prev1 = candles[candles.length - 2];
  const prev2 = candles[candles.length - 3];

  const bullishStructure = last.high > prev1.high && prev1.high > prev2.high && last.low > prev1.low;
  const bearishStructure = last.low < prev1.low && prev1.low < prev2.low && last.high < prev1.high;

  const lastEma = ema200[ema200.length - 1] ?? last.close;
  if (bullishStructure || last.close > lastEma) return 'BULLISH';
  if (bearishStructure || last.close < lastEma) return 'BEARISH';
  return 'NEUTRAL';
};

const getLiquiditySweep = (candles: Candle[], index: number, atr: number): { side: TradeSide } | null => {
  if (index < SWEEP_LOOKBACK) return null;
  const current = candles[index];
  const lookback = candles.slice(index - SWEEP_LOOKBACK, index);
  const highPool = Math.max(...lookback.map((c) => c.high));
  const lowPool = Math.min(...lookback.map((c) => c.low));
  const tolerance = Math.max(atr * 0.2, current.close * EQUAL_TOLERANCE_BPS);

  const equalHighCount = lookback.filter((c) => Math.abs(c.high - highPool) <= tolerance).length;
  if (equalHighCount >= 2 && current.high > highPool + tolerance && current.close < highPool) return { side: 'SHORT' };

  const equalLowCount = lookback.filter((c) => Math.abs(c.low - lowPool) <= tolerance).length;
  if (equalLowCount >= 2 && current.low < lowPool - tolerance && current.close > lowPool) return { side: 'LONG' };

  return null;
};

const findOrderBlock = (candles: Candle[], index: number, side: TradeSide): SMCOrderBlock | null => {
  if (index < BOS_LOOKBACK + 2) return null;
  const current = candles[index];
  const recent = candles.slice(index - BOS_LOOKBACK, index);

  if (side === 'LONG') {
    const swingHigh = Math.max(...recent.map((c) => c.high));
    if (current.close <= swingHigh) return null;
    for (let i = index - 1; i >= index - BOS_LOOKBACK; i--) {
      const c = candles[i];
      if (c.close < c.open) {
        const low = Math.min(c.open, c.close);
        const high = Math.max(c.open, c.close);
        return { low, high, midpoint: (low + high) / 2 };
      }
    }
  }

  const swingLow = Math.min(...recent.map((c) => c.low));
  if (current.close >= swingLow) return null;
  for (let i = index - 1; i >= index - BOS_LOOKBACK; i--) {
    const c = candles[i];
    if (c.close > c.open) {
      const low = Math.min(c.open, c.close);
      const high = Math.max(c.open, c.close);
      return { low, high, midpoint: (low + high) / 2 };
    }
  }

  return null;
};

const isAllowedTradingHourUtc = (timestampMs: number): boolean => {
  const hour = new Date(timestampMs).getUTCHours();
  return (hour >= 13 && hour < 17) || (hour >= 20 && hour < 24);
};

const getBacktestSuggestions = (result: BacktestResult): BacktestSuggestion[] => {
  const suggestions: BacktestSuggestion[] = [];

  if (result.totalTrades < 5) {
    suggestions.push({
      level: 'warning',
      text: 'Số lệnh quá ít, hãy tăng số ngày backtest để dữ liệu đáng tin hơn.',
    });
  }

  if (result.winRate < 40) {
    suggestions.push({
      level: 'warning',
      text: 'Win rate thấp: cân nhắc siết điều kiện vào lệnh hoặc giảm đòn bẩy.',
    });
  } else if (result.winRate > 60) {
    suggestions.push({
      level: 'good',
      text: 'Win rate đang tốt, có thể forward-test trên tài khoản demo trước khi tăng vốn.',
    });
  }

  if (result.maxDrawdownPercent > 15) {
    suggestions.push({
      level: 'warning',
      text: 'Max drawdown cao, nên giảm risk mỗi lệnh và bổ sung cơ chế dừng giao dịch theo ngày.',
    });
  }

  if (result.expectancy <= 0) {
    suggestions.push({
      level: 'warning',
      text: 'Expectancy chưa dương, chiến lược chưa có lợi thế rõ ràng.',
    });
  } else {
    suggestions.push({
      level: 'good',
      text: 'Expectancy dương, chiến lược có lợi thế thống kê trong giai đoạn đã test.',
    });
  }

  if (suggestions.length === 0) {
    suggestions.push({
      level: 'info',
      text: 'Kết quả ổn định. Bạn có thể test thêm theo từng tháng để kiểm tra độ bền chiến lược.',
    });
  }

  return suggestions.slice(0, 3);
};

export default function GoldXauTradingBot() {
  if (!isFirebaseConfigured) return <SetupScreen />;

  const [user, setUser] = useState<User | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [currentPrice, setCurrentPrice] = useState<number>(0);
  const [analysis, setAnalysis] = useState<Analysis>({
    rsi: 50, ema: 0, macd: { macdLine: 0, signalLine: 0, hist: 0 },
    volSma: 0, fvg: null, ob: null, trend: 'UP', score: 0
  });

  const [sentiment, setSentiment] = useState<MTFSentiment>({
    '1m': 'NEUTRAL', '5m': 'NEUTRAL', '15m': 'NEUTRAL',
    '1h': 'NEUTRAL', '4h': 'NEUTRAL', '1d': 'NEUTRAL'
  });

  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<{ msg: string, type: string }[]>([]);
  const [activeTab, setActiveTab] = useState<'LOGS' | 'HISTORY' | 'DAILY'>('LOGS');
  const [showSettings, setShowSettings] = useState(false);
  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(null);
  const [backtestLoading, setBacktestLoading] = useState(false);
  const [backtestDate, setBacktestDate] = useState(() => new Date().toISOString().split('T')[0]);
  const [backtestDays, setBacktestDays] = useState(3);
  const [backtestInterval, setBacktestInterval] = useState<BacktestInterval>('15m');
  const [runtimeOnline, setRuntimeOnline] = useState(false);
  const [scalpConfig, setScalpConfig] = useState<ScalpConfig>({ margin: DEFAULT_SCALP_MARGIN, leverage: 8, tpPercent: 1, slPercent: 0.5 });
  const [scalpAutoEnabled, setScalpAutoEnabled] = useState(true);
  const [scalpPosition, setScalpPosition] = useState<Position | null>(null);
  const [scalpHistory, setScalpHistory] = useState<TradeHistoryItem[]>([]);
  const [scalpBalance, setScalpBalance] = useState<number>(300); // Mặc định 300 USDT cho scalp
  const [scalpPlan, setScalpPlan] = useState<ScalpPlan>(() => buildScalpPlan([]));

  // Trading State (Cloud Synced)
  const [account, setAccount] = useState<Account>({ balance: CONFIG.INITIAL_BALANCE, pnlHistory: 0 });
  const [position, setPosition] = useState<Position | null>(null);
  const [history, setHistory] = useState<TradeHistoryItem[]>([]);
  const [tgConfig, setTgConfig] = useState<TelegramConfig>({ token: '', chatId: '' });

  // Refs for Safe Callbacks
  const logsEndRef = useRef<HTMLDivElement>(null);
  const lastAnalysisLogTime = useRef<number>(0);
  const isProcessingRef = useRef<boolean>(false);
  const lastTradeTimeRef = useRef<number>(0);
  const tgConfigRef = useRef(tgConfig);
  const latestPriceRef = useRef(currentPrice);
  const latestAccountRef = useRef(account);
  const positionRef = useRef(position);
  const candlesRef = useRef(candles); // Added for processAndSetData
  const sentimentRef = useRef(sentiment); // Added for processAndSetData
  const isTradingActive = useRef(isRunning); // Added for processAndSetData
  const drawdownAlertSentRef = useRef(false);
  const lastDailySummaryRef = useRef(0);
  const pendingSetupRef = useRef<PendingSetup | null>(null);
  const dayTrackerRef = useRef<{ dayKey: string; startBalance: number; realizedPnl: number }>({ dayKey: '', startBalance: 0, realizedPnl: 0 });
  const scalpPositionRef = useRef<Position | null>(null);
  const lastScalpSignalRef = useRef(0);
  const lastScalpGuardLogRef = useRef(0);
  const shouldRunLocalBot = false; // FE chỉ hiển thị; bot chạy nền hoàn toàn ở backend.

  // Sync refs
  useEffect(() => { tgConfigRef.current = tgConfig; }, [tgConfig]);
  useEffect(() => { latestPriceRef.current = currentPrice; }, [currentPrice]);
  useEffect(() => { latestAccountRef.current = account; }, [account]);
  useEffect(() => { positionRef.current = position; }, [position]);
  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs, activeTab]);
  useEffect(() => { candlesRef.current = candles; }, [candles]); // Added
  useEffect(() => { sentimentRef.current = sentiment; }, [sentiment]); // Added
  useEffect(() => {
    setScalpPlan(buildScalpPlan(candles));
  }, [candles]);
  useEffect(() => {
    setScalpConfig((prev) => {
      if (prev.margin === DEFAULT_SCALP_MARGIN && prev.leverage === scalpPlan.leverage && prev.tpPercent === scalpPlan.tpPercent && prev.slPercent === scalpPlan.slPercent) {
        return prev;
      }
      return {
        margin: DEFAULT_SCALP_MARGIN,
        leverage: scalpPlan.leverage,
        tpPercent: scalpPlan.tpPercent,
        slPercent: scalpPlan.slPercent,
      };
    });
  }, [scalpPlan]);
  useEffect(() => {
    isTradingActive.current = isRunning && !runtimeOnline;
  }, [isRunning, runtimeOnline]); // Added
  useEffect(() => { scalpPositionRef.current = scalpPosition; }, [scalpPosition]);

  // Auth Init
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => { setUser(u); setLoadingAuth(false); });
    return () => unsub();
  }, []);

  // Database Sync
  useEffect(() => {
    if (!user) return;
    const userRef = doc(db, 'artifacts', APP_ID, 'users', user.uid, 'account', 'data');
    const posRef = doc(db, 'artifacts', APP_ID, 'users', user.uid, 'position', 'active');
    const histCol = collection(db, 'artifacts', APP_ID, 'users', user.uid, 'history');
    const runtimeRef = doc(db, 'artifacts', APP_ID, 'users', user.uid, 'runtime', 'state');
    const scalpPosRef = doc(db, 'artifacts', APP_ID, 'users', user.uid, 'scalpPosition', 'active');
    const scalpHistCol = collection(db, 'artifacts', APP_ID, 'users', user.uid, 'scalpHistory');

    const unsubAcc = onSnapshot(userRef, (d) => {
      if (d.exists()) {
        const data = d.data();
        if (Number(data.balance) === 10000 && Number(data.pnlHistory) === 0) {
          setDoc(userRef, { balance: 1000, scalpBalance: 300, pnlHistory: 0, tgToken: data.tgToken || '', tgChatId: data.tgChatId || '' });
        } else {
          setAccount({ balance: Number(data.balance) || 0, pnlHistory: Number(data.pnlHistory) || 0 });
          setScalpBalance(Number(data.scalpBalance) || 300);
          setTgConfig({ token: String(data.tgToken || ''), chatId: String(data.tgChatId || '') });
        }
      } else {
        setDoc(userRef, { balance: CONFIG.INITIAL_BALANCE, scalpBalance: 300, pnlHistory: 0 });
        setScalpBalance(300);
      }
    });

    const unsubPos = onSnapshot(posRef, (d) => {
      isProcessingRef.current = false;
      if (d.exists() && d.data().active && d.data().details) setPosition(d.data().details);
      else setPosition(null);
    });

    const unsubHist = onSnapshot(histCol, (s) => {
      const list: any[] = [];
      s.forEach(docSnap => list.push(docSnap.data()));
      setHistory(list.sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0)));
    });

    const unsubRuntime = onSnapshot(runtimeRef, (d) => {
      if (!d.exists()) {
        setDoc(runtimeRef, { isRunning: false }, { merge: true });
        return;
      }

      const remoteRunning = Boolean(d.data().isRunning);
      setIsRunning((prev) => (prev === remoteRunning ? prev : remoteRunning));
    });

    const unsubScalpPos = onSnapshot(scalpPosRef, (d) => {
      if (d.exists() && d.data().active && d.data().details) setScalpPosition(d.data().details);
      else setScalpPosition(null);
    });

    const unsubScalpHist = onSnapshot(scalpHistCol, (s) => {
      const list: any[] = [];
      s.forEach(docSnap => list.push(docSnap.data()));
      setScalpHistory(list.sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0)));
    });

    return () => { unsubAcc(); unsubPos(); unsubHist(); unsubRuntime(); unsubScalpPos(); unsubScalpHist(); };
  }, [user]);

  const addLog = (message: string, type: 'info' | 'success' | 'danger' | 'warning' | 'analysis' = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [...prev.slice(-99), { msg: `[${timestamp}] ${message}`, type }]);
  };

  const syncTelegramToRuntime = async (token: string, chatId: string) => {
    if (!runtimeOnline) return;

    await fetch(`${CONFIG.API_URL}/api/runtime`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        isRunning,
        token,
        chatId,
        symbol: CONFIG.SYMBOL,
        heartbeatMs: CONFIG.HEARTBEAT_MS,
        uid: user?.uid,
        appId: APP_ID,
      }),
    });
  };

  const sendTelegram = async (text: string) => {
    const { token, chatId } = tgConfigRef.current;
    if (!token || !chatId) return;
    try { await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }) }); } catch (e) { }
  };


  const fetchHistoricalCandles = async (endTimeMs: number, days: number, interval: BacktestInterval) => {
    const dayMs = 24 * 60 * 60 * 1000;
    const startTimeMs = Math.max(0, endTimeMs - days * dayMs);
    const allCandles: Candle[] = [];
    let cursor = startTimeMs;

    while (cursor < endTimeMs) {
      const formattedCandles = await fetchMarketCandles(CONFIG.SYMBOL, interval, 1000, cursor, endTimeMs);
      if (!formattedCandles.length) break;

      allCandles.push(...formattedCandles);

      const lastOpenTime = formattedCandles[formattedCandles.length - 1]?.time;
      if (!Number.isFinite(lastOpenTime) || formattedCandles.length < 1000) break;
      cursor = lastOpenTime + 1;
    }

    return allCandles
      .filter((candle) => candle.time >= startTimeMs && candle.time <= endTimeMs)
      .sort((a, b) => a.time - b.time);
  };

  const runQuickBacktest = async () => {
    setBacktestLoading(true);
    try {
      const safeDays = Math.min(30, Math.max(1, Math.floor(backtestDays)));
      const targetDay = new Date(`${backtestDate}T23:59:59.999Z`);
      const endTimeMs = Number.isFinite(targetDay.getTime()) ? targetDay.getTime() : Date.now();
      const candlesForBacktest = await fetchHistoricalCandles(endTimeMs, safeDays, backtestInterval);

      if (candlesForBacktest.length <= CONFIG.EMA_PERIOD) {
        throw new Error('Không đủ nến để chạy backtest, hãy tăng số ngày.');
      }

      const result = runBacktest(candlesForBacktest);
      setBacktestResult(result);
      addLog(`Backtest ${backtestInterval} • ${safeDays} ngày đến ${backtestDate}: ${result.totalTrades} lệnh, WR ${result.winRate.toFixed(1)}%, PnL ${result.netPnl.toFixed(2)} USDT`, 'info');
    } catch (error: any) {
      addLog(`Lỗi backtest: ${error?.message || 'Không thể tải dữ liệu'}`, 'danger');
    } finally {
      setBacktestLoading(false);
    }
  };

  // Telegram Heartbeat
  useEffect(() => {
    if (!shouldRunLocalBot || !user) return;
    sendTelegram(`🟢 <b>HỆ THỐNG ĐÃ KHỞI ĐỘNG</b>\n• Cặp: XAUUSD\n• Chu kỳ báo cáo: 10 phút/lần`);

    const heartbeat = setInterval(() => {
      const activeText = positionRef.current ? `Giữ ${positionRef.current.type} x${CONFIG.LEVERAGE}` : 'Đang rình mồi';
      const msg = `💓 <b>TRẠNG THÁI CYBER-PRO BOT</b>\n• Giá: ${latestPriceRef.current.toLocaleString()} USD\n• Ví: ${latestAccountRef.current.balance.toFixed(2)} USDT\n• Lệnh: ${activeText}\n• Tình trạng: 🟢 Hoạt động mượt mà`;
      sendTelegram(msg);
      addLog("Gửi trạng thái an toàn về Telegram (Heartbeat).", "info");
    }, CONFIG.HEARTBEAT_MS);

    return () => {
      clearInterval(heartbeat);
      sendTelegram(`🔴 <b>HỆ THỐNG ĐÃ DỪNG</b>\n• Bot đã ngừng quét thị trường.`);
    };
  }, [shouldRunLocalBot, user]);

  useEffect(() => {
    const syncInitialRuntime = async () => {
      try {
        const response = await fetch(`${CONFIG.API_URL}/api/runtime`);
        if (!response.ok) return;
        const data = await response.json();
        setRuntimeOnline(Boolean(data.background));
        if (typeof data.isRunning === 'boolean') {
          setIsRunning(data.isRunning);
        }
      } catch (error) {
        setRuntimeOnline(false);
      }
    };

    syncInitialRuntime();
  }, [user]);

  useEffect(() => {
    if (!runtimeOnline) return;

    const pullRuntimeState = async () => {
      try {
        const response = await fetch(`${CONFIG.API_URL}/api/runtime`);
        if (!response.ok) return;
        const data = await response.json();

        if (typeof data.isRunning === 'boolean') {
          setIsRunning(data.isRunning);
        }
        if (typeof data.balance === 'number' || typeof data.pnlHistory === 'number') {
          setAccount((prev) => ({
            balance: typeof data.balance === 'number' ? data.balance : prev.balance,
            pnlHistory: typeof data.pnlHistory === 'number' ? data.pnlHistory : prev.pnlHistory,
          }));
        }

        if (data.position && typeof data.position === 'object') {
          const runtimePosition = {
            type: data.position.type,
            entryPrice: Number(data.position.entryPrice || 0),
            margin: Number(data.position.margin || 0),
            size: Number(data.position.size || 0),
            tpPrice: Number(data.position.tpPrice || 0),
            slPrice: Number(data.position.slPrice || 0),
            liquidationPrice: Number(data.position.liquidationPrice || 0),
            openFee: Number(data.position.openFee || 0),
            openTime: Number(data.position.openTime || Date.now()),
            signalDetail: data.position.signalDetail || null,
          } as Position;
          setPosition(runtimePosition);
          if (user) void syncRuntimePositionState(runtimePosition);
        } else {
          setPosition(null);
          if (user) void syncRuntimePositionState(null);
        }
      } catch (error) {
        // ignore polling errors while backend warms up
      }
    };

    pullRuntimeState();
    const runtimePoll = setInterval(pullRuntimeState, 5000);
    return () => clearInterval(runtimePoll);
  }, [runtimeOnline, user]);

  useEffect(() => {
    if (!shouldRunLocalBot) {
      drawdownAlertSentRef.current = false;
      return;
    }

    const floatingPnl = position ? (position.type === 'LONG' ? (currentPrice - position.entryPrice) * (position.size / position.entryPrice) : (position.entryPrice - currentPrice) * (position.size / position.entryPrice)) : 0;
    const equity = account.balance + floatingPnl;
    const base = Math.max(CONFIG.INITIAL_BALANCE, 1);
    const drawdownPercent = Math.max(0, ((base - equity) / base) * 100);

    if (drawdownPercent >= CONFIG.ALERT_DRAWDOWN_PERCENT && !drawdownAlertSentRef.current) {
      drawdownAlertSentRef.current = true;
      sendTelegram(`⚠️ <b>CẢNH BÁO DRAWDOWN</b>\n• Drawdown: ${drawdownPercent.toFixed(2)}%\n• Equity: ${equity.toFixed(2)} USDT`);
      addLog(`Cảnh báo drawdown ${drawdownPercent.toFixed(2)}% đã gửi Telegram.`, 'warning');
    }

    if (drawdownPercent < CONFIG.ALERT_DRAWDOWN_PERCENT * 0.7) {
      drawdownAlertSentRef.current = false;
    }
  }, [shouldRunLocalBot, account.balance, position, currentPrice]);

  useEffect(() => {
    if (!shouldRunLocalBot) return;

    const sendDailySummary = () => {
      const now = Date.now();
      if (now - lastDailySummaryRef.current < CONFIG.ALERT_DAILY_SUMMARY_MS) return;
      lastDailySummaryRef.current = now;

      const winTrades = history.filter((t) => t.pnl > 0).length;
      const totalTrades = history.length;
      const winRate = totalTrades > 0 ? (winTrades / totalTrades) * 100 : 0;

      sendTelegram(
        `📊 <b>BÁO CÁO NGÀY BOT</b>\n• Số lệnh: ${totalTrades}\n• Win rate: ${winRate.toFixed(1)}%\n• PnL tích luỹ: ${account.pnlHistory.toFixed(2)} USDT\n• Số dư: ${account.balance.toFixed(2)} USDT`,
      );
      addLog('Đã gửi báo cáo ngày Telegram.', 'info');
    };

    sendDailySummary();
    const summaryTimer = setInterval(sendDailySummary, 60 * 1000);
    return () => clearInterval(summaryTimer);
  }, [shouldRunLocalBot, history, account.pnlHistory, account.balance]);

  const fetchMTFData = async () => {
    try {
      const intervals: (keyof MTFSentiment)[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
      const newSentiment: Partial<MTFSentiment> = {};

      for (const int of intervals) {
        const mtfCandles = await fetchMarketCandles(CONFIG.SYMBOL, int, CONFIG.EMA_PERIOD + 1);
        if (mtfCandles.length > 0) {
          const closes = mtfCandles.map((d) => d.close);
          const ema = calculateZLEMA(closes, CONFIG.EMA_PERIOD);
          const currentPrice = closes[closes.length - 1];
          const currentEma = ema[ema.length - 1];

          if (currentPrice > currentEma) newSentiment[int] = 'BULLISH';
          else if (currentPrice < currentEma) newSentiment[int] = 'BEARISH';
          else newSentiment[int] = 'NEUTRAL';
        }
      }
      setSentiment(prev => ({ ...prev, ...newSentiment }));
    } catch (e) {
      console.error("Error fetching MTF data", e);
    }
  };

  useEffect(() => {
    if (shouldRunLocalBot) {
      fetchMTFData();
      const interval = setInterval(fetchMTFData, 60000); // 1 minute sync
      return () => clearInterval(interval);
    }
  }, [shouldRunLocalBot]);

  const processAndSetData = (newCandles: Candle[]) => {
    setCandles(newCandles);
    const lastCandle = newCandles[newCandles.length - 1];
    setCurrentPrice(lastCandle.close);

    if (newCandles.length < CONFIG.EMA_PERIOD) return;

    const closes = newCandles.map(c => c.close);
    const volumes = newCandles.map(c => c.volume);
    const close = lastCandle.close;

    const rsi = calculateRSI(closes, CONFIG.RSI_PERIOD);
    const emaArr = calculateZLEMA(closes, CONFIG.EMA_PERIOD);
    const currentEma = emaArr[emaArr.length - 1];
    const macd = getMACD(closes);
    const { fvg, ob } = detectSMC(newCandles);
    const volSma = calculateSMA(volumes, CONFIG.VOL_SMA_PERIOD);

    const trend = close > currentEma ? 'UP' : 'DOWN';
    const score = calculateScores({ rsi, ema: currentEma, macd, fvg, ob, trend }, lastCandle, CONFIG);

    const newAnalysis: Analysis = {
      rsi,
      ema: currentEma,
      macd,
      volSma,
      fvg,
      ob,
      trend,
      score
    };

    setAnalysis(newAnalysis);
    setSentiment(prev => ({ ...prev, '1m': trend === 'UP' ? 'BULLISH' : 'BEARISH' }));

    // --- LIVE TRADING LOGIC (SMC SPEC) ---
    if (!isTradingActive.current || !user) return;

    const now = Date.now();
    const shouldLogAnalysis = now - lastAnalysisLogTime.current >= CONFIG.LOG_INTERVAL_MS;

    if (positionRef.current) {
      if (isProcessingRef.current) return;

      const isL = String(positionRef.current.type) === 'LONG';
      const pnl = isL
        ? (close - positionRef.current.entryPrice) * (positionRef.current.size / positionRef.current.entryPrice)
        : (positionRef.current.entryPrice - close) * (positionRef.current.size / positionRef.current.entryPrice);

      // Trailing SL / Breakeven at 1.5R
      const riskDist = Math.abs(positionRef.current.entryPrice - positionRef.current.slPrice);
      const currDist = isL ? (close - positionRef.current.entryPrice) : (positionRef.current.entryPrice - close);

      if (riskDist > 0 && currDist >= riskDist * 1.5 && !positionRef.current.signalDetail?.isBreakeven) {
        const newSl = positionRef.current.entryPrice;
        if ((isL && newSl > positionRef.current.slPrice) || (!isL && newSl < positionRef.current.slPrice)) {
          const updatedPos = {
            ...positionRef.current,
            slPrice: newSl,
            signalDetail: { ...positionRef.current.signalDetail, isBreakeven: true }
          };
          syncRuntimePositionState(updatedPos);
          if (shouldLogAnalysis) {
            addLog(`Đã dời StopLoss về hòa vốn (Breakeven) do lợi nhuận đạt 1.5R. Giá an toàn: ${newSl.toFixed(2)}`, 'success');
            lastAnalysisLogTime.current = now;
          }
        }
      }

      let reason = '';
      if ((isL && close >= positionRef.current.tpPrice) || (!isL && close <= positionRef.current.tpPrice)) reason = 'TAKE PROFIT';
      if ((isL && close <= positionRef.current.slPrice) || (!isL && close >= positionRef.current.slPrice)) reason = 'STOP LOSS';

      if (reason) {
        isProcessingRef.current = true;
        handleCloseOrder(reason, pnl);
      } else if (shouldLogAnalysis) {
        addLog(`Đang nắm giữ ${positionRef.current.type} (PnL Ròng: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)} USDT).`, 'analysis');
        lastAnalysisLogTime.current = now;
      }
      return;
    }

    if (isProcessingRef.current || now - lastTradeTimeRef.current < CONFIG.COOLDOWN_MS) return;
    if (latestAccountRef.current.balance < 10) return;

    const dayKey = new Date(lastCandle.time).toISOString().slice(0, 10);
    if (dayTrackerRef.current.dayKey !== dayKey) {
      dayTrackerRef.current = { dayKey, startBalance: latestAccountRef.current.balance, realizedPnl: 0 };
    }

    if (
      dayTrackerRef.current.startBalance > 0
      && dayTrackerRef.current.realizedPnl < 0
      && Math.abs(dayTrackerRef.current.realizedPnl) / dayTrackerRef.current.startBalance >= DAILY_LOSS_LIMIT
    ) {
      pendingSetupRef.current = null;
      if (shouldLogAnalysis) {
        addLog('Dừng giao dịch: chạm giới hạn lỗ ngày -3%.', 'warning');
        lastAnalysisLogTime.current = now;
      }
      return;
    }

    const ltfCandles = aggregateCandles(newCandles, LTF_MINUTES);
    const htfCandles = aggregateCandles(newCandles, HTF_MINUTES);

    if (ltfCandles.length < Math.max(ATR_PERIOD + 2, SWEEP_LOOKBACK + 1, BOS_LOOKBACK + 2) || htfCandles.length < 4) {
      return;
    }

    const ltfIndex = ltfCandles.length - 1;
    const ltfLast = ltfCandles[ltfIndex];

    if (pendingSetupRef.current) {
      const setup = pendingSetupRef.current;
      const touchedEntry = ltfLast.low <= setup.entryPrice && ltfLast.high >= setup.entryPrice;
      if (touchedEntry) {
        isProcessingRef.current = true;
        handleOpenOrder(setup.side, setup.entryPrice, setup.slPrice, setup.tpPrice, {
          setup: 'SMC OB Retest',
          rr: setup.rr,
          trend: getHtfTrendBias(htfCandles),
        });
        pendingSetupRef.current = null;
        lastAnalysisLogTime.current = now;
      }
      return;
    }

    if (!isAllowedTradingHourUtc(ltfLast.time)) {
      if (shouldLogAnalysis) {
        addLog('Bỏ qua setup: ngoài khung giờ giao dịch UTC.', 'info');
        lastAnalysisLogTime.current = now;
      }
      return;
    }

    const ltfAtrSeries = calculateATR(ltfCandles, ATR_PERIOD);
    const currentAtr = ltfAtrSeries[ltfIndex];
    if (!currentAtr || currentAtr <= 0) return;

    const ltfVolumeSma = calculateSMA(ltfCandles.map((c) => c.volume), 20);
    if (!ltfVolumeSma || ltfLast.volume <= ltfVolumeSma * 1.2) {
      if (shouldLogAnalysis) {
        addLog(`Bỏ qua setup: Volume thấp (${ltfLast.volume.toFixed(2)} <= ${(ltfVolumeSma * 1.2).toFixed(2)}).`, 'info');
        lastAnalysisLogTime.current = now;
      }
      return;
    }

    const trendBias = getHtfTrendBias(htfCandles);
    if (trendBias === 'NEUTRAL') {
      if (shouldLogAnalysis) {
        addLog('Bỏ qua setup: HTF chưa xác nhận xu hướng.', 'info');
        lastAnalysisLogTime.current = now;
      }
      return;
    }

    const sweep = getLiquiditySweep(ltfCandles, ltfIndex, currentAtr);
    if (!sweep) {
      if (shouldLogAnalysis) {
        addLog('Bỏ qua setup: chưa có liquidity sweep hợp lệ.', 'analysis');
        lastAnalysisLogTime.current = now;
      }
      return;
    }

    const side: TradeSide = trendBias === 'BULLISH' ? 'LONG' : 'SHORT';
    if (sweep.side !== side) {
      if (shouldLogAnalysis) {
        addLog(`Bỏ qua setup: sweep ${sweep.side} ngược bias ${side}.`, 'info');
        lastAnalysisLogTime.current = now;
      }
      return;
    }

    const obZone = findOrderBlock(ltfCandles, ltfIndex, side);
    if (!obZone) {
      if (shouldLogAnalysis) {
        addLog('Bỏ qua setup: không tìm thấy Order Block hợp lệ sau BOS.', 'analysis');
        lastAnalysisLogTime.current = now;
      }
      return;
    }

    const entryPrice = obZone.midpoint;
    const slPrice = side === 'LONG' ? obZone.low - currentAtr * 0.5 : obZone.high + currentAtr * 0.5;
    const risk = Math.abs(entryPrice - slPrice);
    if (risk <= 0) return;

    const tpPrice = side === 'LONG' ? entryPrice + risk * RR_TARGET : entryPrice - risk * RR_TARGET;
    const rr = Math.abs(tpPrice - entryPrice) / risk;
    if (rr < RR_TARGET) return;

    pendingSetupRef.current = { side, entryPrice, slPrice, tpPrice, rr, createdAt: now };
    if (shouldLogAnalysis) {
      addLog(`Setup ${side} hợp lệ: chờ giá hồi về OB (${entryPrice.toFixed(2)}), RR ${rr.toFixed(2)}.`, 'success');
      lastAnalysisLogTime.current = now;
    }
  };

  // WebSocket Loop
  useEffect(() => {
    let ws: WebSocket;
    let poller: ReturnType<typeof setInterval> | undefined;
    const loadHistory = async () => {
      try {
        const formattedCandles = await fetchMarketCandles(CONFIG.SYMBOL, CONFIG.INTERVAL, CONFIG.LIMIT_CANDLES);
        if (formattedCandles.length) processAndSetData(formattedCandles);
      } catch (e) { console.error("Data Load Error", e); }
    };

    loadHistory().then(() => {
      if (isGoldSymbol(CONFIG.SYMBOL)) {
        poller = setInterval(loadHistory, 5000);
        return;
      }

      ws = new WebSocket(`wss://stream.binance.com:9443/ws/${CONFIG.SYMBOL.toLowerCase()}@kline_1m`);
      ws.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data).k;
          const price = parseFloat(data.c);
          const candle = { time: Number(data.t), open: parseFloat(data.o), high: parseFloat(data.h), low: parseFloat(data.l), close: price, volume: parseFloat(data.v), isGreen: price >= parseFloat(data.o) };

          setCandles(prev => {
            const lastIdx = prev.length - 1;
            let newArr;
            if (prev.length > 0 && prev[lastIdx].time === Number(data.t)) {
              newArr = [...prev]; newArr[lastIdx] = candle;
            } else {
              newArr = [...prev.slice(-(CONFIG.LIMIT_CANDLES - 1)), candle];
            }
            processAndSetData(newArr);
            return newArr;
          });
        } catch (err) { }
      };
    });
    return () => {
      ws?.close();
      if (poller) clearInterval(poller);
    };
  }, []);

  const handleOpenOrder = async (
    type: 'LONG' | 'SHORT',
    entryPrice: number,
    slPrice: number,
    tpPrice: number,
    meta: { setup: string; rr: number; trend: TrendBias }
  ) => {
    const riskCapital = latestAccountRef.current.balance * RISK_PER_TRADE;
    const slDistance = Math.abs(entryPrice - slPrice);
    if (!slDistance) {
      isProcessingRef.current = false;
      return;
    }

    const size = riskCapital / slDistance;
    const notional = entryPrice * size;
    const fee = notional * CONFIG.FEE;
    const margin = Math.max(notional / CONFIG.LEVERAGE, riskCapital + fee);
    const realMargin = margin - fee;

    const liq = type === 'LONG'
      ? entryPrice * (1 - 1 / CONFIG.LEVERAGE)
      : entryPrice * (1 + 1 / CONFIG.LEVERAGE);

    const details = {
      type,
      entryPrice,
      margin: realMargin,
      size: notional,
      tpPrice,
      slPrice,
      liquidationPrice: liq,
      openFee: fee,
      openTime: Date.now(),
      signalDetail: {
        setup: meta.setup,
        rr: meta.rr.toFixed(2),
        trend: meta.trend,
        riskPercent: `${(RISK_PER_TRADE * 100).toFixed(1)}%`,
      }
    };

    try {
      await setDoc(doc(db, 'artifacts', APP_ID, 'users', user!.uid, 'account', 'data'), { balance: latestAccountRef.current.balance - margin }, { merge: true });
      await setDoc(doc(db, 'artifacts', APP_ID, 'users', user!.uid, 'position', 'active'), { active: true, details });
      sendTelegram(`🚀 <b>BOT MỞ ${type}</b>
• Entry: ${entryPrice.toLocaleString()}
• SL: ${slPrice.toLocaleString()}
• TP: ${tpPrice.toLocaleString()}
• RR: ${meta.rr.toFixed(2)}
• Risk: ${(RISK_PER_TRADE * 100).toFixed(1)}%`);
      addLog(`VÀO ${type}: ${meta.setup} | Entry ${entryPrice.toFixed(2)} | RR ${meta.rr.toFixed(2)}`, 'success');
      lastAnalysisLogTime.current = Date.now();
    } catch (e: any) {
      addLog(`Lỗi mở lệnh: ${e.message}`, 'danger');
      isProcessingRef.current = false;
    }
  };

  const handleCloseOrder = async (reason: string, pnl: number) => {
    if (!position || !user) return;
    lastTradeTimeRef.current = Date.now();

    const fee = position.size * CONFIG.FEE;
    const finalPnl = pnl - fee - position.openFee;
    const tradeId = Date.now().toString();

    try {
      await setDoc(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'history', tradeId), {
        id: tradeId, type: position.type, entryPrice: position.entryPrice, exitPrice: currentPrice,
        pnl: finalPnl, pnlPercent: (finalPnl / position.margin) * 100, reason: reason, time: Date.now(), signalDetail: position.signalDetail || null
      });
      await setDoc(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'account', 'data'), {
        balance: account.balance + position.margin + (pnl - fee), pnlHistory: account.pnlHistory + finalPnl
      }, { merge: true });
      await setDoc(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'position', 'active'), { active: false });

      dayTrackerRef.current.realizedPnl += finalPnl;

      const icon = finalPnl > 0 ? '✅' : '❌';
      sendTelegram(`${icon} <b>ĐÓNG ${position.type}</b>\n• PnL: <b>${finalPnl > 0 ? '+' : ''}${finalPnl.toFixed(2)} USDT</b>\n• Lý do: ${reason}`);
      addLog(`CHỐT LỆNH ${position.type} [${reason}]: ${finalPnl > 0 ? '+' : ''}${finalPnl.toFixed(2)} USDT (Bao gồm phí)`, finalPnl > 0 ? 'success' : 'danger');
    } catch (e: any) {
      addLog(`Lỗi đóng lệnh: ${e.message}`, 'danger');
      isProcessingRef.current = false;
    }
  };

  const handleOpenScalpOrder = (type: TradeSide, setup: string) => {
    if (scalpPositionRef.current) {
      addLog('SCALP đang có lệnh mở, hãy đóng lệnh trước khi vào lệnh mới.', 'warning');
      return;
    }

    if (scalpBalance < DEFAULT_SCALP_MARGIN) {
      addLog(`Không đủ vốn Scalp: Cần ${DEFAULT_SCALP_MARGIN} USDT, nhưng chỉ còn ${scalpBalance.toFixed(2)} USDT.`, 'danger');
      return;
    }

    const entryPrice = latestPriceRef.current || currentPrice;
    if (!entryPrice) {
      addLog('Không thể mở SCALP: chưa có giá thị trường.', 'danger');
      return;
    }

    const leverage = Math.max(1, scalpConfig.leverage);
    const margin = DEFAULT_SCALP_MARGIN;
    const size = margin * leverage;
    const fee = size * CONFIG.FEE;

    const tpDistance = Math.max(0.01, entryPrice * (Math.max(0.05, scalpConfig.tpPercent) / 100));
    const slDistance = Math.max(0.01, entryPrice * (Math.max(0.05, scalpConfig.slPercent) / 100));
    const rr = tpDistance / slDistance;
    if (rr < 1.4) {
      addLog(`Bỏ qua SCALP ${type}: RR ${rr.toFixed(2)} < 1.40, hãy tăng TP hoặc giảm SL.`, 'warning');
      return;
    }
    const tpPrice = type === 'LONG' ? entryPrice + tpDistance : entryPrice - tpDistance;
    const slPrice = type === 'LONG' ? entryPrice - slDistance : entryPrice + slDistance;

    const details: Position = {
      type,
      entryPrice,
      margin,
      size,
      tpPrice,
      slPrice,
      liquidationPrice: type === 'LONG' ? entryPrice * (1 - 1 / leverage) : entryPrice * (1 + 1 / leverage),
      openFee: fee,
      openTime: Date.now(),
      signalDetail: {
        setup,
        leverage,
        rr: rr.toFixed(2),
      },
    };

    setScalpPosition(details);
    setScalpBalance(prev => prev - margin); // Trừ tiền ký quỹ tạm thời

    if (user) {
      const spRef = doc(db, 'artifacts', APP_ID, 'users', user.uid, 'scalpPosition', 'active');
      setDoc(spRef, { active: true, details }, { merge: true }).catch(console.error);
      const userRef = doc(db, 'artifacts', APP_ID, 'users', user.uid, 'account', 'data');
      setDoc(userRef, { scalpBalance: scalpBalance - margin }, { merge: true }).catch(console.error);
    }
    lastScalpSignalRef.current = Date.now();
    addLog(`SCALP ${type} @ ${entryPrice.toFixed(2)} | TP ${tpPrice.toFixed(2)} | SL ${slPrice.toFixed(2)} [${setup}]`, 'success');
    sendTelegram(`⚡ <b>SCALP ${type}</b>\n• Setup: ${setup}\n• Entry: ${entryPrice.toFixed(2)}\n• TP: ${tpPrice.toFixed(2)}\n• SL: ${slPrice.toFixed(2)}\n• Margin: ${margin} USDT\n• Lev: x${leverage}`);
  };

  const handleCloseScalpOrder = (reason: string) => {
    const activeScalp = scalpPositionRef.current;
    if (!activeScalp) return;

    const exitPrice = latestPriceRef.current || currentPrice;
    const pnlRaw = activeScalp.type === 'LONG'
      ? (exitPrice - activeScalp.entryPrice) * (activeScalp.size / activeScalp.entryPrice)
      : (activeScalp.entryPrice - exitPrice) * (activeScalp.size / activeScalp.entryPrice);
    const closeFee = activeScalp.size * CONFIG.FEE;
    const finalPnl = pnlRaw - closeFee - activeScalp.openFee;

    const trade: TradeHistoryItem = {
      id: `scalp-${Date.now()}`,
      type: activeScalp.type,
      entryPrice: activeScalp.entryPrice,
      exitPrice,
      pnl: finalPnl,
      pnlPercent: (finalPnl / activeScalp.margin) * 100,
      reason,
      time: Date.now(),
      signalDetail: activeScalp.signalDetail,
    };

    const newBalance = scalpBalance + activeScalp.margin + finalPnl;

    setScalpHistory((prev) => [trade, ...prev].slice(0, 25));
    setScalpPosition(null);
    setScalpBalance(newBalance);

    if (user) {
      const userRef = doc(db, 'artifacts', APP_ID, 'users', user.uid, 'account', 'data');
      setDoc(userRef, { scalpBalance: newBalance }, { merge: true }).catch(console.error);
      const spRef = doc(db, 'artifacts', APP_ID, 'users', user.uid, 'scalpPosition', 'active');
      setDoc(spRef, { active: false }, { merge: true }).catch(console.error);
      const shRef = doc(db, 'artifacts', APP_ID, 'users', user.uid, 'scalpHistory', trade.id);
      setDoc(shRef, trade).catch(console.error);
    }

    addLog(`SCALP ĐÓNG ${activeScalp.type} (${reason}): ${finalPnl > 0 ? '+' : ''}${finalPnl.toFixed(2)} USDT`, finalPnl >= 0 ? 'success' : 'danger');
    sendTelegram(`${finalPnl >= 0 ? '✅' : '❌'} <b>SCALP ĐÓNG ${activeScalp.type}</b>\n• Lý do: ${reason}\n• PnL: ${finalPnl > 0 ? '+' : ''}${finalPnl.toFixed(2)} USDT`);
  };

  useEffect(() => {
    if (!scalpPosition) return;

    const isL = scalpPosition.type === 'LONG';

    // Trailing SL logic (1.5R)
    const riskDist = Math.abs(scalpPosition.entryPrice - scalpPosition.slPrice);
    const currDist = isL ? (currentPrice - scalpPosition.entryPrice) : (scalpPosition.entryPrice - currentPrice);

    if (riskDist > 0 && currDist >= riskDist * 1.5 && !scalpPosition.signalDetail?.isBreakeven) {
      const newSl = scalpPosition.entryPrice;
      if ((isL && newSl > scalpPosition.slPrice) || (!isL && newSl < scalpPosition.slPrice)) {
        const updatedPos = {
          ...scalpPosition,
          slPrice: newSl,
          signalDetail: { ...scalpPosition.signalDetail, isBreakeven: true }
        };
        setScalpPosition(updatedPos);
        if (user) {
          const spRef = doc(db, 'artifacts', APP_ID, 'users', user.uid, 'scalpPosition', 'active');
          setDoc(spRef, { active: true, details: updatedPos }, { merge: true }).catch(console.error);
        }
        addLog(`SCALP: Đã dời StopLoss về điểm hòa vốn (${newSl.toFixed(2)}) do đạt 1.5R.`, 'success');
        sendTelegram(`🛡 <b>SCALP TRAILING SL KÍCH HOẠT</b>\n• Lệnh ${scalpPosition.type} đã lãi 1.5R.\n• Đã dời SL về điểm hòa vốn (${newSl.toFixed(2)}). Giao dịch Free Risk!`);
      }
    }

    const hitTp = isL ? currentPrice >= scalpPosition.tpPrice : currentPrice <= scalpPosition.tpPrice;
    const hitSl = isL ? currentPrice <= scalpPosition.slPrice : currentPrice >= scalpPosition.slPrice;

    if (hitTp) handleCloseScalpOrder('SCALP TAKE PROFIT');
    else if (hitSl) handleCloseScalpOrder('SCALP STOP LOSS');
  }, [currentPrice, scalpPosition]);

  useEffect(() => {
    if (!scalpAutoEnabled || scalpPosition) return;
    if (Date.now() - lastScalpSignalRef.current < SCALP_COOLDOWN_MS) return;
    if (!isAllowedTradingHourUtc(Date.now())) {
      if (Date.now() - lastScalpGuardLogRef.current > 5 * 60 * 1000) {
        addLog('Scalp SMC tạm dừng ngoài phiên thanh khoản mạnh (UTC 13-17, 20-24).', 'warning');
        lastScalpGuardLogRef.current = Date.now();
      }
      return;
    }
    if (scalpPlan.confidence < 70) return;

    if (scalpPlan.hasTrapRisk) {
      addLog(`CẢNH BÁO BẪY SCALP: ${scalpPlan.trapReason}`, 'warning');
      return;
    }

    if (scalpPlan.bias === 'LONG') handleOpenScalpOrder('LONG', scalpPlan.setup);
    else if (scalpPlan.bias === 'SHORT') handleOpenScalpOrder('SHORT', scalpPlan.setup);
  }, [candles, scalpAutoEnabled, scalpPosition, scalpPlan]);

  const unrealizedPnl = position ? (position.type === 'LONG' ? (currentPrice - position.entryPrice) * (position.size / position.entryPrice) : (position.entryPrice - currentPrice) * (position.size / position.entryPrice)) : 0;
  const unrealizedRoe = position ? (unrealizedPnl / position.margin) * 100 : 0;
  const scalpUnrealizedPnl = scalpPosition ? (scalpPosition.type === 'LONG' ? (currentPrice - scalpPosition.entryPrice) * (scalpPosition.size / scalpPosition.entryPrice) : (scalpPosition.entryPrice - currentPrice) * (scalpPosition.size / scalpPosition.entryPrice)) : 0;
  const scalpUnrealizedRoe = scalpPosition ? (scalpUnrealizedPnl / scalpPosition.margin) * 100 : 0;
  const scalpWins = scalpHistory.filter((trade) => trade.pnl > 0).length;
  const scalpLosses = scalpHistory.filter((trade) => trade.pnl < 0).length;
  const scalpWinRate = scalpHistory.length ? ((scalpWins / scalpHistory.length) * 100).toFixed(1) : '0.0';

  const winTrades = history.filter(t => t.pnl > 0).length;
  const winRate = history.length > 0 ? ((winTrades / history.length) * 100).toFixed(1) : 0;

  if (loadingAuth) return <div className="min-h-screen flex items-center justify-center"><Activity className="animate-spin text-cyan-100" size={48} /></div>;
  if (!user) return <AuthScreen />;

  return (
    <div className="min-h-screen text-slate-100 font-sans p-3 sm:p-4 md:p-6 selection:bg-cyan-200/40">

      {showSettings && (
        <div className="fixed inset-0 bg-slate-800/80 z-50 flex items-center justify-center p-4 backdrop-blur-md">
          <div className="bg-slate-800 p-6 rounded-3xl border border-slate-500/60 max-w-md w-full shadow-2xl">
            <h2 className="text-xl font-black mb-4 flex items-center gap-2 uppercase tracking-tighter text-sky-300"><Settings size={20} /> Cấu hình Telegram</h2>
            <div className="space-y-4">
              <input value={tgConfig.token} onChange={e => setTgConfig({ ...tgConfig, token: e.target.value })} className="w-full bg-slate-900/70 border border-slate-500 rounded-xl p-3 text-sm text-slate-100 focus:border-sky-400 outline-none" placeholder="Bot Token Telegram" />
              <input value={tgConfig.chatId} onChange={e => setTgConfig({ ...tgConfig, chatId: e.target.value })} className="w-full bg-slate-900/70 border border-slate-500 rounded-xl p-3 text-sm text-slate-100 focus:border-sky-400 outline-none" placeholder="Chat ID" />
            </div>
            <div className="mt-6 flex gap-3">
              <button onClick={() => setShowSettings(false)} className="flex-1 py-3 text-slate-300 font-bold hover:text-white transition-colors">HỦY</button>
              <button onClick={async () => {
                await setDoc(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'account', 'data'), { tgToken: tgConfig.token, tgChatId: tgConfig.chatId }, { merge: true });
                await syncTelegramToRuntime(tgConfig.token.trim(), tgConfig.chatId.trim());

                if (tgConfig.token.trim() && tgConfig.chatId.trim() && runtimeOnline) {
                  try {
                    const resp = await fetch(`${CONFIG.API_URL}/api/telegram/test`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        token: tgConfig.token.trim(),
                        chatId: tgConfig.chatId.trim(),
                        text: `✅ <b>Telegram đã kết nối</b>\n• Time: ${new Date().toISOString()}\n• Runtime: ${isRunning ? 'RUNNING' : 'STOPPED'}`,
                      }),
                    });
                    if (!resp.ok) {
                      const data = await resp.json().catch(() => ({}));
                      addLog(`Không gửi được test noti Telegram: ${data?.error || data?.result?.description || 'unknown-error'}`, 'danger');
                    } else {
                      addLog('Đã gửi test notification Telegram thành công.', 'success');
                    }
                  } catch (e: any) {
                    addLog(`Lỗi kết nối backend khi test Telegram: ${e?.message || 'network-error'}`, 'danger');
                  }
                }

                setShowSettings(false);
                addLog("Đã lưu cấu hình Telegram lên Cloud.", "success");
              }} className="flex-1 py-3 bg-blue-600 rounded-xl text-white font-black hover:bg-blue-500 transition-colors shadow-lg shadow-blue-500/20">LƯU CÀI ĐẶT</button>
            </div>
          </div>
        </div>
      )}

      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-12 flex flex-col md:flex-row justify-between items-center ios-card p-5 relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500 opacity-50"></div>
          <div className="flex flex-col sm:flex-row items-center gap-4 z-10 w-full sm:w-auto text-center sm:text-left">
            <div className="p-3 bg-gradient-to-br from-blue-600 to-purple-600 rounded-xl text-white shadow-lg shadow-blue-500/30"><Crosshair size={24} /></div>
            <div>
              <h1 className="text-xl sm:text-2xl font-black bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-200 tracking-tight flex flex-col sm:flex-row items-center gap-2 sm:gap-3">
                NEXUS AI TRADER
                <SentimentIndicators sentiment={sentiment} />
              </h1>
              <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 sm:gap-3 text-[10px] sm:text-[11px] text-slate-300 mt-2 sm:mt-1 font-medium">
                <span className="flex items-center gap-1"><Layers size={12} /> SMC Engine</span>
                <span className="border-l border-slate-500/60 pl-2 sm:pl-3 text-sky-300 font-bold tracking-widest uppercase">LEV x{CONFIG.LEVERAGE}</span>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${runtimeOnline ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-200'}`}>
                  {runtimeOnline ? 'Backend 24/7 ONLINE' : 'Đang kết nối backend...'}
                </span>
                <button onClick={() => setShowSettings(true)} className="ml-0 sm:ml-2 hover:text-white transition-colors underline decoration-slate-500/60 underline-offset-2">Telegram</button>
                <button onClick={() => signOut(auth)} className="text-red-400 hover:text-red-300 transition-colors ml-0 sm:ml-2">Đăng xuất</button>
              </div>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row items-center gap-4 sm:gap-6 mt-6 md:mt-0 z-10 w-full sm:w-auto pt-4 md:pt-0 border-t md:border-t-0 border-white/25 md:border-none">
            <div className="text-center sm:text-right bg-white/20 border border-white/25 rounded-2xl px-4 py-2.5 min-w-[170px]">
              <p className="text-[10px] text-slate-200 font-semibold tracking-[0.15em] uppercase mb-1">XAU/USD • M1</p>
              <p className={`text-3xl sm:text-4xl font-mono font-black tracking-tight ${candles.length > 0 && currentPrice >= candles[candles.length - 1].open ? 'text-emerald-100' : 'text-rose-100'}`}>{currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
            </div>
            <div className="w-full sm:w-52 py-3.5 rounded-2xl font-black uppercase tracking-wider border border-cyan-300/40 bg-cyan-500/10 text-cyan-100 text-center">
              Backend daemon 24/7
            </div>
          </div>
        </div>

        <div className="lg:col-span-4 space-y-4 w-full">
          <MarketRadar analysis={analysis} />
          <WalletManager account={account} position={position} unrealizedPnl={unrealizedPnl} />
          <div className="ios-card p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-black tracking-widest uppercase text-orange-300">Scalp độc lập</h3>
              <div className="text-right">
                <span className="block text-[11px] font-bold text-slate-100">{scalpBalance.toFixed(2)} USDT</span>
                <span className="text-[9px] text-slate-400">Vốn Scalp</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <label className="text-slate-200">Margin (USDT)
                <input type="number" value={DEFAULT_SCALP_MARGIN} readOnly className="mt-1 w-full bg-slate-900/50 border border-slate-500 rounded-lg px-2 py-1.5 text-slate-300 cursor-not-allowed" />
              </label>
              <label className="text-slate-200">Leverage
                <input type="number" min={1} max={100} value={scalpConfig.leverage} onChange={(e) => setScalpConfig((prev) => ({ ...prev, leverage: Number(e.target.value) || 1 }))} className="mt-1 w-full bg-slate-900/70 border border-slate-500 rounded-lg px-2 py-1.5 text-slate-100" />
              </label>
              <label className="text-slate-200">TP (%)
                <input type="number" min={0.05} step={0.05} value={scalpConfig.tpPercent} onChange={(e) => setScalpConfig((prev) => ({ ...prev, tpPercent: Number(e.target.value) || 0.05 }))} className="mt-1 w-full bg-slate-900/70 border border-slate-500 rounded-lg px-2 py-1.5 text-slate-100" />
              </label>
              <label className="text-slate-200">SL (%)
                <input type="number" min={0.05} step={0.05} value={scalpConfig.slPercent} onChange={(e) => setScalpConfig((prev) => ({ ...prev, slPercent: Number(e.target.value) || 0.05 }))} className="mt-1 w-full bg-slate-900/70 border border-slate-500 rounded-lg px-2 py-1.5 text-slate-100" />
              </label>
            </div>

            <div className={`rounded-lg border p-2.5 text-[11px] space-y-1.5 ${scalpPlan.hasTrapRisk ? 'border-amber-400/40 bg-amber-500/10' : scalpPlan.bias === 'LONG' ? 'border-emerald-500/30 bg-emerald-500/10' : scalpPlan.bias === 'SHORT' ? 'border-red-500/30 bg-red-500/10' : 'border-slate-500/50 bg-slate-900/50'}`}>
              <p className="font-bold text-slate-100">Kèo scalp SMC ({DEFAULT_SCALP_MARGIN} USDT/lệnh)</p>
              <p className="text-slate-200">Bias: <span className={scalpPlan.bias === 'LONG' ? 'text-emerald-300 font-bold' : scalpPlan.bias === 'SHORT' ? 'text-red-300 font-bold' : 'text-amber-200 font-bold'}>{scalpPlan.bias}</span> • Setup: {scalpPlan.setup}</p>
              <p className="text-slate-300">Gợi ý: Lev x{scalpPlan.leverage} • TP {scalpPlan.tpPercent}% • SL {scalpPlan.slPercent}%</p>
              <p className="text-slate-300">Độ tin cậy: <span className="font-semibold text-cyan-300">{scalpPlan.confidence}%</span></p>
              {scalpPlan.confirmations.length > 0 && <p className="text-slate-300">Xác nhận: {scalpPlan.confirmations.slice(0, 3).join(' • ')}</p>}
              {scalpPlan.hasTrapRisk && <p className="text-amber-200">⚠️ Bẫy giá: {scalpPlan.trapReason}</p>}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => setScalpAutoEnabled((prev) => !prev)} className={`py-2 rounded-lg text-xs font-bold ${scalpAutoEnabled ? 'bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30' : 'bg-amber-500/20 text-amber-200 hover:bg-amber-500/30'}`}>
                {scalpAutoEnabled ? 'Auto Scalp: ON' : 'Auto Scalp: OFF'}
              </button>
              <button onClick={() => handleCloseScalpOrder('SCALP ĐÓNG TAY')} disabled={!scalpPosition} className="py-2 rounded-lg bg-white/10 text-slate-100 text-xs font-bold hover:bg-white/20 disabled:opacity-50">Đóng Scalp</button>
            </div>

            {scalpPosition ? (
              <div className="text-[11px] rounded-lg border border-white/10 bg-slate-900/60 p-2.5 space-y-1">
                <p className="font-bold text-slate-100">Đang giữ: <span className={scalpPosition.type === 'LONG' ? 'text-emerald-300' : 'text-red-300'}>{scalpPosition.type}</span> @ {scalpPosition.entryPrice.toFixed(2)}</p>
                <p className="text-slate-300">TP {scalpPosition.tpPrice.toFixed(2)} • SL {scalpPosition.slPrice.toFixed(2)}</p>
                <p className={scalpUnrealizedPnl >= 0 ? 'text-emerald-300 font-semibold' : 'text-red-300 font-semibold'}>Floating: {scalpUnrealizedPnl >= 0 ? '+' : ''}{scalpUnrealizedPnl.toFixed(2)} USDT ({scalpUnrealizedRoe.toFixed(2)}%)</p>
              </div>
            ) : <p className="text-[11px] text-slate-300">Không có lệnh scalp đang mở. Auto scalp sẽ tự vào lệnh khi có tín hiệu.</p>}

            <div className="rounded-lg border border-white/10 bg-slate-900/40 p-2.5 space-y-2">
              <div className="flex items-center justify-between text-[10px] uppercase tracking-wider">
                <span className="text-slate-300 font-bold">Tổng hợp lệnh scalp</span>
                <span className="text-slate-400">{scalpHistory.length} lệnh</span>
              </div>
              <div className="grid grid-cols-3 gap-2 text-[10px]">
                <div className="rounded-md border border-emerald-500/20 bg-emerald-500/10 px-2 py-1 text-center text-emerald-300 font-semibold">Thắng: {scalpWins}</div>
                <div className="rounded-md border border-red-500/20 bg-red-500/10 px-2 py-1 text-center text-red-300 font-semibold">Thua: {scalpLosses}</div>
                <div className="rounded-md border border-sky-500/20 bg-sky-500/10 px-2 py-1 text-center text-sky-300 font-semibold">WR: {scalpWinRate}%</div>
              </div>

              <div className="space-y-1.5 max-h-36 overflow-y-auto pr-1 custom-scrollbar">
                {scalpHistory.length === 0 ? (
                  <p className="text-[10px] text-slate-400">Chưa có lịch sử scalp.</p>
                ) : (
                  scalpHistory.slice(0, 8).map((trade) => (
                    <div key={trade.id} className="flex items-center justify-between rounded-md border border-white/10 bg-slate-900/70 px-2 py-1.5 text-[10px]">
                      <div>
                        <p className={`font-bold ${trade.type === 'LONG' ? 'text-emerald-300' : 'text-red-300'}`}>{trade.type} • {trade.reason}</p>
                        <p className="text-slate-400">{new Date(trade.time).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</p>
                      </div>
                      <p className={`font-bold ${trade.pnl >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>{trade.pnl >= 0 ? '+' : ''}{trade.pnl.toFixed(2)}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="lg:col-span-8 space-y-5 w-full flex flex-col h-full">
          <div className="ios-card p-6 border border-amber-100/20">
            <p className="text-xs uppercase tracking-[0.2em] text-amber-200 font-semibold">Gold price (XAU/USD)</p>
            <p className={`mt-2 text-4xl sm:text-5xl font-black tracking-tight ${candles.length > 0 && currentPrice >= candles[candles.length - 1].open ? 'text-emerald-300' : 'text-rose-300'}`}>
              {currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}
              <span className="ml-2 text-lg font-semibold text-slate-300">USD</span>
            </p>
            <p className="mt-2 text-xs text-slate-400">Giao diện đã bỏ biểu đồ, chỉ giữ hiển thị giá vàng theo thời gian thực.</p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 flex-1">
            <ActivePosition position={position} currentPrice={currentPrice} unrealizedPnl={unrealizedPnl} unrealizedRoe={unrealizedRoe} onCloseOrder={handleCloseOrder} />
            <div className="ios-card flex flex-col overflow-hidden">
              <div className="grid grid-cols-3 bg-slate-800/70 border-b border-slate-500/60 p-1 gap-1">
                <button onClick={() => setActiveTab('LOGS')} className={`min-h-10 px-2 py-2.5 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all flex items-center justify-center gap-1.5 border border-transparent whitespace-nowrap ${activeTab === 'LOGS' ? 'bg-slate-800 text-sky-300 shadow-sm border-slate-500/60' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'}`}><Terminal size={12} /> Console AI</button>
                <button onClick={() => setActiveTab('HISTORY')} className={`min-h-10 px-2 py-2.5 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all flex items-center justify-center gap-1.5 border border-transparent whitespace-nowrap ${activeTab === 'HISTORY' ? 'bg-slate-800 text-amber-300 shadow-sm border-slate-500/60' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'}`}><History size={12} /> Winrate: {winRate}%</button>
                <button onClick={() => setActiveTab('DAILY')} className={`min-h-10 px-2 py-2.5 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all flex items-center justify-center gap-1.5 border border-transparent whitespace-nowrap ${activeTab === 'DAILY' ? 'bg-slate-800 text-violet-300 shadow-sm border-slate-500/60' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'}`}>Ngày</button>
              </div>
              <div className="flex-1 overflow-y-auto p-3 custom-scrollbar bg-slate-900/50 font-mono">
                {activeTab === 'LOGS' ? (
                  <div className="space-y-2">
                    {logs.slice(-15).map((log, i) => (
                      <div key={i} className={`text-[10px] border-l-[3px] pl-3 py-2 leading-relaxed rounded-r-lg ${log.type === 'success' ? 'border-green-500 text-green-300 bg-green-900/10' : log.type === 'danger' ? 'border-red-500 text-red-300 bg-red-900/10' : log.type === 'analysis' ? 'border-blue-500 text-blue-300 bg-blue-900/10' : 'border-gray-500/50 text-slate-200/70 bg-gray-800/20'}`}><span className="opacity-50 mr-2">[{log.msg.substring(1, 12)}]</span>{log.msg.substring(13)}</div>
                    ))}
                    <div ref={logsEndRef} />
                  </div>
                ) : activeTab === 'HISTORY' ? (
                  <div className="space-y-2">
                    {history.map((trade) => (
                      <div key={trade.id} className="bg-white/5 p-3 rounded-xl border border-white/5 flex justify-between items-center transition-hover hover:bg-white/10">
                        <div>
                          <div className={`text-xs font-black uppercase ${trade.type === 'LONG' ? 'text-green-500' : 'text-red-500'}`}>{trade.type} <span className="text-slate-400 text-[9px] ml-1">x{CONFIG.LEVERAGE}</span></div>
                          <div className="text-[10px] text-slate-200 mt-1 italic opacity-80">{trade.reason}</div>
                        </div>
                        <div className="text-right">
                          <div className={`text-sm font-black ${trade.pnl > 0 ? 'text-green-400' : 'text-red-400'}`}>{trade.pnl > 0 ? '+' : ''}{trade.pnl.toFixed(2)} USDT</div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-3">
                    <DailyAggregation history={history} />
                    <div className="bg-white/5 border border-white/10 rounded-xl p-3 space-y-3">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                        <p className="text-xs font-bold text-purple-300">Backtest nhanh (Binance {CONFIG.SYMBOL}) • Khung {backtestInterval}</p>
                        <div className="flex flex-col sm:flex-row gap-2">
                          <button onClick={() => { setBacktestDate(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().split('T')[0]); setBacktestDays(7); setBacktestInterval('15m'); }} className="w-full sm:w-auto px-3 py-2 rounded-lg bg-white/10 text-slate-100 text-xs font-bold hover:bg-white/20">Hôm qua + 7 ngày</button>
                          <button onClick={runQuickBacktest} disabled={backtestLoading} className="w-full sm:w-auto px-3 py-2 rounded-lg bg-purple-500/20 text-purple-200 text-xs font-bold hover:bg-purple-500/30 disabled:opacity-50">{backtestLoading ? 'Đang chạy...' : 'Chạy backtest'}</button>
                        </div>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <label className="text-[11px] text-slate-200 flex flex-col gap-1">
                          Ngày kết thúc
                          <input type="date" value={backtestDate} onChange={(e) => setBacktestDate(e.target.value)} max={new Date().toISOString().split('T')[0]} className="bg-slate-900/70 border border-slate-500 rounded-lg px-2.5 py-2 text-[11px] text-slate-100 focus:outline-none focus:border-violet-400" />
                        </label>
                        <label className="text-[11px] text-slate-200 flex flex-col gap-1">
                          Số ngày lịch sử
                          <input type="number" min={1} max={30} value={backtestDays} onChange={(e) => setBacktestDays(Number(e.target.value) || 1)} className="bg-slate-900/70 border border-slate-500 rounded-lg px-2.5 py-2 text-[11px] text-slate-100 focus:outline-none focus:border-violet-400" />
                        </label>
                        <label className="text-[11px] text-slate-200 flex flex-col gap-1">
                          Khung thời gian
                          <select value={backtestInterval} onChange={(e) => setBacktestInterval(e.target.value as BacktestInterval)} className="bg-slate-900/70 border border-slate-500 rounded-lg px-2.5 py-2 text-[11px] text-slate-100 focus:outline-none focus:border-violet-400">
                            {BACKTEST_INTERVAL_OPTIONS.map((interval) => (
                              <option key={interval} value={interval}>{interval}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                      {backtestResult ? (
                        <div className="space-y-3">
                          <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-100">
                            <p>Khung: <b>{backtestInterval}</b></p>
                            <p>Tổng lệnh: <b>{backtestResult.totalTrades}</b></p>
                            <p>Win rate: <b>{backtestResult.winRate.toFixed(1)}%</b></p>
                            <p>PnL: <b className={backtestResult.netPnl >= 0 ? 'text-emerald-300' : 'text-red-300'}>{backtestResult.netPnl.toFixed(2)} USDT</b></p>
                            <p>Profit factor: <b>{Number.isFinite(backtestResult.profitFactor) ? backtestResult.profitFactor.toFixed(2) : '∞'}</b></p>
                            <p>Expectancy: <b>{backtestResult.expectancy.toFixed(2)}</b></p>
                            <p>Max DD: <b>{backtestResult.maxDrawdownPercent.toFixed(2)}%</b></p>
                          </div>
                          <div className="rounded-lg border border-slate-600/70 bg-slate-900/60 p-2.5">
                            <p className="text-[11px] font-bold text-purple-200 mb-2">Gợi ý tối ưu</p>
                            <ul className="space-y-1.5">
                              {getBacktestSuggestions(backtestResult).map((tip, idx) => (
                                <li key={idx} className={`text-[11px] ${tip.level === 'good' ? 'text-emerald-300' : tip.level === 'warning' ? 'text-amber-200' : 'text-slate-200'}`}>
                                  • {tip.text}
                                </li>
                              ))}
                            </ul>
                          </div>
                        </div>
                      ) : <p className="text-[11px] text-slate-300">Bấm “Chạy backtest” để xem hiệu suất nhanh trên dữ liệu nến lịch sử.</p>}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
