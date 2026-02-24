import { useState, useEffect, useRef, Dispatch, SetStateAction } from 'react';
import { Wallet, Play, Pause, BarChart2, Zap, WifiOff, Wifi, XCircle, History, MessageSquare, Clock, RefreshCw, TrendingUp, TrendingDown, Minus, Settings } from 'lucide-react';

// --- CẤU HÌNH ---
const CONFIG = {
  SYMBOL: 'BTCUSDT',
  INTERVAL: '1m',       
  HTF_INTERVALS: ['15m', '1h', '4h', '1d'], // Đa khung thời gian
  LIMIT_CANDLES: 80, 
  
  RSI_PERIOD: 14,
  EMA_PERIOD: 50, 
  
  RSI_OVERSOLD: 35, 
  RSI_OVERBOUGHT: 65,
  VOL_MULTIPLIER: 1.1, 
  
  LEVERAGE: 50, 
  INITIAL_BALANCE: 10000,
  TP_PERCENT: 0.008, 
  SL_PERCENT: 0.004, 
  FEE: 0.0004, 
};

// --- TYPES ---
type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number; isGreen: boolean; };
type OrderBlock = { type: 'BULLISH' | 'BEARISH'; top: number; bottom: number; candleIndex: number; };
type Trend = 'UP' | 'DOWN' | 'UNKNOWN';
type Analysis = { 
    rsi: number; ema: number; volSma: number; support: number; resistance: number; 
    fvg: 'BULLISH' | 'BEARISH' | null; trend: Trend; obs: OrderBlock[]; 
    mtfTrends: { m15: Trend, h1: Trend, h4: Trend, d1: Trend }; 
};
type TradeHistoryItem = { id: string; type: 'LONG' | 'SHORT'; entryPrice: number; exitPrice: number; pnl: number; pnlPercent: number; reason: string; time: number; fee: number; };

// --- HELPER FUNCTIONS ---
const loadFromStorage = <T,>(key: string, defaultValue: T): T => {
  try {
    const saved = localStorage.getItem(key);
    if (saved) return JSON.parse(saved);
  } catch (e) {
    console.error("Lỗi đọc localStorage:", e);
  }
  return defaultValue;
};

const calculateRSI = (candles: Candle[], period: number = 14) => {
  if (candles.length < period + 1) return 50;
  const prices = candles.map(c => c.close);
  let gains = 0, losses = 0;
  for (let i = prices.length - period - 1; i < prices.length - 1; i++) {
    const diff = prices[i + 1] - prices[i];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period; let avgLoss = losses / period;
  const currentDiff = prices[prices.length - 1] - prices[prices.length - 2];
  if (currentDiff >= 0) { avgGain = (avgGain * (period - 1) + currentDiff) / period; avgLoss = (avgLoss * (period - 1)) / period; } 
  else { avgGain = (avgGain * (period - 1)) / period; avgLoss = (avgLoss * (period - 1) - currentDiff) / period; }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + (avgGain / avgLoss)));
};

const calculateEMA = (candles: Candle[], period: number) => {
  if (candles.length < period) return candles[candles.length - 1]?.close || 0;
  const k = 2 / (period + 1);
  let ema = candles[0].close;
  for (let i = 1; i < candles.length; i++) ema = candles[i].close * k + ema * (1 - k);
  return ema;
};

const findSupportResistance = (candles: Candle[]) => {
  if (candles.length < 20) return { support: 0, resistance: 0 };
  const window = candles.slice(candles.length - 31, candles.length - 1); 
  return { support: Math.min(...window.map(c => c.low)), resistance: Math.max(...window.map(c => c.high)) };
};

const detectFVG = (candles: Candle[]): 'BULLISH' | 'BEARISH' | null => {
  if (candles.length < 3) return null;
  const c1 = candles[candles.length - 4]; const c3 = candles[candles.length - 2]; 
  if (!c1 || !c3) return null;
  if (c3.low > c1.high) return 'BULLISH';
  if (c3.high < c1.low) return 'BEARISH';
  return null;
};

const detectOrderBlocks = (candles: Candle[]): OrderBlock[] => {
    const obs: OrderBlock[] = [];
    if (candles.length < 10) return obs;
    let foundBullish = false, foundBearish = false;

    for (let i = candles.length - 3; i > 2; i--) {
        const current = candles[i], next = candles[i+1];
        if (!foundBullish && !current.isGreen && next.isGreen && next.close > current.high) {
            if (Math.abs(next.open - next.close) > Math.abs(current.open - current.close) * 1.2) {
                obs.push({ type: 'BULLISH', top: current.high, bottom: current.low, candleIndex: i });
                foundBullish = true;
            }
        }
        if (!foundBearish && current.isGreen && !next.isGreen && next.close < current.low) {
            if (Math.abs(next.open - next.close) > Math.abs(current.open - current.close) * 1.2) {
                obs.push({ type: 'BEARISH', top: current.high, bottom: current.low, candleIndex: i });
                foundBearish = true;
            }
        }
        if (foundBullish && foundBearish) break;
    }
    return obs;
};

const generateMockCandle = (lastCandle: Candle | null): Candle => {
    const now = Date.now();
    let open = lastCandle ? lastCandle.close : 95000;
    const change = (Math.random() - 0.5) * 100; 
    const close = open + change;
    return { time: now, open, high: Math.max(open, close) + 20, low: Math.min(open, close) - 20, close, volume: Math.random() * 100, isGreen: close >= open };
};

// --- MAIN COMPONENT ---
export default function BitcoinTradingBot() {
  const [candles, setCandles] = useState<Candle[]>([]);
  // MTF States
  const [c15m, setC15m] = useState<Candle[]>([]);
  const [c1h, setC1h] = useState<Candle[]>([]);
  const [c4h, setC4h] = useState<Candle[]>([]);
  const [c1d, setC1d] = useState<Candle[]>([]);

  const [currentPrice, setCurrentPrice] = useState<number>(0);
  const [analysis, setAnalysis] = useState<Analysis>({ 
      rsi: 50, ema: 0, volSma: 0, support: 0, resistance: 0, fvg: null, trend: 'UP', obs: [], 
      mtfTrends: { m15: 'UNKNOWN', h1: 'UNKNOWN', h4: 'UNKNOWN', d1: 'UNKNOWN' } 
  });
  
  const [isRunning, setIsRunning] = useState(false);
  const [isSimulation, setIsSimulation] = useState(false);
  const [mode, setMode] = useState<'AUTO' | 'MANUAL'>('AUTO');
  const [activeTab, setActiveTab] = useState<'LOGS' | 'HISTORY'>('LOGS');
  const [nextLogTime, setNextLogTime] = useState<number>(0);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  
  // States from Local Storage
  const [account, setAccount] = useState(() => loadFromStorage('btcBot_account', { balance: CONFIG.INITIAL_BALANCE, pnlHistory: 0 }));
  const [position, setPosition] = useState<{ type: 'LONG' | 'SHORT'; entryPrice: number; margin: number; size: number; tpPrice: number; slPrice: number; liquidationPrice: number; openFee: number; openTime: number; } | null>(() => loadFromStorage('btcBot_position', null));
  const [history, setHistory] = useState<TradeHistoryItem[]>(() => loadFromStorage('btcBot_history', []));
  const [logs, setLogs] = useState<{msg: string, type: string}[]>(() => loadFromStorage('btcBot_logs', []));
  
  // Telegram Settings
  const [tgToken, setTgToken] = useState(() => loadFromStorage('btcBot_tgToken', ''));
  const [tgChatId, setTgChatId] = useState(() => loadFromStorage('btcBot_tgChatId', ''));

  const logsEndRef = useRef<HTMLDivElement>(null);
  const lastAnalysisLogTime = useRef<number>(0); 
  const wsRefs = useRef<{[key: string]: WebSocket}>({});
  
  const tgConfigRef = useRef({ token: tgToken, chatId: tgChatId });

  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs, activeTab]);

  useEffect(() => { localStorage.setItem('btcBot_account', JSON.stringify(account)); }, [account]);
  useEffect(() => { localStorage.setItem('btcBot_position', JSON.stringify(position)); }, [position]);
  useEffect(() => { localStorage.setItem('btcBot_history', JSON.stringify(history)); }, [history]);
  useEffect(() => { localStorage.setItem('btcBot_logs', JSON.stringify(logs)); }, [logs]);
  
  useEffect(() => { 
      localStorage.setItem('btcBot_tgToken', JSON.stringify(tgToken)); 
      localStorage.setItem('btcBot_tgChatId', JSON.stringify(tgChatId)); 
      tgConfigRef.current = { token: tgToken, chatId: tgChatId };
  }, [tgToken, tgChatId]);

  // --- TELEGRAM NOTIFICATION ---
  const sendTelegram = async (text: string) => {
      const { token, chatId } = tgConfigRef.current;
      if (!token || !chatId) return;
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      try {
          await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
          });
      } catch (e) { console.error("Telegram Error:", e); }
  };

  const handleSaveSettings = () => {
      setShowSettings(false);
      addLog("Đã lưu cấu hình Telegram.", "success");
      sendTelegram("✅ <b>Bot Trading V2 Pro</b>\nĐã kết nối Telegram thành công! Bot sẽ gửi thông báo khi có lệnh ở đây.");
  };

  const handleResetData = () => {
    if (!resetConfirm) {
        setResetConfirm(true);
        setTimeout(() => setResetConfirm(false), 3000); 
    } else {
        localStorage.removeItem('btcBot_account');
        localStorage.removeItem('btcBot_position');
        localStorage.removeItem('btcBot_history');
        localStorage.removeItem('btcBot_logs');
        setAccount({ balance: CONFIG.INITIAL_BALANCE, pnlHistory: 0 });
        setPosition(null);
        setHistory([]);
        setLogs([{ msg: `[${new Date().toLocaleTimeString()}] Đã XÓA và KHÔI PHỤC dữ liệu gốc.`, type: 'info' }]);
        setResetConfirm(false);
    }
  };

  const toggleBot = () => {
      if (isRunning) {
          setIsRunning(false);
          addLog("Đã DỪNG Bot. Tạm ngưng vào lệnh.", 'warning');
          setNextLogTime(0);
      } else {
          setIsRunning(true);
          lastAnalysisLogTime.current = 0; 
          setNextLogTime(Date.now());
          addLog("Đã CHẠY Bot. Bắt đầu quét thị trường...", 'info');
      }
  };

  const addLog = (message: string, type: 'info' | 'success' | 'danger' | 'warning' | 'analysis' = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [...prev.slice(-99), { msg: `[${timestamp}] ${message}`, type }]);
  };

  // --- KẾT NỐI WEBSOCKET 5 LUỒNG ---
  useEffect(() => {
    let isMounted = true;
    if (logs.length === 0) addLog("Khởi tạo hệ thống MTF (1m, 15m, 1H, 4H, 1D)...", 'info');

    const initializeData = async () => {
      try {
        const intervals = [CONFIG.INTERVAL, ...CONFIG.HTF_INTERVALS];
        
        const fetches = intervals.map(i => fetch(`https://api.binance.com/api/v3/klines?symbol=${CONFIG.SYMBOL}&interval=${i}&limit=${CONFIG.LIMIT_CANDLES}`).then(r => r.json()));
        const results = await Promise.all(fetches);

        const formatData = (data: any[]) => data.map((k: any) => ({
            time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]), isGreen: parseFloat(k[4]) >= parseFloat(k[1])
        }));

        if (isMounted) {
            setCandles(formatData(results[0])); setC15m(formatData(results[1]));
            setC1h(formatData(results[2])); setC4h(formatData(results[3])); setC1d(formatData(results[4]));
            addLog("🌐 Đã kết nối REST API thành công.", 'success');
            setIsSimulation(false);
        }

        intervals.forEach(interval => {
            const wsUrl = `wss://stream.binance.com:9443/ws/${CONFIG.SYMBOL.toLowerCase()}@kline_${interval}`;
            const ws = new WebSocket(wsUrl);
            wsRefs.current[interval] = ws;

            ws.onmessage = (event) => {
                if (!isMounted) return;
                const message = JSON.parse(event.data);
                const kline = message.k;
                const liveCandle: Candle = { time: kline.t, open: parseFloat(kline.o), high: parseFloat(kline.h), low: parseFloat(kline.l), close: parseFloat(kline.c), volume: parseFloat(kline.v), isGreen: parseFloat(kline.c) >= parseFloat(kline.o) };

                const setterMap: {[key: string]: Dispatch<SetStateAction<Candle[]>>} = {
                    '1m': setCandles, '15m': setC15m, '1h': setC1h, '4h': setC4h, '1d': setC1d
                };

                setterMap[interval](prev => {
                    const arr = [...prev];
                    if (arr.length === 0) return [liveCandle];
                    if (liveCandle.time === arr[arr.length - 1].time) arr[arr.length - 1] = liveCandle;
                    else if (liveCandle.time > arr[arr.length - 1].time) { arr.push(liveCandle); if (arr.length > CONFIG.LIMIT_CANDLES) arr.shift(); }
                    return arr;
                });
            };
            ws.onerror = () => { if (isMounted && interval === '1m') { addLog("Mất kết nối WS. Chuyển sang GIẢ LẬP.", 'warning'); setIsSimulation(true); }};
        });

      } catch (e) { 
        if (isMounted) {
            addLog("Lỗi mạng. Chạy chế độ GIẢ LẬP Offline.", 'warning');
            setIsSimulation(true);
            setCandles(Array.from({length: CONFIG.LIMIT_CANDLES}, (_, i) => generateMockCandle(null)).map((c, i) => ({...c, time: Date.now() - (CONFIG.LIMIT_CANDLES - i)*60000})));
        }
      }
    };

    initializeData();

    return () => {
        isMounted = false;
        Object.values(wsRefs.current).forEach(ws => ws.close());
    };
  }, []);

  // --- XỬ LÝ DỮ LIỆU & BOT LOGIC ---
  useEffect(() => {
      if (candles.length === 0) return;

      const lastCandle = candles[candles.length - 1];
      const currentP = lastCandle.close;

      const rsi = calculateRSI(candles, CONFIG.RSI_PERIOD);
      const ema = calculateEMA(candles, CONFIG.EMA_PERIOD);
      const vols = candles.map(c => c.volume);
      const volSma = vols.slice(Math.max(0, vols.length - 20)).reduce((a, b) => a + b, 0) / 20;
      const { support, resistance } = findSupportResistance(candles);
      const fvg = detectFVG(candles);
      const obs = detectOrderBlocks(candles);
      const trend: Trend = currentP > ema ? 'UP' : 'DOWN';

      const getTrend = (arr: Candle[]): Trend => arr.length > 0 ? (arr[arr.length - 1].close > calculateEMA(arr, 50) ? 'UP' : 'DOWN') : 'UNKNOWN';
      
      const newAnalysis: Analysis = { 
          rsi, ema, volSma, support, resistance, fvg, trend, obs, 
          mtfTrends: { m15: getTrend(c15m), h1: getTrend(c1h), h4: getTrend(c4h), d1: getTrend(c1d) }
      };

      setCurrentPrice(currentP);
      setAnalysis(newAnalysis);

      if (isRunning) {
          if (position) checkExit(currentP, position, account);
          else if (mode === 'AUTO') runBotStrategy(currentP, lastCandle.volume, newAnalysis, account);
      }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, c15m, c1h, c4h, c1d]); 

  // --- TRADING LOGIC ---
  const runBotStrategy = (price: number, vol: number, a: Analysis, currentAcc: typeof account) => {
    const now = Date.now();
    const shouldLogAnalysis = lastAnalysisLogTime.current === 0 || (now - lastAnalysisLogTime.current > 60000);

    if (currentAcc.balance < 10) return;

    const isVolOk = vol > (a.volSma * CONFIG.VOL_MULTIPLIER);
    const volRatio = (vol / (a.volSma || 1)).toFixed(1); 
    
    const bullishOB = a.obs.find(ob => ob.type === 'BULLISH');
    const bearishOB = a.obs.find(ob => ob.type === 'BEARISH');
    const isInBullishOB = bullishOB && price <= bullishOB.top && price >= bullishOB.bottom * 0.999;
    const isInBearishOB = bearishOB && price >= bearishOB.bottom && price <= bearishOB.top * 1.001;

    const smcLongSignal = a.fvg === 'BULLISH' || isInBullishOB;
    const smcShortSignal = a.fvg === 'BEARISH' || isInBearishOB;

    const trends = [a.mtfTrends.m15, a.mtfTrends.h1, a.mtfTrends.h4, a.mtfTrends.d1];
    const upScore = trends.filter(t => t === 'UP').length;
    const downScore = trends.filter(t => t === 'DOWN').length;

    const isMtfLongAligned = upScore >= 3;
    const isMtfShortAligned = downScore >= 3;

    const canLong = isVolOk && a.rsi < CONFIG.RSI_OVERSOLD && smcLongSignal && isMtfLongAligned;
    const canShort = isVolOk && a.rsi > CONFIG.RSI_OVERBOUGHT && smcShortSignal && isMtfShortAligned;

    if (canLong) {
      const reasonStr = `${isInBullishOB ? 'Test Bullish OB' : 'Lấp FVG Tăng'} + Điểm MTF: ${upScore}/4`;
      executeOrder('LONG', price, currentAcc.balance, reasonStr);
      addLog(`🚀 SMC LONG: ${reasonStr}`, 'success');
      lastAnalysisLogTime.current = now; 
      return;
    }
    if (canShort) {
      const reasonStr = `${isInBearishOB ? 'Test Bearish OB' : 'Lấp FVG Giảm'} + Điểm MTF: ${downScore}/4`;
      executeOrder('SHORT', price, currentAcc.balance, reasonStr);
      addLog(`🔥 SMC SHORT: ${reasonStr}`, 'danger');
      lastAnalysisLogTime.current = now;
      return;
    }

    if (shouldLogAnalysis) {
        let thought = "🤖 AI phân tích: ";
        let reasons = [];
        
        reasons.push(`Score Tăng: ${upScore}/4`);
        if (bullishOB) reasons.push(`OB Xanh M1`);
        if (bearishOB) reasons.push(`OB Đỏ M1`);

        if (a.rsi <= 40) {
            if (isInBullishOB) {
                if (!isMtfLongAligned) reasons.push(`Nhiễu sóng (Cần 3/4 khung Tăng) -> BỎ QUA`);
                else reasons.push("Tín hiệu MẠNH -> Chờ xác nhận");
            } else reasons.push("Đợi giá hồi về OB");
        } else if (a.rsi >= 60) {
            if (isInBearishOB) {
                if (!isMtfShortAligned) reasons.push(`Nhiễu sóng (Cần 3/4 khung Giảm) -> BỎ QUA`);
                else reasons.push("Tín hiệu MẠNH -> Chờ xác nhận");
            } else reasons.push("Đợi giá lên OB");
        } else {
            reasons.push(`Đi ngang (RSI ${a.rsi.toFixed(0)})`);
        }
        
        addLog(thought + reasons.join(" | ") + ".", 'analysis');
        lastAnalysisLogTime.current = now;
    }
  };

  const executeOrder = (type: 'LONG' | 'SHORT', price: number, margin: number, reason: string) => {
    const size = margin * CONFIG.LEVERAGE;
    const fee = size * CONFIG.FEE; 
    const realMargin = margin - fee;
    
    let tp, sl, liq;
    if (type === 'LONG') {
       tp = price * (1 + CONFIG.TP_PERCENT); sl = price * (1 - CONFIG.SL_PERCENT); liq = price * (1 - 1/CONFIG.LEVERAGE);
    } else {
       tp = price * (1 - CONFIG.TP_PERCENT); sl = price * (1 + CONFIG.SL_PERCENT); liq = price * (1 + 1/CONFIG.LEVERAGE);
    }
    setAccount(prev => ({ ...prev, balance: prev.balance - margin }));
    setPosition({ type, entryPrice: price, margin: realMargin, size, tpPrice: tp, slPrice: sl, liquidationPrice: liq, openFee: fee, openTime: Date.now() });

    // Bắn thông báo Telegram
    const msg = `🚀 <b>BOT MỞ LỆNH ${type}</b>\nCặp: #${CONFIG.SYMBOL}\nGiá Entry: <b>${price.toFixed(2)}</b>\nKý quỹ: ${realMargin.toFixed(2)} USDT\nĐòn bẩy: x${CONFIG.LEVERAGE}\nTP: ${tp.toFixed(2)} | SL: ${sl.toFixed(2)}\nLý do: <i>${reason}</i>`;
    sendTelegram(msg);
  };

  const closePosition = (reason: string, pnl: number, currentPrice: number) => {
      if (!position) return;
      const closeFee = position.size * CONFIG.FEE;
      const finalPnl = pnl - closeFee;
      
      const newBalance = account.balance + position.margin + finalPnl;
      const netProfit = finalPnl - position.openFee;

      const newTrade: TradeHistoryItem = {
          id: Date.now().toString(), type: position.type, entryPrice: position.entryPrice, exitPrice: currentPrice,
          pnl: netProfit, pnlPercent: (netProfit / position.margin) * 100, reason, time: Date.now(), fee: position.openFee + closeFee
      };

      setHistory(prev => [newTrade, ...prev]);
      setAccount({ balance: newBalance, pnlHistory: account.pnlHistory + netProfit });
      setPosition(null);
      
      const logType = finalPnl > 0 ? 'success' : 'danger';
      addLog(`💰 ĐÓNG ${position.type} (${reason}): ${netProfit > 0 ? '+' : ''}${netProfit.toFixed(2)} USDT (Net)`, logType);

      // Bắn thông báo Telegram
      const icon = netProfit > 0 ? '✅' : '❌';
      const msg = `${icon} <b>BOT ĐÓNG LỆNH ${position.type}</b>\nCặp: #${CONFIG.SYMBOL}\nGiá chốt: <b>${currentPrice.toFixed(2)}</b>\nLợi nhuận ròng: <b>${netProfit > 0 ? '+' : ''}${netProfit.toFixed(2)} USDT</b> (${(netProfit / position.margin * 100).toFixed(2)}%)\nLý do: <i>${reason}</i>\nSố dư mới: ${newBalance.toFixed(2)} USDT`;
      sendTelegram(msg);
  };

  const checkExit = (price: number, pos: NonNullable<typeof position>, acc: typeof account) => {
    let reason = '', pnl = 0;
    if (pos.type === 'LONG') {
      pnl = (price - pos.entryPrice) * (pos.size / pos.entryPrice);
      if (price <= pos.liquidationPrice) reason = 'LIQUIDATION';
      else if (price >= pos.tpPrice) reason = 'TAKE PROFIT';
      else if (price <= pos.slPrice) reason = 'STOP LOSS';
    } else {
      pnl = (pos.entryPrice - price) * (pos.size / pos.entryPrice);
      if (price >= pos.liquidationPrice) reason = 'LIQUIDATION';
      else if (price <= pos.tpPrice) reason = 'TAKE PROFIT';
      else if (price >= pos.slPrice) reason = 'STOP LOSS';
    }

    if (reason) closePosition(reason, pnl, price);
  };

  const getUnrealizedPnl = () => {
    if (!position) return { pnl: 0, roe: 0 };
    let pnl = position.type === 'LONG' ? (currentPrice - position.entryPrice) * (position.size / position.entryPrice) : (position.entryPrice - currentPrice) * (position.size / position.entryPrice);
    return { pnl, roe: (pnl / position.margin) * 100 };
  };

  const { pnl: unrealizedPnl, roe: unrealizedRoe } = getUnrealizedPnl();
  const equity = account.balance + (position ? position.margin + unrealizedPnl : 0);
  
  const totalTrades = history.length;
  const winTrades = history.filter(t => t.pnl > 0).length;
  const winRate = totalTrades > 0 ? ((winTrades / totalTrades) * 100).toFixed(1) : 0;

  useEffect(() => {
      if (!isRunning) return;
      const timer = setInterval(() => setNextLogTime(Date.now()), 1000);
      return () => clearInterval(timer);
  }, [isRunning]);

  // --- RENDER COMPONENT CON CHO MTF BADGE ---
  const MtfBadge = ({ label, trend }: { label: string, trend: Trend }) => {
      const isUp = trend === 'UP';
      const isDown = trend === 'DOWN';
      return (
          <div className={`flex flex-col items-center justify-center p-1 rounded border ${isUp ? 'bg-green-900/20 border-green-800' : isDown ? 'bg-red-900/20 border-red-800' : 'bg-gray-800 border-gray-700'}`}>
              <span className="text-[9px] text-gray-400 font-bold">{label}</span>
              {isUp ? <TrendingUp size={14} className="text-green-500"/> : 
               isDown ? <TrendingDown size={14} className="text-red-500"/> : 
               <Minus size={14} className="text-gray-500"/>}
          </div>
      );
  };

  const renderCandles = () => {
    if (candles.length === 0) return null;
    const maxPrice = Math.max(...candles.map(c => c.high));
    const minPrice = Math.min(...candles.map(c => c.low));
    const range = maxPrice - minPrice;

    const renderLine = (value: number, colorClass: string, textClass: string, label: string, style: string = 'dashed') => {
        if (value < minPrice || value > maxPrice) return null;
        const top = ((maxPrice - value) / range) * 100;
        return (
            <div className={`absolute w-full border-t-2 ${colorClass} border-${style} opacity-90 text-[11px] font-bold ${textClass} z-20`} style={{ top: `${top}%` }}>
                <span className={`px-2 py-0.5 absolute right-0 -translate-y-1/2 rounded shadow-md border ${colorClass.replace('border-t-2', 'border')}`}>
                    {label} {value.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}
                </span>
            </div>
        );
    };

    const renderOB = (ob: OrderBlock) => {
        if (ob.bottom > maxPrice || ob.top < minPrice) return null;
        const topPercent = ((maxPrice - ob.top) / range) * 100;
        const heightPercent = ((ob.top - ob.bottom) / range) * 100;
        const colorClass = ob.type === 'BULLISH' ? 'bg-green-500/10 border-green-500/30' : 'bg-red-500/10 border-red-500/30';
        return (
            <div key={`ob-${ob.candleIndex}`} className={`absolute w-full border-y ${colorClass} z-0 flex items-center justify-start pl-2`} style={{ top: `${topPercent}%`, height: `${heightPercent}%` }}>
                 <span className={`text-[9px] px-1 ${ob.type === 'BULLISH' ? 'text-green-500' : 'text-red-500'}`}>{ob.type === 'BULLISH' ? 'Bullish OB' : 'Bearish OB'}</span>
            </div>
        );
    };

    return (
      <div className="flex items-end justify-between h-full w-full px-2 relative">
        {analysis.obs.map(ob => renderOB(ob))}
        {renderLine(analysis.ema, 'border-purple-500/50', 'text-purple-400 bg-[#1e2329]', 'EMA 1m', 'solid')}
        
        {position && (
            <>
                {renderLine(position.entryPrice, 'border-yellow-400', 'text-yellow-400 bg-yellow-900/80', 'ENTRY', 'solid')}
                {renderLine(position.tpPrice, 'border-green-500', 'text-green-400 bg-green-900/80', 'TP', 'dashed')}
                {renderLine(position.slPrice, 'border-red-500', 'text-red-400 bg-red-900/80', 'SL', 'dashed')}
            </>
        )}

        {candles.map((c, i) => {
          const heightPercent = ((c.high - c.low) / range) * 100;
          const topPercent = ((maxPrice - c.high) / range) * 100;
          const bodyTopPercent = ((maxPrice - Math.max(c.open, c.close)) / range) * 100;
          const bodyHeightPercent = ((Math.abs(c.open - c.close)) / range) * 100;
          return (
            <div key={i} className="flex-1 relative mx-[1px] group z-10" style={{ height: '100%' }}>
              <div className={`absolute w-[1px] left-1/2 -translate-x-1/2 ${c.isGreen ? 'bg-[#0ecb81]' : 'bg-[#f6465d]'}`} style={{ height: `${heightPercent}%`, top: `${topPercent}%` }}></div>
              <div className={`absolute w-full ${c.isGreen ? 'bg-[#0ecb81]' : 'bg-[#f6465d]'}`} style={{ height: `${Math.max(bodyHeightPercent, 0.5)}%`, top: `${bodyTopPercent}%` }}></div>
            </div>
          );
        })}
      </div>
    );
  };

  const getSecondsUntilLog = () => {
      if (lastAnalysisLogTime.current === 0) return 0;
      const elapsed = Date.now() - lastAnalysisLogTime.current;
      const remaining = 60000 - elapsed;
      return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
  };

  return (
    <div className="min-h-screen bg-[#0b0e11] text-gray-100 font-sans p-2 sm:p-4 md:p-6 relative">
      
      {/* SETTINGS MODAL */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
          <div className="bg-[#1e2329] p-6 rounded-lg border border-gray-700 max-w-md w-full shadow-2xl">
              <h2 className="text-xl font-bold mb-4 text-white flex items-center gap-2"><Zap size={20} className="text-purple-500"/> Cài đặt Bot & Telegram</h2>
              <div className="space-y-4">
                  <div className="bg-[#0b0e11] p-3 rounded border border-gray-800">
                      <p className="text-xs text-gray-400 mb-2">Để nhận thông báo qua Telegram:</p>
                      <ul className="text-[11px] text-gray-500 list-disc pl-4 space-y-1">
                          <li>Tìm <span className="text-blue-400">@BotFather</span> tạo bot mới để lấy Token.</li>
                          <li>Tìm <span className="text-blue-400">@userinfobot</span> để lấy Chat ID của bạn.</li>
                          <li><span className="text-yellow-500 font-bold">Quan trọng:</span> Hãy nhắn 1 tin bất kỳ cho con bot bạn vừa tạo trước khi bấm Lưu!</li>
                      </ul>
                  </div>
                  <div>
                      <label className="block text-xs text-gray-400 mb-1 font-bold">Bot Token (HTTP API)</label>
                      <input value={tgToken} onChange={e => setTgToken(e.target.value)} placeholder="VD: 1234567890:ABCdefGhI..." className="w-full bg-[#0b0e11] border border-gray-700 rounded p-2 text-sm text-white focus:border-blue-500 outline-none" />
                  </div>
                  <div>
                      <label className="block text-xs text-gray-400 mb-1 font-bold">Chat ID của bạn</label>
                      <input value={tgChatId} onChange={e => setTgChatId(e.target.value)} placeholder="VD: 123456789" className="w-full bg-[#0b0e11] border border-gray-700 rounded p-2 text-sm text-white focus:border-blue-500 outline-none" />
                  </div>
              </div>
              <div className="mt-6 flex justify-end gap-3">
                  <button onClick={() => setShowSettings(false)} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">Đóng</button>
                  <button onClick={handleSaveSettings} className="px-4 py-2 text-sm bg-blue-600 rounded text-white hover:bg-blue-700 font-bold transition-colors shadow-lg">Lưu & Gửi Test</button>
              </div>
          </div>
        </div>
      )}

      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-6 items-start">
        
        {/* HEADER */}
        <div className="lg:col-span-12 flex flex-col md:flex-row justify-between items-center bg-[#1e2329] p-4 rounded-lg shadow-lg border border-gray-800 gap-4">
          <div className="flex items-center gap-4 w-full md:w-auto">
            <div className="p-2 bg-purple-600 rounded text-white font-bold flex-shrink-0"><Zap size={24} /></div>
            <div className="flex-1">
              <h1 className="text-lg sm:text-xl font-bold text-white flex items-center gap-2 flex-wrap">
                PRO BOT V2 (ULTIMATE MTF)
                {isSimulation ? <span className="bg-yellow-600 text-[10px] px-2 py-0.5 rounded text-white flex items-center gap-1"><WifiOff size={10}/> OFFLINE</span> : 
                               <span className="bg-green-600 text-[10px] px-2 py-0.5 rounded text-white flex items-center gap-1 animate-pulse"><Wifi size={10}/> 5x LIVE WS</span>}
              </h1>
              <div className="flex items-center gap-2 text-xs text-gray-400 mt-1">
                 <button onClick={() => setMode('AUTO')} className={`px-2 py-1 rounded ${mode === 'AUTO' ? 'bg-blue-600 text-white' : 'bg-gray-700'}`}>Auto AI</button>
                 <button onClick={() => setShowSettings(true)} className="px-2 py-1 rounded bg-gray-700 text-white hover:bg-gray-600 flex items-center gap-1 transition-colors"><Settings size={12}/> Cài đặt</button>
                 <span className="ml-1 border-l border-gray-600 pl-2">x{CONFIG.LEVERAGE}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center justify-between w-full md:w-auto gap-6">
             <div className="text-left md:text-right">
                <p className="text-xs text-gray-400">BTC/USDT</p>
                <p className={`text-xl sm:text-2xl font-mono font-bold transition-colors duration-150 ${candles.length > 0 && currentPrice >= candles[candles.length-1].open ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                  {currentPrice.toLocaleString(undefined, {minimumFractionDigits: 2})}
                </p>
             </div>
             <button onClick={toggleBot} className={`flex items-center gap-2 px-6 py-2 rounded font-bold transition-transform active:scale-95 ${isRunning ? 'bg-[#f6465d] hover:bg-red-600' : 'bg-[#0ecb81] hover:bg-green-600'}`}>
                {isRunning ? <><Pause size={18} /> STOP</> : <><Play size={18} /> START</>}
             </button>
          </div>
        </div>

        {/* LEFT COLUMN */}
        <div className="lg:col-span-7 space-y-4 w-full flex flex-col">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="bg-[#1e2329] p-4 rounded-lg border border-gray-800 space-y-3 flex flex-col justify-center relative">
              <div className="flex justify-between items-center">
                  <span className="text-gray-400 text-xs flex items-center gap-1"><Wallet size={14}/> Số dư khả dụng</span>
                  <div className="flex items-center gap-3">
                      <button onClick={handleResetData} className={`text-[10px] px-2 py-0.5 rounded border transition-colors flex items-center gap-1 ${resetConfirm ? 'bg-red-900/50 text-red-400 border-red-500' : 'text-gray-500 border-gray-700 hover:text-gray-300'}`}>
                          <RefreshCw size={10} /> {resetConfirm ? 'Bấm Xóa!' : 'Reset'}
                      </button>
                      <span className="text-white font-mono">${account.balance.toFixed(2)}</span>
                  </div>
              </div>
              <div className="flex justify-between items-center pt-2 border-t border-gray-700">
                  <span className="text-gray-300 text-sm font-bold">Tổng tài sản ròng</span>
                  <span className={`text-lg sm:text-xl font-mono font-bold ${equity >= CONFIG.INITIAL_BALANCE ? 'text-green-400' : 'text-red-400'}`}>${equity.toFixed(2)}</span>
              </div>
            </div>

            <div className={`p-3 rounded-lg border flex flex-col justify-center min-h-[100px] ${position ? 'bg-[#1e2329] border-gray-700' : 'bg-[#1e2329] border-gray-800 opacity-50'}`}>
              <h3 className="text-gray-300 text-sm font-semibold mb-2 flex justify-between">
                <span>Lệnh đang mở</span>
                {position && <span className={`text-xs px-2 rounded ${position.type === 'LONG' ? 'bg-green-600' : 'bg-red-600'}`}>{position.type} x{CONFIG.LEVERAGE}</span>}
              </h3>
              {position ? (
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between items-center bg-gray-900/50 p-2 rounded mb-1">
                      <span className="text-gray-400">PnL (ROE)</span>
                      <span className={`font-mono font-bold text-sm sm:text-base ${unrealizedPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                          {unrealizedPnl > 0 ? '+' : ''}{unrealizedPnl.toFixed(2)} ({unrealizedRoe.toFixed(2)}%)
                      </span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-[11px] mb-1 px-1">
                      <div className="flex justify-between"><span className="text-gray-500">Entry</span><span className="text-gray-200">{position.entryPrice.toLocaleString(undefined, {minimumFractionDigits: 1})}</span></div>
                      <div className="flex justify-between"><span className="text-gray-500">Margin</span><span className="text-gray-200">{position.margin.toFixed(1)}</span></div>
                      <div className="flex justify-between border-t border-gray-800 pt-1"><span className="text-gray-500">TP</span><span className="text-green-400 font-bold">{position.tpPrice.toLocaleString(undefined, {minimumFractionDigits: 1})}</span></div>
                      <div className="flex justify-between border-t border-gray-800 pt-1"><span className="text-gray-500">SL</span><span className="text-red-400 font-bold">{position.slPrice.toLocaleString(undefined, {minimumFractionDigits: 1})}</span></div>
                  </div>
                  <button onClick={() => closePosition('MANUAL', position.type === 'LONG' ? (currentPrice - position.entryPrice) * (position.size / position.entryPrice) : (position.entryPrice - currentPrice) * (position.size / position.entryPrice), currentPrice)} 
                          className="w-full mt-1 bg-slate-700 hover:bg-slate-600 text-white py-1.5 rounded transition-colors border border-slate-600 flex justify-center items-center gap-1">
                      <XCircle size={14}/> Đóng lệnh
                  </button>
                </div>
              ) : <div className="flex-1 flex items-center justify-center text-xs text-gray-500 italic">Chưa có lệnh nào...</div>}
            </div>
          </div>

          <div className="bg-[#1e2329] p-4 rounded-lg border border-gray-800 h-[220px] sm:h-[280px] relative flex flex-col">
             <div className="flex justify-between mb-2 z-10">
                <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2"><BarChart2 size={16}/> Biểu đồ M1 (LIVE)</h3>
                <div className="flex gap-2 text-[10px]">
                    <span className="flex items-center gap-1"><div className="w-2 h-2 bg-green-500/20 border border-green-500"></div> Bullish OB</span>
                    <span className="flex items-center gap-1"><div className="w-2 h-2 bg-red-500/20 border border-red-500"></div> Bearish OB</span>
                </div>
             </div>
             <div className="flex-1 w-full relative border-t border-gray-800 pt-2">{renderCandles()}</div>
          </div>

          {/* BẢNG THEO DÕI MTF VÀ CHỈ BÁO */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="bg-[#1e2329] p-2 rounded-lg border border-gray-800 flex justify-between items-center md:col-span-1">
               <div>
                   <span className="text-[10px] text-gray-400 block">RSI (14)</span>
                   <span className={`text-sm font-bold ${analysis.rsi > 70 ? 'text-red-500' : analysis.rsi < 30 ? 'text-green-500' : 'text-white'}`}>{analysis.rsi.toFixed(1)}</span>
               </div>
               <div className="w-8 h-8 rounded-full border-2 border-gray-700 flex items-center justify-center bg-[#0b0e11]">
                   <div className="w-6 h-6 rounded-full bg-blue-500/20 flex items-center justify-center text-[10px]">{analysis.rsi > 70 ? 'BÁN' : analysis.rsi < 30 ? 'MUA' : 'CHỜ'}</div>
               </div>
            </div>

            <div className="bg-[#1e2329] p-2 rounded-lg border border-gray-800 flex justify-between items-center md:col-span-1">
               <div>
                   <span className="text-[10px] text-gray-400 block">Volume M1</span>
                   <span className={`text-sm font-bold ${candles.length > 0 && candles[candles.length-1].volume > analysis.volSma * CONFIG.VOL_MULTIPLIER ? 'text-yellow-400' : 'text-gray-400'}`}>
                      {candles.length > 0 && (candles[candles.length-1].volume / (analysis.volSma || 1)).toFixed(1)}x
                   </span>
               </div>
            </div>

            {/* BẢNG ĐIỂM MTF TRỰC QUAN */}
            <div className="bg-[#1e2329] p-2 rounded-lg border border-gray-800 col-span-2 flex flex-col justify-center">
               <span className="text-[10px] text-gray-400 block mb-1 text-center font-semibold">ĐỒNG THUẬN ĐA KHUNG (Cần 3/4 điểm)</span>
               <div className="grid grid-cols-4 gap-1">
                   <MtfBadge label="15m" trend={analysis.mtfTrends.m15} />
                   <MtfBadge label="1H" trend={analysis.mtfTrends.h1} />
                   <MtfBadge label="4H" trend={analysis.mtfTrends.h4} />
                   <MtfBadge label="1D" trend={analysis.mtfTrends.d1} />
               </div>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN */}
        <div className="lg:col-span-5 space-y-4 w-full h-full">
          <div className="bg-[#1e2329] rounded-lg border border-gray-800 flex flex-col h-[400px] lg:h-full lg:min-h-[600px]">
             <div className="flex border-b border-gray-800 bg-[#252a30] rounded-t-lg overflow-hidden flex-shrink-0">
                <button onClick={() => setActiveTab('LOGS')} className={`flex-1 py-3 text-xs font-bold flex items-center justify-center gap-2 transition-colors ${activeTab === 'LOGS' ? 'bg-[#1e2329] text-blue-400 border-t-2 border-blue-400' : 'text-gray-500 hover:text-gray-300'}`}>
                    <MessageSquare size={14}/> NHẬT KÝ AI
                </button>
                <button onClick={() => setActiveTab('HISTORY')} className={`flex-1 py-3 text-xs font-bold flex items-center justify-center gap-2 transition-colors ${activeTab === 'HISTORY' ? 'bg-[#1e2329] text-yellow-400 border-t-2 border-yellow-400' : 'text-gray-500 hover:text-gray-300'}`}>
                    <History size={14}/> LỊCH SỬ ({winRate}%)
                </button>
             </div>

             {activeTab === 'LOGS' && isRunning && !position && (
                 <div className="px-3 py-1 bg-blue-900/10 border-b border-blue-900/20 text-[10px] text-blue-400 flex justify-between items-center">
                     <span className="flex items-center gap-1"><Clock size={10}/> Đang theo dõi thị trường...</span>
                     <span>Phân tích sau: {getSecondsUntilLog()}s</span>
                 </div>
             )}

             <div className="flex-1 overflow-y-auto p-3 custom-scrollbar bg-[#0b0e11] font-mono">
               {activeTab === 'LOGS' ? (
                   <div className="space-y-2">
                       {logs.length > 25 && <div className="text-center text-gray-700 text-[10px] py-1 italic">... lịch sử cũ ...</div>}
                       {logs.slice(-25).map((log, i) => (
                         <div key={i} className={`text-[11px] sm:text-xs border-l-2 pl-3 py-2 leading-relaxed rounded-r
                            ${log.type === 'success' ? 'border-green-500 text-green-300 bg-green-900/10' : 
                              log.type === 'danger' ? 'border-red-500 text-red-300 bg-red-900/10' : 
                              log.type === 'analysis' ? 'border-blue-500 text-blue-200 bg-blue-900/5 italic' : 'border-gray-600 text-gray-400'}`}>
                            {log.msg}
                         </div>
                       ))}
                       <div ref={logsEndRef}/>
                   </div>
               ) : (
                   <div className="space-y-2">
                       {history.length === 0 && <div className="text-center text-gray-500 mt-10 italic">Chưa có giao dịch nào.</div>}
                       {history.map((trade) => (
                           <div key={trade.id} className="bg-[#1e2329] p-3 rounded border border-gray-800 flex justify-between items-center">
                               <div>
                                   <div className={`text-xs font-bold ${trade.type === 'LONG' ? 'text-green-500' : 'text-red-500'}`}>
                                       {trade.type} x{CONFIG.LEVERAGE}
                                   </div>
                                   <div className="text-[10px] text-gray-500">{new Date(trade.time).toLocaleString()}</div>
                                   <div className="text-[10px] text-gray-400 mt-1">{trade.reason}</div>
                               </div>
                               <div className="text-right">
                                   <div className={`text-sm font-bold ${trade.pnl > 0 ? 'text-green-400' : 'text-red-400'}`}>
                                       {trade.pnl > 0 ? '+' : ''}{trade.pnl.toFixed(2)} USDT
                                   </div>
                                   <div className={`text-xs ${trade.pnl > 0 ? 'text-green-600' : 'text-red-600'}`}>
                                       {trade.pnlPercent.toFixed(2)}%
                                   </div>
                               </div>
                           </div>
                       ))}
                   </div>
               )}
             </div>
          </div>
        </div>
      </div>
    </div>
  );
}