import { useState, useEffect, useRef } from 'react';
import { onAuthStateChanged, signOut, User } from 'firebase/auth';
import { doc, setDoc, onSnapshot, collection } from 'firebase/firestore';
import {
  Crosshair, Play, Pause, Settings, Layers,
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
import BarChart from './components/Dashboard/BarChart';
import WalletManager from './components/Dashboard/WalletManager';
import ActivePosition from './components/Dashboard/ActivePosition';
import DailyAggregation from './components/Dashboard/DailyAggregation';
import SentimentIndicators from './components/Dashboard/SentimentIndicators';
import { BacktestResult, runBacktest } from './utils/backtest';

export default function BitcoinTradingBot() {
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
  const [runtimeOnline, setRuntimeOnline] = useState(false);
  const [backtestFromDate, setBacktestFromDate] = useState(() => {
    const from = new Date();
    from.setDate(from.getDate() - 7);
    return from.toISOString().slice(0, 10);
  });
  const [backtestToDate, setBacktestToDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [backtestRangeLabel, setBacktestRangeLabel] = useState('7 ngày gần nhất');

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

  // Sync refs
  useEffect(() => { tgConfigRef.current = tgConfig; }, [tgConfig]);
  useEffect(() => { latestPriceRef.current = currentPrice; }, [currentPrice]);
  useEffect(() => { latestAccountRef.current = account; }, [account]);
  useEffect(() => { positionRef.current = position; }, [position]);
  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs, activeTab]);
  useEffect(() => { candlesRef.current = candles; }, [candles]); // Added
  useEffect(() => { sentimentRef.current = sentiment; }, [sentiment]); // Added
  useEffect(() => { isTradingActive.current = isRunning; }, [isRunning]); // Added

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

    const unsubAcc = onSnapshot(userRef, (d) => {
      if (d.exists()) {
        const data = d.data();
        if (Number(data.balance) === 10000 && Number(data.pnlHistory) === 0) {
          setDoc(userRef, { balance: 1000, pnlHistory: 0, tgToken: data.tgToken || '', tgChatId: data.tgChatId || '' });
        } else {
          setAccount({ balance: Number(data.balance) || 0, pnlHistory: Number(data.pnlHistory) || 0 });
          setTgConfig({ token: String(data.tgToken || ''), chatId: String(data.tgChatId || '') });
        }
      } else setDoc(userRef, { balance: CONFIG.INITIAL_BALANCE, pnlHistory: 0 });
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

    return () => { unsubAcc(); unsubPos(); unsubHist(); };
  }, [user]);

  const addLog = (message: string, type: 'info' | 'success' | 'danger' | 'warning' | 'analysis' = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [...prev.slice(-99), { msg: `[${timestamp}] ${message}`, type }]);
  };

  const sendTelegram = async (text: string) => {
    const { token, chatId } = tgConfigRef.current;
    if (!token || !chatId) return;
    try { await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }) }); } catch (e) { }
  };

  const syncRuntimeState = async (running: boolean) => {
    try {
      const response = await fetch('/api/runtime', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          isRunning: running,
          token: tgConfigRef.current.token,
          chatId: tgConfigRef.current.chatId,
          symbol: CONFIG.SYMBOL,
          heartbeatMs: CONFIG.HEARTBEAT_MS,
        }),
      });
      setRuntimeOnline(response.ok);
    } catch (error) {
      setRuntimeOnline(false);
    }
  };

  const handleToggleRunning = () => {
    const nextRunning = !isRunning;
    setIsRunning(nextRunning);
    syncRuntimeState(nextRunning);
  };

  const runQuickBacktest = async () => {
    setBacktestLoading(true);
    try {
      const normalizedFromDate = backtestFromDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const normalizedToDate = backtestToDate || new Date().toISOString().slice(0, 10);
      const startTime = new Date(`${normalizedFromDate}T00:00:00.000Z`).getTime();
      const endTime = new Date(`${normalizedToDate}T23:59:59.999Z`).getTime();

      if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime) {
        addLog('Khoảng ngày backtest không hợp lệ.', 'danger');
        return;
      }

      let cursor = startTime;
      const allRows: any[] = [];
      const maxLoops = 40;

      for (let i = 0; i < maxLoops && cursor < endTime; i++) {
        const res = await fetch(
          `https://api.binance.com/api/v3/klines?symbol=${CONFIG.SYMBOL}&interval=${CONFIG.INTERVAL}&startTime=${cursor}&endTime=${endTime}&limit=1000`,
        );
        if (!res.ok) throw new Error('Không tải được dữ liệu lịch sử');

        const rows = await res.json();
        if (!Array.isArray(rows) || rows.length === 0) break;

        allRows.push(...rows);
        cursor = Number(rows[rows.length - 1][0]) + 1;
      }

      const uniq = new Map<number, any>();
      allRows.forEach((k) => uniq.set(Number(k[0]), k));
      const sortedRows = [...uniq.values()].sort((a, b) => Number(a[0]) - Number(b[0]));

      const formattedCandles: Candle[] = sortedRows.map((k: any) => ({
        time: Number(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
        isGreen: parseFloat(k[4]) >= parseFloat(k[1]),
      }));

      if (formattedCandles.length < CONFIG.EMA_PERIOD + 5) {
        addLog('Không đủ dữ liệu trong khoảng ngày đã chọn để chạy backtest.', 'warning');
        setBacktestResult(null);
        return;
      }

      const result = runBacktest(formattedCandles);
      const rangeLabel = `${normalizedFromDate} → ${normalizedToDate}`;
      setBacktestRangeLabel(rangeLabel);
      setBacktestResult(result);
      addLog(
        `Backtest (${rangeLabel}) hoàn tất: ${result.totalTrades} lệnh, WR ${result.winRate.toFixed(1)}%, PnL ${result.netPnl.toFixed(2)} USDT`,
        'info',
      );
    } catch (error: any) {
      addLog(`Lỗi backtest: ${error?.message || 'Không thể tải dữ liệu'}`, 'danger');
    } finally {
      setBacktestLoading(false);
    }
  };

  // Telegram Heartbeat
  useEffect(() => {
    if (!isRunning || !user) return;
    sendTelegram(`🟢 <b>HỆ THỐNG ĐÃ KHỞI ĐỘNG</b>\n• Cặp: BTCUSDT\n• Chu kỳ báo cáo: 10 phút/lần`);

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
  }, [isRunning, user]);

  useEffect(() => {
    const syncInitialRuntime = async () => {
      try {
        const response = await fetch('/api/runtime');
        if (!response.ok) return;
        const data = await response.json();
        setRuntimeOnline(Boolean(data.background));
        if (typeof data.isRunning === 'boolean') setIsRunning(data.isRunning);
      } catch (error) {
        setRuntimeOnline(false);
      }
    };

    syncInitialRuntime();
  }, []);

  useEffect(() => {
    if (!isRunning) {
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
  }, [isRunning, account.balance, position, currentPrice]);

  useEffect(() => {
    if (!isRunning) return;

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
  }, [isRunning, history, account.pnlHistory, account.balance]);

  const fetchMTFData = async () => {
    try {
      const intervals: (keyof MTFSentiment)[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
      const newSentiment: Partial<MTFSentiment> = {};

      for (const int of intervals) {
        const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${CONFIG.SYMBOL}&interval=${int}&limit=${CONFIG.EMA_PERIOD + 1}`);
        const data = await res.json();
        if (data && data.length > 0) {
          const closes = data.map((d: any) => parseFloat(d[4]));
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
    if (isRunning) {
      fetchMTFData();
      const interval = setInterval(fetchMTFData, 60000); // 1 minute sync
      return () => clearInterval(interval);
    }
  }, [isRunning]);

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

    // --- TRADING LOGIC WITH MTF & VOLUME FILTERS ---
    if (!isTradingActive.current || !user) return;

    const now = Date.now();
    const shouldLogAnalysis = now - lastAnalysisLogTime.current >= CONFIG.LOG_INTERVAL_MS;

    if (positionRef.current) {
      if (isProcessingRef.current) return;

      const isL = String(positionRef.current.type) === 'LONG';
      const pnl = isL ? (close - positionRef.current.entryPrice) * (positionRef.current.size / positionRef.current.entryPrice) : (positionRef.current.entryPrice - close) * (positionRef.current.size / positionRef.current.entryPrice);

      let r = '';
      if ((isL && close >= positionRef.current.tpPrice) || (!isL && close <= positionRef.current.tpPrice)) r = 'TAKE PROFIT';
      if ((isL && close <= positionRef.current.slPrice) || (!isL && close >= positionRef.current.slPrice)) r = 'STOP LOSS';

      if (r) {
        isProcessingRef.current = true;
        handleCloseOrder(r, pnl);
      } else if (shouldLogAnalysis) {
        addLog(`Đang nắm giữ ${positionRef.current.type} (PnL Ròng: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)} USDT). AI giám sát điểm thanh lý...`, 'analysis');
        lastAnalysisLogTime.current = now;
      }
      return;
    }

    if (isProcessingRef.current || now - lastTradeTimeRef.current < CONFIG.COOLDOWN_MS) return;
    if (latestAccountRef.current.balance < 10) return;

    // 1. Volume Filter: Bỏ qua nếu thanh nến hiện tại có Vol thấp hơn trung bình 20 phiên
    const lastVolume = lastCandle.volume;
    if (lastVolume < volSma * CONFIG.VOL_MULTIPLIER) {
      if (shouldLogAnalysis) addLog(`Bỏ qua lệnh: Khối lượng (${lastVolume.toFixed(2)}) thấp hơn mức trung bình (${volSma.toFixed(2)}).`, 'info');
      lastAnalysisLogTime.current = now;
      return;
    }

    // 2. MTF Alignment: Xu hướng 1m phải đồng thuận với 5m và 15m
    const trend5m = sentimentRef.current['5m'];
    const trend15m = sentimentRef.current['15m'];
    const currentTrend = newAnalysis.trend === 'UP' ? 'BULLISH' : 'BEARISH';

    if (trend5m !== currentTrend || trend15m !== currentTrend) {
      if (shouldLogAnalysis) addLog(`Bỏ qua lệnh: MTF không đồng thuận (1m: ${currentTrend}, 5m: ${trend5m}, 15m: ${trend15m}).`, 'info');
      lastAnalysisLogTime.current = now;
      return;
    }

    // Lọc độ mạnh của tín hiệu RSI (Mean Reversion / Pullback)
    let signalType: 'LONG' | 'SHORT' | null = null;
    const rsiThreshold = CONFIG.RSI_OVERBOUGHT_OVERSOLD;

    if (newAnalysis.score >= CONFIG.CONFLUENCE_THRESHOLD) {
      // Strong Buy Signal
      if (newAnalysis.rsi < rsiThreshold.oversold) {
        signalType = 'LONG'; // Oversold, potential bounce
      } else if (newAnalysis.rsi > rsiThreshold.neutral_low && newAnalysis.rsi < rsiThreshold.neutral_high) {
        signalType = 'LONG'; // Neutral, but strong SMC
      }
    } else if (newAnalysis.score <= -CONFIG.CONFLUENCE_THRESHOLD) {
      // Strong Sell Signal
      if (newAnalysis.rsi > rsiThreshold.overbought) {
        signalType = 'SHORT'; // Overbought, potential drop
      } else if (newAnalysis.rsi > rsiThreshold.neutral_low && newAnalysis.rsi < rsiThreshold.neutral_high) {
        signalType = 'SHORT'; // Neutral, but strong SMC
      }
    }

    if (signalType) {
      isProcessingRef.current = true;
      handleOpenOrder(signalType, close, 50, newAnalysis);
      lastAnalysisLogTime.current = now;
      return;
    }

    if (shouldLogAnalysis) {
      let thought = `Quét đa tín hiệu [Điểm: ${newAnalysis.score > 0 ? '+' + newAnalysis.score : newAnalysis.score}/5]. `;
      if (lastVolume < volSma * CONFIG.VOL_MULTIPLIER) thought += `Thanh khoản thấp (${(lastVolume / (volSma || 1)).toFixed(1)}x tb). `;
      if (trend5m !== currentTrend || trend15m !== currentTrend) thought += `MTF không đồng thuận. `;

      if (newAnalysis.score === 0) thought += `Thị trường Sideway/Nhiễu. Tạm dừng giao dịch.`;
      else if (newAnalysis.score > 0 && newAnalysis.score < CONFIG.CONFLUENCE_THRESHOLD) thought += `Phe Mua đang gom hàng (FVG/OB) nhưng xung lực chưa đủ. Rình mồi LONG...`;
      else if (newAnalysis.score < 0 && newAnalysis.score > -CONFIG.CONFLUENCE_THRESHOLD) thought += `Phe Bán đang áp đảo. Áp lực MACD yếu. Rình mồi SHORT...`;

      addLog(`AI Radar: ${thought}`, 'analysis');
      lastAnalysisLogTime.current = now;
    }
  };

  // WebSocket Loop
  useEffect(() => {
    let ws: WebSocket;
    const loadHistory = async () => {
      try {
        const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${CONFIG.SYMBOL}&interval=${CONFIG.INTERVAL}&limit=${CONFIG.LIMIT_CANDLES}`);
        const data = await res.json();
        const formattedCandles: Candle[] = data.map((k: any) => ({
          time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]), isGreen: parseFloat(k[4]) >= parseFloat(k[1])
        }));
        processAndSetData(formattedCandles);
      } catch (e) { console.error("Data Load Error", e); }
    };

    loadHistory().then(() => {
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
    return () => ws?.close();
  }, []);

  const handleOpenOrder = async (type: 'LONG' | 'SHORT', price: number, margin: number, a: Analysis) => {
    const size = margin * CONFIG.LEVERAGE;
    const fee = size * CONFIG.FEE;
    const realMargin = margin - fee;

    let tp, sl, liq;
    if (type === 'LONG') {
      tp = price * (1 + CONFIG.TP_PERCENT);
      sl = price * (1 - CONFIG.SL_PERCENT);
      liq = price * (1 - 1 / CONFIG.LEVERAGE);
    } else {
      tp = price * (1 - CONFIG.TP_PERCENT);
      sl = price * (1 + CONFIG.SL_PERCENT);
      liq = price * (1 + 1 / CONFIG.LEVERAGE);
    }

    const setupName = a.score >= CONFIG.CONFLUENCE_THRESHOLD ? "SMC Strong Buy" : "SMC Strong Sell";
    const details = {
      type, entryPrice: price, margin: realMargin, size,
      tpPrice: tp, slPrice: sl, liquidationPrice: liq,
      openFee: fee, openTime: Date.now(),
      signalDetail: { rsi: a.rsi.toFixed(1), setup: setupName, score: a.score }
    };

    try {
      await setDoc(doc(db, 'artifacts', APP_ID, 'users', user!.uid, 'account', 'data'), { balance: latestAccountRef.current.balance - margin }, { merge: true });
      await setDoc(doc(db, 'artifacts', APP_ID, 'users', user!.uid, 'position', 'active'), { active: true, details });
      sendTelegram(`🚀 <b>BOT MỞ ${type}</b>\n• Giá: ${price.toLocaleString()}\n• Điểm SMC: ${a.score}/5\n• RSI: ${a.rsi.toFixed(1)}`);
      addLog(`VÀO ${type}: Tín hiệu ${setupName} chuẩn xác. SMC Score: ${a.score}`, 'success');
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

      const icon = finalPnl > 0 ? '✅' : '❌';
      sendTelegram(`${icon} <b>ĐÓNG ${position.type}</b>\n• PnL: <b>${finalPnl > 0 ? '+' : ''}${finalPnl.toFixed(2)} USDT</b>\n• Lý do: ${reason}`);
      addLog(`CHỐT LỆNH ${position.type} [${reason}]: ${finalPnl > 0 ? '+' : ''}${finalPnl.toFixed(2)} USDT (Bao gồm phí)`, finalPnl > 0 ? 'success' : 'danger');
    } catch (e: any) {
      addLog(`Lỗi đóng lệnh: ${e.message}`, 'danger');
      isProcessingRef.current = false;
    }
  };

  const unrealizedPnl = position ? (position.type === 'LONG' ? (currentPrice - position.entryPrice) * (position.size / position.entryPrice) : (position.entryPrice - currentPrice) * (position.size / position.entryPrice)) : 0;
  const unrealizedRoe = position ? (unrealizedPnl / position.margin) * 100 : 0;

  const winTrades = history.filter(t => t.pnl > 0).length;
  const winRate = history.length > 0 ? ((winTrades / history.length) * 100).toFixed(1) : 0;

  if (loadingAuth) return <div className="min-h-screen bg-[#05070a] flex items-center justify-center"><Activity className="animate-spin text-blue-500" size={48} /></div>;
  if (!user) return <AuthScreen />;

  return (
    <div className="min-h-screen bg-[#05070a] text-gray-100 font-sans p-4 md:p-6 selection:bg-blue-500/30">

      {showSettings && (
        <div className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4 backdrop-blur-md">
          <div className="bg-[#0d1117] p-6 rounded-3xl border border-white/5 max-w-md w-full shadow-2xl">
            <h2 className="text-xl font-black mb-4 flex items-center gap-2 uppercase tracking-tighter text-blue-400"><Settings size={20} /> Cấu hình Telegram</h2>
            <div className="space-y-4">
              <input value={tgConfig.token} onChange={e => setTgConfig({ ...tgConfig, token: e.target.value })} className="w-full bg-[#05070a] border border-gray-800 rounded-xl p-3 text-sm text-white focus:border-blue-500 outline-none" placeholder="Bot Token Telegram" />
              <input value={tgConfig.chatId} onChange={e => setTgConfig({ ...tgConfig, chatId: e.target.value })} className="w-full bg-[#05070a] border border-gray-800 rounded-xl p-3 text-sm text-white focus:border-blue-500 outline-none" placeholder="Chat ID" />
            </div>
            <div className="mt-6 flex gap-3">
              <button onClick={() => setShowSettings(false)} className="flex-1 py-3 text-gray-400 font-bold hover:text-white transition-colors">HỦY</button>
              <button onClick={async () => {
                await setDoc(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'account', 'data'), { tgToken: tgConfig.token, tgChatId: tgConfig.chatId }, { merge: true });
                setShowSettings(false); addLog("Đã lưu cấu hình Telegram lên Cloud.", "success");
              }} className="flex-1 py-3 bg-blue-600 rounded-xl text-white font-black hover:bg-blue-500 transition-colors shadow-lg shadow-blue-500/20">LƯU CÀI ĐẶT</button>
            </div>
          </div>
        </div>
      )}

      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-12 flex flex-col md:flex-row justify-between items-center bg-[#0d1117]/80 backdrop-blur-xl p-5 rounded-2xl shadow-2xl border border-white/5 relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500 opacity-50"></div>
          <div className="flex flex-col sm:flex-row items-center gap-4 z-10 w-full sm:w-auto text-center sm:text-left">
            <div className="p-3 bg-gradient-to-br from-blue-600 to-purple-600 rounded-xl text-white shadow-lg shadow-blue-500/30"><Crosshair size={24} /></div>
            <div>
              <h1 className="text-xl sm:text-2xl font-black bg-clip-text text-transparent bg-gradient-to-r from-white to-gray-400 tracking-tight flex flex-col sm:flex-row items-center gap-2 sm:gap-3">
                NEXUS AI TRADER
                <SentimentIndicators sentiment={sentiment} />
              </h1>
              <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 sm:gap-3 text-[10px] sm:text-[11px] text-gray-400 mt-2 sm:mt-1 font-medium">
                <span className="flex items-center gap-1"><Layers size={12} /> SMC Engine</span>
                <span className="border-l border-gray-700 pl-2 sm:pl-3 text-blue-400 font-bold tracking-widest uppercase">LEV x{CONFIG.LEVERAGE}</span>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${runtimeOnline ? 'bg-emerald-500/20 text-emerald-300' : 'bg-amber-500/20 text-amber-200'}`}>
                  {runtimeOnline ? 'Background ON' : 'Background OFF'}
                </span>
                <button onClick={() => setShowSettings(true)} className="ml-0 sm:ml-2 hover:text-white transition-colors underline decoration-gray-700 underline-offset-2">Telegram</button>
                <button onClick={() => signOut(auth)} className="text-red-400 hover:text-red-300 transition-colors ml-0 sm:ml-2">Đăng xuất</button>
              </div>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row items-center gap-4 sm:gap-6 mt-6 md:mt-0 z-10 w-full sm:w-auto pt-4 md:pt-0 border-t md:border-t-0 border-white/5 md:border-none">
            <div className="text-center sm:text-right">
              <p className="text-[10px] text-gray-500 font-bold tracking-widest uppercase mb-1">BTC/USDT M1</p>
              <p className={`text-2xl sm:text-3xl font-mono font-black tracking-tighter ${candles.length > 0 && currentPrice >= candles[candles.length - 1].open ? 'text-[#0ecb81] drop-shadow-[0_0_8px_#0ecb8140]' : 'text-[#f6465d] drop-shadow-[0_0_8px_#f6465d40]'}`}>{currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
            </div>
            <button onClick={handleToggleRunning} className={`flex items-center justify-center gap-2 w-full sm:w-36 py-3.5 rounded-xl font-black uppercase tracking-widest transition-all shadow-lg active:scale-95 border ${isRunning ? 'bg-red-500/10 text-red-500 border-red-500/30 hover:bg-red-500/20' : 'bg-green-500 text-[#05070a] border-green-400 hover:bg-green-400 shadow-green-500/20'}`}>
              {isRunning ? <><Pause size={16} fill="currentColor" /> NGỪNG</> : <><Play size={16} fill="currentColor" /> KHỞI ĐỘNG</>}
            </button>
          </div>
        </div>

        <div className="lg:col-span-4 space-y-5 w-full">
          <MarketRadar analysis={analysis} />
          <WalletManager account={account} position={position} unrealizedPnl={unrealizedPnl} />
        </div>

        <div className="lg:col-span-8 space-y-5 w-full flex flex-col h-full">
          <BarChart candles={candles} position={position} />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 flex-1">
            <ActivePosition position={position} currentPrice={currentPrice} unrealizedPnl={unrealizedPnl} unrealizedRoe={unrealizedRoe} onCloseOrder={handleCloseOrder} />
            <div className="bg-[#0d1117]/80 backdrop-blur-xl rounded-2xl border border-white/5 flex flex-col overflow-hidden shadow-xl">
              <div className="grid grid-cols-3 gap-1 bg-[#1e2329]/50 border-b border-white/5 p-1">
                <button onClick={() => setActiveTab('LOGS')} className={`flex-1 py-2.5 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all flex items-center justify-center gap-1.5 ${activeTab === 'LOGS' ? 'bg-[#0d1117] text-blue-400 shadow-sm border border-white/5' : 'text-gray-500 hover:text-gray-300'}`}><Terminal size={12} /> Console AI</button>
                <button onClick={() => setActiveTab('HISTORY')} className={`flex-1 py-2.5 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all flex items-center justify-center gap-1.5 ${activeTab === 'HISTORY' ? 'bg-[#0d1117] text-yellow-400 shadow-sm border border-white/5' : 'text-gray-500 hover:text-gray-300'}`}><History size={12} /> Winrate: {winRate}%</button>
                <button onClick={() => setActiveTab('DAILY')} className={`flex-1 py-2.5 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all flex items-center justify-center gap-1.5 ${activeTab === 'DAILY' ? 'bg-[#0d1117] text-purple-400 shadow-sm border border-white/5' : 'text-gray-500 hover:text-gray-300'}`}>Ngày</button>
              </div>
              <div className="flex-1 overflow-y-auto p-3 custom-scrollbar bg-[#05070a]/50 font-mono">
                {activeTab === 'LOGS' ? (
                  <div className="space-y-2">
                    {logs.slice(-15).map((log, i) => (
                      <div key={i} className={`text-[10px] border-l-[3px] pl-3 py-2 leading-relaxed rounded-r-lg ${log.type === 'success' ? 'border-green-500 text-green-300 bg-green-900/10' : log.type === 'danger' ? 'border-red-500 text-red-300 bg-red-900/10' : log.type === 'analysis' ? 'border-blue-500 text-blue-300 bg-blue-900/10' : 'border-gray-500/50 text-gray-300/70 bg-gray-800/20'}`}><span className="opacity-50 mr-2">[{log.msg.substring(1, 12)}]</span>{log.msg.substring(13)}</div>
                    ))}
                    <div ref={logsEndRef} />
                  </div>
                ) : activeTab === 'HISTORY' ? (
                  <div className="space-y-2">
                    {history.map((trade) => (
                      <div key={trade.id} className="bg-white/5 p-3 rounded-xl border border-white/5 flex justify-between items-center transition-hover hover:bg-white/10">
                        <div>
                          <div className={`text-xs font-black uppercase ${trade.type === 'LONG' ? 'text-green-500' : 'text-red-500'}`}>{trade.type} <span className="text-gray-500 text-[9px] ml-1">x{CONFIG.LEVERAGE}</span></div>
                          <div className="text-[10px] text-gray-300 mt-1 italic opacity-80">{trade.reason}</div>
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
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-xs font-bold text-purple-300">Backtest lịch sử ({CONFIG.SYMBOL})</p>
                        <button onClick={runQuickBacktest} disabled={backtestLoading} className="w-full sm:w-auto px-3 py-2 rounded-lg bg-purple-500/20 text-purple-200 text-xs font-bold hover:bg-purple-500/30 disabled:opacity-50">{backtestLoading ? 'Đang chạy...' : 'Chạy backtest'}</button>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                        <label className="text-gray-300 space-y-1">
                          <span className="block text-[10px] uppercase tracking-wider text-gray-400">Từ ngày</span>
                          <input type="date" value={backtestFromDate} onChange={(e) => setBacktestFromDate(e.target.value)} className="w-full bg-[#05070a] border border-white/10 rounded-lg px-2 py-1.5 text-gray-200" />
                        </label>
                        <label className="text-gray-300 space-y-1">
                          <span className="block text-[10px] uppercase tracking-wider text-gray-400">Đến ngày</span>
                          <input type="date" value={backtestToDate} onChange={(e) => setBacktestToDate(e.target.value)} className="w-full bg-[#05070a] border border-white/10 rounded-lg px-2 py-1.5 text-gray-200" />
                        </label>
                      </div>

                      {backtestResult ? (
                        <>
                          <p className="text-[10px] text-gray-400">Khoảng test: {backtestRangeLabel}</p>
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-gray-200">
                            <p>Tổng lệnh: <b>{backtestResult.totalTrades}</b></p>
                            <p>Win rate: <b>{backtestResult.winRate.toFixed(1)}%</b></p>
                            <p>PnL: <b className={backtestResult.netPnl >= 0 ? 'text-emerald-300' : 'text-red-300'}>{backtestResult.netPnl.toFixed(2)} USDT</b></p>
                            <p>Profit factor: <b>{Number.isFinite(backtestResult.profitFactor) ? backtestResult.profitFactor.toFixed(2) : '∞'}</b></p>
                            <p>Expectancy: <b>{backtestResult.expectancy.toFixed(2)}</b></p>
                            <p>Max DD: <b>{backtestResult.maxDrawdownPercent.toFixed(2)}%</b></p>
                          </div>
                        </>
                      ) : <p className="text-[11px] text-gray-400">Chọn khoảng ngày quá khứ rồi bấm “Chạy backtest” để xem hiệu suất.</p>}
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
