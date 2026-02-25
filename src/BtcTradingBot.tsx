import React, { useState, useEffect, useRef } from 'react';
import { initializeApp, getApps, getApp } from 'firebase/app';
import { 
  getAuth, 
  onAuthStateChanged, 
  signInAnonymously, 
  signOut,
  User,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword
} from 'firebase/auth';
import { 
  getFirestore, 
  doc, 
  setDoc, 
  onSnapshot, 
  collection, 
  updateDoc
} from 'firebase/firestore';
import { 
  Activity, Wallet, Play, Pause, BarChart2, Zap, Terminal, WifiOff, Wifi, 
  XCircle, Clock, AlertTriangle, History, CheckCircle, Crosshair, TrendingUp, 
  TrendingDown, Layers, Target, Database, ShieldCheck, RefreshCw, Settings 
} from 'lucide-react';

// ============================================================================
// 1. KHỞI TẠO FIREBASE (CLOUD ARCHITECTURE)
// ============================================================================
let app: any = null;
let auth: any = null;
let db: any = null;
let isFirebaseConfigured = false;

if (typeof window !== 'undefined') {
  const savedConfig = localStorage.getItem('btc_firebase_cfg');
  if (savedConfig) {
    try {
      const config = JSON.parse(savedConfig);
      if (getApps().length === 0) app = initializeApp(config);
      else app = getApp();
      auth = getAuth(app);
      db = getFirestore(app);
      isFirebaseConfigured = true;
    } catch (e) {
      localStorage.removeItem('btc_firebase_cfg');
    }
  }
}

const getSafeAppId = () => {
  try {
    // @ts-ignore
    if (typeof __app_id !== 'undefined' && __app_id) return String(__app_id).replace(/[^a-zA-Z0-9]/g, '_');
  } catch(e) {}
  return 'trading-bot-v4-cyberpro';
};
const APP_ID = getSafeAppId();

// ============================================================================
// 2. CẤU HÌNH BOT
// ============================================================================
const CONFIG = {
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
  CONFLUENCE_THRESHOLD: 3, // Cần ít nhất 3 tín hiệu đồng thuận
  
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

// --- TYPES ---
type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number; isGreen: boolean; };

type Analysis = {
  rsi: number;
  ema: number;
  macd: { macdLine: number; signalLine: number; hist: number };
  volSma: number;
  fvg: 'BULLISH' | 'BEARISH' | null; 
  ob: 'BULLISH' | 'BEARISH' | null;
  trend: 'UP' | 'DOWN';
  score: number;
};

type TradeHistoryItem = {
  id: string; type: 'LONG' | 'SHORT'; entryPrice: number; exitPrice: number;
  pnl: number; pnlPercent: number; reason: string; time: number; signalDetail?: any;
};

// --- TOÁN HỌC CHỈ BÁO ---
const calculateRSI = (prices: number[], period: number) => {
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

const calculateFullEMA = (prices: number[], period: number) => {
  if (prices.length === 0) return [];
  const k = 2 / (period + 1);
  let emaArr = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    emaArr.push(prices[i] * k + emaArr[i - 1] * (1 - k));
  }
  return emaArr;
};

const getMACD = (prices: number[]) => {
  if (prices.length < CONFIG.MACD_SLOW) return { macdLine: 0, signalLine: 0, hist: 0 };
  const fastEma = calculateFullEMA(prices, CONFIG.MACD_FAST);
  const slowEma = calculateFullEMA(prices, CONFIG.MACD_SLOW);
  const macdLineArr = fastEma.map((f, i) => f - slowEma[i]);
  const signalLineArr = calculateFullEMA(macdLineArr, CONFIG.MACD_SIGNAL);
  
  const macdLine = macdLineArr[macdLineArr.length - 1];
  const signalLine = signalLineArr[signalLineArr.length - 1];
  return { macdLine, signalLine, hist: macdLine - signalLine };
};

const detectSMC = (candles: Candle[]) => {
  let fvg: 'BULLISH' | 'BEARISH' | null = null;
  let ob: 'BULLISH' | 'BEARISH' | null = null;
  
  if (candles.length < 5) return { fvg, ob };
  
  const c1 = candles[candles.length - 4]; 
  const c3 = candles[candles.length - 2]; 
  if (c3.low > c1.high) fvg = 'BULLISH';
  else if (c3.high < c1.low) fvg = 'BEARISH';

  const recent = candles.slice(-6, -1);
  for(let i = 0; i < recent.length - 2; i++) {
      if(!recent[i].isGreen && recent[i+1].isGreen && recent[i+2].isGreen) ob = 'BULLISH';
      if(recent[i].isGreen && !recent[i+1].isGreen && !recent[i+2].isGreen) ob = 'BEARISH';
  }

  return { fvg, ob };
};

// ============================================================================
// 3. MÀN HÌNH SETUP & ĐĂNG NHẬP (FIREBASE)
// ============================================================================
function SetupScreen() {
  const [jsonInput, setJsonInput] = useState('');
  const [error, setError] = useState('');

  const handleSaveConfig = () => {
    try {
      let str = jsonInput.trim();
      if (str.includes('{') && str.includes('}')) str = str.substring(str.indexOf('{'), str.lastIndexOf('}') + 1);
      const parsedConfig = new Function('return ' + str)();
      if (!parsedConfig || !parsedConfig.apiKey || !parsedConfig.projectId) throw new Error("Cấu hình thiếu apiKey/projectId.");
      localStorage.setItem('btc_firebase_cfg', JSON.stringify(parsedConfig));
      window.location.reload();
    } catch (e: any) { setError("Lỗi: Không thể đọc cấu hình. Vui lòng kiểm tra lại."); }
  };

  return (
    <div className="min-h-screen bg-[#05070a] text-white flex flex-col items-center justify-center p-6 font-sans">
       <Database size={60} className="text-blue-500 mb-6 animate-pulse drop-shadow-[0_0_15px_rgba(59,130,246,0.5)]" />
       <h1 className="text-3xl font-black mb-3 text-center uppercase tracking-tighter">Kết nối Database</h1>
       <div className="w-full max-w-xl space-y-4">
         <textarea value={jsonInput} onChange={(e) => setJsonInput(e.target.value)} className="w-full h-48 bg-[#0d1117] border border-gray-800 rounded-3xl p-5 font-mono text-sm text-green-400 focus:border-blue-500 outline-none shadow-inner" placeholder={`{\n  apiKey: "AIzaSy...",\n  authDomain: "...",\n  projectId: "...",\n  appId: "..."\n}`} />
         {error && <p className="text-red-400 text-xs font-bold text-center bg-red-500/10 p-2 rounded-lg">{error}</p>}
         <button onClick={handleSaveConfig} className="w-full bg-blue-600 hover:bg-blue-700 font-black py-4 rounded-xl transition-all shadow-lg shadow-blue-500/20 active:scale-95 uppercase tracking-widest">Khởi tạo Đám mây</button>
       </div>
    </div>
  );
}

function AuthScreen() {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setLoading(true);
    try {
      if (isLogin) await signInWithEmailAndPassword(auth, email, password);
      else {
        const res = await createUserWithEmailAndPassword(auth, email, password);
        await setDoc(doc(db, 'artifacts', APP_ID, 'users', res.user.uid, 'account', 'data'), { balance: CONFIG.INITIAL_BALANCE, pnlHistory: 0, createdAt: Date.now() });
      }
    } catch (err: any) { setError('Lỗi đăng nhập. Kiểm tra lại thông tin.'); } 
    finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen bg-[#05070a] flex items-center justify-center p-4 font-sans text-gray-100">
      <div className="bg-[#0d1117] p-8 rounded-[2rem] border border-white/5 w-full max-w-md shadow-2xl relative overflow-hidden backdrop-blur-xl">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500"></div>
        <div className="flex justify-center mb-6"><div className="p-4 bg-gradient-to-br from-blue-600 to-purple-600 rounded-2xl shadow-lg shadow-purple-500/20"><ShieldCheck size={40} /></div></div>
        <h2 className="text-2xl font-black text-center mb-2 uppercase tracking-tighter">Cyber-Pro Login</h2>
        <form onSubmit={handleAuth} className="space-y-4 mt-6">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required className="w-full bg-[#05070a] border border-gray-800 rounded-xl p-4 text-sm outline-none focus:border-blue-500 transition-colors" placeholder="Địa chỉ Email" />
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} required className="w-full bg-[#05070a] border border-gray-800 rounded-xl p-4 text-sm outline-none focus:border-blue-500 transition-colors" placeholder="Mật khẩu bảo mật" />
          {error && <p className="text-red-400 text-xs text-center font-bold bg-red-500/10 p-2 rounded-lg">{error}</p>}
          <button type="submit" disabled={loading} className="w-full bg-blue-600 hover:bg-blue-500 font-black py-4 rounded-xl uppercase tracking-widest transition-all active:scale-95 mt-2 flex justify-center shadow-lg shadow-blue-500/20 disabled:opacity-50">
            {loading ? <RefreshCw className="animate-spin" size={20}/> : (isLogin ? 'VÀO HỆ THỐNG' : 'ĐĂNG KÝ MỚI')}
          </button>
        </form>
        <button onClick={() => setIsLogin(!isLogin)} className="w-full mt-6 text-gray-500 text-xs hover:text-blue-400 uppercase font-bold tracking-widest">{isLogin ? "Chưa có tài khoản?" : "Quay lại đăng nhập"}</button>
      </div>
    </div>
  );
}

// ============================================================================
// 4. MAIN COMPONENT (TRADING ENGINE)
// ============================================================================
export default function BitcoinTradingBot() {
  if (!isFirebaseConfigured) return <SetupScreen />;

  const [user, setUser] = useState<User | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [currentPrice, setCurrentPrice] = useState<number>(0);
  const [analysis, setAnalysis] = useState<Analysis>({
    rsi: 50, ema: 0, macd: { macdLine: 0, signalLine: 0, hist: 0 }, volSma: 0, fvg: null, ob: null, trend: 'UP', score: 0
  });
  
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<{msg: string, type: string}[]>([]);
  const [activeTab, setActiveTab] = useState<'LOGS' | 'HISTORY'>('LOGS');
  const [showSettings, setShowSettings] = useState(false);
  
  // Trading State (Cloud Synced)
  const [account, setAccount] = useState({ balance: CONFIG.INITIAL_BALANCE, pnlHistory: 0 });
  const [position, setPosition] = useState<any>(null);
  const [history, setHistory] = useState<TradeHistoryItem[]>([]);
  const [tgConfig, setTgConfig] = useState({ token: '', chatId: '' });

  // Refs for Safe Callbacks
  const logsEndRef = useRef<HTMLDivElement>(null);
  const lastAnalysisLogTime = useRef<number>(0); 
  const isProcessingRef = useRef<boolean>(false);
  const lastTradeTimeRef = useRef<number>(0);
  const tgConfigRef = useRef(tgConfig);
  const latestPriceRef = useRef(currentPrice);
  const latestAccountRef = useRef(account);
  const positionRef = useRef(position);

  // Sync refs
  useEffect(() => { tgConfigRef.current = tgConfig; }, [tgConfig]);
  useEffect(() => { latestPriceRef.current = currentPrice; }, [currentPrice]);
  useEffect(() => { latestAccountRef.current = account; }, [account]);
  useEffect(() => { positionRef.current = position; }, [position]);
  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs, activeTab]);

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
        setAccount({ balance: Number(data.balance) || 0, pnlHistory: Number(data.pnlHistory) || 0 });
        setTgConfig({ token: String(data.tgToken || ''), chatId: String(data.tgChatId || '') });
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
    try { await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }) }); } catch (e) {}
  };

  // Telegram Heartbeat (Chuẩn xác 10 phút, Không reset)
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

  const processAndSetData = (newCandles: Candle[]) => {
    const prices = newCandles.map(c => c.close);
    const lastCandle = newCandles[newCandles.length - 1];
    
    const rsi = calculateRSI(prices, CONFIG.RSI_PERIOD);
    const emaArr = calculateFullEMA(prices, CONFIG.EMA_PERIOD);
    const ema = emaArr[emaArr.length - 1] || lastCandle.close;
    const macd = getMACD(prices);
    
    const vols = newCandles.map(c => c.volume);
    const volSma = vols.slice(Math.max(0, vols.length - 20)).reduce((a, b) => a + b, 0) / 20;
    
    const { fvg, ob } = detectSMC(newCandles);
    const trend = lastCandle.close > ema ? 'UP' : 'DOWN';

    let score = 0;
    if (trend === 'UP') score += 1; else score -= 1;
    if (macd.hist > 0) score += 1; else if (macd.hist < 0) score -= 1;
    if (rsi < CONFIG.RSI_OVERSOLD) score += 1; else if (rsi > CONFIG.RSI_OVERBOUGHT) score -= 1;
    if (fvg === 'BULLISH') score += 1; else if (fvg === 'BEARISH') score -= 1;
    if (ob === 'BULLISH') score += 1; else if (ob === 'BEARISH') score -= 1;

    setCandles(newCandles);
    setCurrentPrice(lastCandle.close);
    setAnalysis({ rsi, ema, macd, volSma, fvg, ob, trend, score });
    
    return { currentPrice: lastCandle.close, analysis: { rsi, ema, macd, volSma, fvg, ob, trend, score }, lastCandle };
  };

  // --- MAIN WEBSOCKET LOOP ---
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
            } catch (err) {}
        };
    });
    return () => ws?.close();
  }, []);

  // --- TRADING LOGIC WITH CLOUD DB ---
  useEffect(() => {
    if (!isRunning || !user || currentPrice === 0 || candles.length < CONFIG.EMA_PERIOD) return;

    const now = Date.now();
    const shouldLogAnalysis = now - lastAnalysisLogTime.current >= CONFIG.LOG_INTERVAL_MS; 

    if (position) {
        if (isProcessingRef.current) return;

        const isL = String(position.type) === 'LONG';
        const pnl = isL ? (currentPrice - position.entryPrice) * (position.size / position.entryPrice) : (position.entryPrice - currentPrice) * (position.size / position.entryPrice);
        
        let r = '';
        if ((isL && currentPrice >= position.tpPrice) || (!isL && currentPrice <= position.tpPrice)) r = 'TAKE PROFIT';
        if ((isL && currentPrice <= position.slPrice) || (!isL && currentPrice >= position.slPrice)) r = 'STOP LOSS';
        
        if (r) {
            isProcessingRef.current = true;
            handleCloseOrder(r, pnl);
        } else if (shouldLogAnalysis) {
            addLog(`Đang nắm giữ ${position.type} (PnL Ròng: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)} USDT). AI giám sát điểm thanh lý...`, 'analysis');
            lastAnalysisLogTime.current = now;
        }
        return;
    }
    
    // Cooldown check
    if (isProcessingRef.current || now - lastTradeTimeRef.current < CONFIG.COOLDOWN_MS) return;
    if (account.balance < 10) return;

    const vol = candles[candles.length - 1].volume;
    const isVolOk = vol > (analysis.volSma * CONFIG.VOL_MULTIPLIER);
    const volRatio = (vol / (analysis.volSma || 1)).toFixed(1); 

    const canLong = isVolOk && analysis.score >= CONFIG.CONFLUENCE_THRESHOLD;
    const canShort = isVolOk && analysis.score <= -CONFIG.CONFLUENCE_THRESHOLD;

    if (canLong) {
      isProcessingRef.current = true;
      handleOpenOrder('LONG', currentPrice, account.balance, analysis);
      return;
    }
    if (canShort) {
      isProcessingRef.current = true;
      handleOpenOrder('SHORT', currentPrice, account.balance, analysis);
      return;
    }

    if (shouldLogAnalysis) {
        let thought = `Quét đa tín hiệu [Điểm: ${analysis.score > 0 ? '+'+analysis.score : analysis.score}/5]. `;
        if (!isVolOk) thought += `Thanh khoản thấp (${volRatio}x tb). `;
        
        if (analysis.score === 0) thought += `Thị trường Sideway/Nhiễu. Tạm dừng giao dịch.`;
        else if (analysis.score > 0 && analysis.score < 3) thought += `Phe Mua đang gom hàng (FVG/OB) nhưng xung lực chưa đủ. Rình mồi LONG...`;
        else if (analysis.score < 0 && analysis.score > -3) thought += `Phe Bán đang áp đảo. Áp lực MACD yếu. Rình mồi SHORT...`;
        
        addLog(`AI Radar: ${thought}`, 'analysis');
        lastAnalysisLogTime.current = now;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPrice, isRunning, position, analysis, candles]);

  const handleOpenOrder = async (type: 'LONG' | 'SHORT', price: number, margin: number, a: Analysis) => {
    const size = margin * CONFIG.LEVERAGE;
    const fee = size * CONFIG.FEE; 
    const realMargin = margin - fee;
    
    let tp, sl, liq;
    if (type === 'LONG') {
       tp = price * (1 + CONFIG.TP_PERCENT);
       sl = price * (1 - CONFIG.SL_PERCENT);
       liq = price * (1 - 1/CONFIG.LEVERAGE);
    } else {
       tp = price * (1 - CONFIG.TP_PERCENT);
       sl = price * (1 + CONFIG.SL_PERCENT);
       liq = price * (1 + 1/CONFIG.LEVERAGE);
    }

    const setupName = a.score >= 3 ? "SMC Strong Buy" : "SMC Strong Sell";
    const details = { 
        type, entryPrice: price, margin: realMargin, size, 
        tpPrice: tp, slPrice: sl, liquidationPrice: liq, 
        openFee: fee, openTime: Date.now(),
        signalDetail: { rsi: a.rsi.toFixed(1), setup: setupName, score: a.score }
    };

    try {
      await setDoc(doc(db, 'artifacts', APP_ID, 'users', user!.uid, 'account', 'data'), { balance: 0 }, { merge: true });
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

  // UI Calculations
  const getUnrealizedPnl = () => {
    if (!position) return { pnl: 0, roe: 0 };
    let pnl = position.type === 'LONG' ? (currentPrice - position.entryPrice) * (position.size / position.entryPrice) : (position.entryPrice - currentPrice) * (position.size / position.entryPrice);
    const roe = (pnl / position.margin) * 100;
    return { pnl, roe };
  };

  const { pnl: unrealizedPnl, roe: unrealizedRoe } = getUnrealizedPnl();
  const equity = account.balance + (position ? position.margin + unrealizedPnl : 0);
  
  const winTrades = history.filter(t => t.pnl > 0).length;
  const winRate = history.length > 0 ? ((winTrades / history.length) * 100).toFixed(1) : 0;

  if (loadingAuth) return <div className="min-h-screen bg-[#05070a] flex items-center justify-center"><Activity className="animate-spin text-blue-500" size={48}/></div>;
  if (!user) return <AuthScreen />;

  // Render Candles
  const renderCandles = () => {
    if (candles.length === 0) return null;
    const maxPrice = Math.max(...candles.map(c => c.high));
    const minPrice = Math.min(...candles.map(c => c.low));
    const range = maxPrice - minPrice;

    return (
      <div className="flex items-end justify-between h-full w-full px-1 relative">
        {position && (
            <div className="absolute w-full border-t border-yellow-400/80 border-dashed z-10" style={{ top: `${((maxPrice - position.entryPrice) / range) * 100}%` }}>
                <span className="bg-yellow-400/20 text-yellow-400 px-1.5 py-0.5 text-[9px] rounded absolute right-0 -translate-y-1/2 font-bold backdrop-blur-sm">ENTRY</span>
            </div>
        )}
        {candles.map((c, i) => {
          const heightPercent = ((c.high - c.low) / range) * 100;
          const topPercent = ((maxPrice - c.high) / range) * 100;
          const bodyTopPercent = ((maxPrice - Math.max(c.open, c.close)) / range) * 100;
          const bodyHeightPercent = ((Math.abs(c.open - c.close)) / range) * 100;
          return (
            <div key={i} className="flex-1 relative mx-[1px] group" style={{ height: '100%' }}>
              <div className={`absolute w-[1px] left-1/2 -translate-x-1/2 ${c.isGreen ? 'bg-[#0ecb81]/50' : 'bg-[#f6465d]/50'}`} style={{ height: `${heightPercent}%`, top: `${topPercent}%` }}></div>
              <div className={`absolute w-full rounded-[1px] ${c.isGreen ? 'bg-[#0ecb81] shadow-[0_0_5px_#0ecb8160]' : 'bg-[#f6465d] shadow-[0_0_5px_#f6465d60]'}`} style={{ height: `${Math.max(bodyHeightPercent, 1)}%`, top: `${bodyTopPercent}%` }}></div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[#05070a] text-gray-100 font-sans p-4 md:p-6 selection:bg-blue-500/30">
      
      {/* MODAL CÀI ĐẶT TELEGRAM */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4 backdrop-blur-md">
          <div className="bg-[#0d1117] p-6 rounded-3xl border border-white/5 max-w-md w-full shadow-2xl">
              <h2 className="text-xl font-black mb-4 flex items-center gap-2 uppercase tracking-tighter text-blue-400"><Settings size={20}/> Cấu hình Telegram</h2>
              <div className="space-y-4">
                  <input value={tgConfig.token} onChange={e => setTgConfig({...tgConfig, token: e.target.value})} className="w-full bg-[#05070a] border border-gray-800 rounded-xl p-3 text-sm text-white focus:border-blue-500 outline-none" placeholder="Bot Token Telegram" />
                  <input value={tgConfig.chatId} onChange={e => setTgConfig({...tgConfig, chatId: e.target.value})} className="w-full bg-[#05070a] border border-gray-800 rounded-xl p-3 text-sm text-white focus:border-blue-500 outline-none" placeholder="Chat ID" />
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
        
        {/* HEADER GLASSMORPHISM */}
        <div className="lg:col-span-12 flex flex-col md:flex-row justify-between items-center bg-[#0d1117]/80 backdrop-blur-xl p-5 rounded-2xl shadow-2xl border border-white/5 relative overflow-hidden">
          <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500 opacity-50"></div>
          
          <div className="flex items-center gap-4 z-10">
            <div className="p-3 bg-gradient-to-br from-blue-600 to-purple-600 rounded-xl text-white shadow-lg shadow-blue-500/30">
                <Crosshair size={24} />
            </div>
            <div>
              <h1 className="text-2xl font-black bg-clip-text text-transparent bg-gradient-to-r from-white to-gray-400 tracking-tight flex items-center gap-3">
                NEXUS AI TRADER
                {isSimulation ? <span className="bg-yellow-500/10 border border-yellow-500/20 text-yellow-500 text-[9px] px-2 py-0.5 rounded-full flex items-center gap-1 font-bold uppercase tracking-widest"><WifiOff size={10}/> SIMUL</span> : 
                               <span className="bg-green-500/10 border border-green-500/20 text-green-400 text-[9px] px-2 py-0.5 rounded-full flex items-center gap-1 font-bold uppercase tracking-widest"><Wifi size={10}/> LIVE API</span>}
              </h1>
              <div className="flex items-center gap-3 text-[11px] text-gray-400 mt-1 font-medium">
                 <span className="flex items-center gap-1"><Layers size={12}/> SMC Confluence Engine</span>
                 <span className="border-l border-gray-700 pl-3 text-blue-400 font-bold tracking-widest">LEV x{CONFIG.LEVERAGE}</span>
                 <button onClick={() => setShowSettings(true)} className="ml-2 hover:text-white transition-colors underline decoration-gray-700 underline-offset-2">Cài đặt Telegram</button>
                 <button onClick={() => signOut(auth)} className="text-red-400 hover:text-red-300 transition-colors ml-2">Đăng xuất</button>
              </div>
            </div>
          </div>
          
          <div className="flex items-center gap-6 mt-4 md:mt-0 z-10">
             <div className="text-right">
                <p className="text-[10px] text-gray-500 font-bold tracking-widest uppercase">BTC/USDT M1</p>
                <p className={`text-3xl font-mono font-black tracking-tighter ${candles.length > 0 && currentPrice >= candles[candles.length-1].open ? 'text-[#0ecb81] drop-shadow-[0_0_8px_#0ecb8140]' : 'text-[#f6465d] drop-shadow-[0_0_8px_#f6465d40]'}`}>
                  {currentPrice.toLocaleString(undefined, {minimumFractionDigits: 2})}
                </p>
             </div>
             <button onClick={() => setIsRunning(!isRunning)} 
                     className={`flex items-center justify-center gap-2 w-36 py-3.5 rounded-xl font-black uppercase tracking-widest transition-all shadow-lg active:scale-95 border
                     ${isRunning ? 'bg-red-500/10 text-red-500 border-red-500/30 hover:bg-red-500/20' : 'bg-green-500 text-[#05070a] border-green-400 hover:bg-green-400 shadow-green-500/20'}`}>
                {isRunning ? <><Pause size={16} fill="currentColor"/> NGỪNG</> : <><Play size={16} fill="currentColor"/> KHỞI ĐỘNG</>}
             </button>
          </div>
        </div>

        {/* LEFT COLUMN: 4/12 (THÔNG SỐ & VÍ) */}
        <div className="lg:col-span-4 space-y-5 w-full">
          
          {/* MARKET RADAR HUD */}
          <div className="bg-[#0d1117]/80 backdrop-blur-xl p-5 rounded-2xl border border-white/5 relative overflow-hidden shadow-xl">
             <h3 className="text-xs font-black text-gray-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                <Activity size={14} className="text-blue-400"/> AI Market Radar
             </h3>
             <div className="space-y-4">
                 <div>
                    <div className="flex justify-between text-[10px] text-gray-500 font-bold mb-1 uppercase">
                        <span>Strong Sell</span><span>Neutral</span><span>Strong Buy</span>
                    </div>
                    <div className="h-2 w-full bg-gray-800 rounded-full relative overflow-hidden">
                        <div className="absolute top-0 bottom-0 w-[1px] bg-gray-500 left-1/2 z-10"></div>
                        <div className={`h-full absolute transition-all duration-500 ${analysis.score > 0 ? 'bg-green-500 right-1/2 translate-x-full' : 'bg-red-500 left-1/2 -translate-x-full'}`} 
                             style={{ width: `${Math.abs(analysis.score) * 20}%` }}></div>
                    </div>
                    <div className="text-center mt-1 text-xs font-bold text-white">Điểm Đồng thuận: {analysis.score > 0 ? '+'+analysis.score : analysis.score}/5</div>
                 </div>

                 <div className="grid grid-cols-2 gap-3 pt-3 border-t border-gray-800/50">
                    <div className="bg-white/5 p-3 rounded-xl border border-white/5">
                        <span className="text-[10px] text-gray-500 uppercase font-bold block mb-1">Xu Hướng (EMA)</span>
                        <span className={`text-sm font-black flex items-center gap-1 ${analysis.trend === 'UP' ? 'text-green-400' : 'text-red-400'}`}>
                            {analysis.trend === 'UP' ? <TrendingUp size={16}/> : <TrendingDown size={16}/>} {analysis.trend}
                        </span>
                    </div>
                    <div className="bg-white/5 p-3 rounded-xl border border-white/5">
                        <span className="text-[10px] text-gray-500 uppercase font-bold block mb-1">RSI (14) Động</span>
                        <span className={`text-sm font-black ${analysis.rsi > 65 ? 'text-red-400' : analysis.rsi < 35 ? 'text-green-400' : 'text-white'}`}>
                            {analysis.rsi.toFixed(1)}
                        </span>
                    </div>
                    <div className="bg-white/5 p-3 rounded-xl border border-white/5">
                        <span className="text-[10px] text-gray-500 uppercase font-bold block mb-1">Dòng tiền SMC</span>
                        <span className="text-sm font-black text-blue-400 truncate">
                            {analysis.ob ? `${analysis.ob} OB` : analysis.fvg ? `${analysis.fvg} FVG` : 'Chờ Tín Hiệu'}
                        </span>
                    </div>
                    <div className="bg-white/5 p-3 rounded-xl border border-white/5">
                        <span className="text-[10px] text-gray-500 uppercase font-bold block mb-1">Động lượng MACD</span>
                        <span className={`text-sm font-black ${analysis.macd.hist > 0 ? 'text-green-400' : 'text-red-400'}`}>
                            {analysis.macd.hist > 0 ? 'Phân kỳ Dương' : 'Phân kỳ Âm'}
                        </span>
                    </div>
                 </div>
             </div>
          </div>

          {/* ASSET MANAGER */}
          <div className="bg-[#0d1117]/80 backdrop-blur-xl p-5 rounded-2xl border border-white/5 relative shadow-xl">
            <div className="absolute top-0 right-0 p-4 opacity-5 pointer-events-none"><Wallet size={100}/></div>
            <h3 className="text-xs font-black text-gray-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                <Wallet size={14} className="text-yellow-400"/> Quản lý Tài Sản
            </h3>
            <div className="space-y-4">
                <div>
                    <span className="text-[10px] text-gray-500 font-bold uppercase block mb-1">Số dư Ví (USDT)</span>
                    <span className="text-3xl font-mono font-black text-white">{account.balance.toFixed(2)}</span>
                </div>
                <div className="pt-3 border-t border-gray-800/50">
                    <span className="text-[10px] text-gray-500 font-bold uppercase block mb-1">Tài sản Ròng (Bao gồm PnL)</span>
                    <span className={`text-xl font-mono font-black ${equity >= CONFIG.INITIAL_BALANCE ? 'text-green-400' : 'text-red-400'}`}>
                        {equity.toFixed(2)}
                    </span>
                </div>
            </div>
          </div>

        </div>

        {/* MIDDLE COLUMN: 8/12 (BIỂU ĐỒ & VỊ THẾ) */}
        <div className="lg:col-span-8 space-y-5 w-full flex flex-col h-full">
          
          {/* CHART */}
          <div className="bg-[#0d1117]/80 backdrop-blur-xl p-5 rounded-2xl border border-white/5 h-[300px] relative flex flex-col shadow-xl">
             <div className="flex justify-between mb-2 z-10">
                <h3 className="text-xs font-black text-gray-400 uppercase tracking-widest flex items-center gap-2"><BarChart2 size={14} className="text-blue-400"/> Phân tích Kỹ thuật M1</h3>
             </div>
             <div className="absolute inset-0 top-12 bottom-4 left-4 right-4 bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)] bg-[size:20px_20px] pointer-events-none rounded-lg"></div>
             <div className="flex-1 w-full relative pt-2 z-10">{renderCandles()}</div>
          </div>

          {/* PANELS DƯỚI BIỂU ĐỒ */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 flex-1">
              
              {/* VỊ THẾ ACTIVE */}
              <div className={`backdrop-blur-xl p-5 rounded-2xl border transition-all duration-500 flex flex-col ${position ? 'bg-gradient-to-b from-[#1e2329] to-[#0d1117] border-blue-500/30 shadow-[0_0_15px_rgba(59,130,246,0.15)]' : 'bg-[#0d1117]/80 border-white/5 opacity-80 shadow-xl'}`}>
                <h3 className="text-xs font-black text-gray-400 uppercase tracking-widest mb-4 flex justify-between items-center">
                   <span className="flex items-center gap-2"><Zap size={14} className={position ? "text-yellow-400 animate-pulse" : "text-gray-600"}/> Vị thế Active</span>
                   {position && <span className={`text-[10px] px-2 py-0.5 rounded font-black ${position.type === 'LONG' ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-red-500/20 text-red-400 border border-red-500/30'}`}>{position.type} x{CONFIG.LEVERAGE}</span>}
                </h3>
                
                {position ? (
                  <div className="space-y-4 flex-1 flex flex-col justify-between">
                    <div className="text-center bg-[#05070a] p-4 rounded-xl border border-gray-800 shadow-inner">
                        <span className="text-[10px] text-gray-500 font-bold uppercase block mb-1">Lợi nhuận Tạm tính (ROE)</span>
                        <span className={`font-mono font-black text-3xl ${unrealizedPnl >= 0 ? 'text-green-400 drop-shadow-[0_0_5px_rgba(74,222,128,0.4)]' : 'text-red-400 drop-shadow-[0_0_5px_rgba(248,113,113,0.4)]'}`}>
                            {unrealizedPnl > 0 ? '+' : ''}{unrealizedPnl.toFixed(2)} <span className="text-lg">({unrealizedRoe.toFixed(1)}%)</span>
                        </span>
                    </div>

                    <div className="grid grid-cols-2 gap-3 text-xs">
                        <div className="bg-white/5 p-2 rounded-lg border border-white/5 text-center">
                            <span className="block text-[9px] text-gray-500 uppercase font-bold mb-0.5">Vào Lệnh</span>
                            <span className="text-gray-200 font-mono font-bold">{position.entryPrice.toLocaleString()}</span>
                        </div>
                        <div className="bg-white/5 p-2 rounded-lg border border-white/5 text-center">
                            <span className="block text-[9px] text-gray-500 uppercase font-bold mb-0.5">Ký quỹ</span>
                            <span className="text-gray-200 font-mono font-bold">${position.margin.toFixed(1)}</span>
                        </div>
                    </div>

                    <div className="relative h-1.5 w-full bg-gray-800 rounded-full overflow-hidden my-1">
                         {(() => {
                             const range = Math.abs(position.tpPrice - position.slPrice);
                             const currentPos = Math.abs(currentPrice - position.slPrice);
                             const pct = Math.max(0, Math.min(100, (currentPos / range) * 100));
                             const isLong = position.type === 'LONG';
                             return (
                                 <div className={`absolute top-0 bottom-0 w-2 rounded-full transition-all duration-300 ${isLong ? (pct > 50 ? 'bg-green-400' : 'bg-red-400') : (pct < 50 ? 'bg-green-400' : 'bg-red-400')}`} style={{ left: `${pct}%`, transform: 'translateX(-50%)', boxShadow: '0 0 10px currentColor' }}></div>
                             )
                         })()}
                    </div>
                    <div className="flex justify-between text-[9px] font-bold uppercase text-gray-500 px-1">
                        <span className="text-red-400">SL: {position.slPrice.toLocaleString()}</span>
                        <span className="text-green-400">TP: {position.tpPrice.toLocaleString()}</span>
                    </div>

                    <button onClick={() => {
                              isProcessingRef.current = true;
                              handleCloseOrder('Đóng Lệnh Bằng Tay', unrealizedPnl + (position.size * CONFIG.FEE));
                            }} 
                            className="w-full bg-red-500/10 hover:bg-red-500/20 text-red-400 font-black uppercase tracking-widest text-[11px] py-3 rounded-xl transition-all border border-red-500/30 flex justify-center items-center gap-2 active:scale-95">
                        <XCircle size={14}/> Đóng Lệnh Khẩn Cấp
                    </button>
                  </div>
                ) : (
                    <div className="flex-1 flex flex-col items-center justify-center text-center opacity-50">
                        <Target size={40} className="text-gray-600 mb-3" />
                        <p className="text-xs font-bold text-gray-500 uppercase tracking-widest">Hệ thống đang rình mồi...</p>
                        <p className="text-[10px] text-gray-600 mt-1 max-w-[200px]">AI đang phân tích cấu trúc SMC đa chỉ báo để tìm điểm vào an toàn nhất.</p>
                    </div>
                )}
              </div>

              {/* TABS (NHẬT KÝ & LỊCH SỬ) */}
              <div className="bg-[#0d1117]/80 backdrop-blur-xl rounded-2xl border border-white/5 flex flex-col overflow-hidden shadow-xl">
                 <div className="flex bg-[#1e2329]/50 border-b border-white/5 p-1">
                    <button 
                        onClick={() => setActiveTab('LOGS')}
                        className={`flex-1 py-2.5 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all flex items-center justify-center gap-1.5 ${activeTab === 'LOGS' ? 'bg-[#0d1117] text-blue-400 shadow-sm border border-white/5' : 'text-gray-500 hover:text-gray-300'}`}
                    >
                        <Terminal size={12}/> Console AI
                    </button>
                    <button 
                        onClick={() => setActiveTab('HISTORY')}
                        className={`flex-1 py-2.5 text-[10px] font-black uppercase tracking-widest rounded-xl transition-all flex items-center justify-center gap-1.5 ${activeTab === 'HISTORY' ? 'bg-[#0d1117] text-yellow-400 shadow-sm border border-white/5' : 'text-gray-500 hover:text-gray-300'}`}
                    >
                        <History size={12}/> Winrate: {winRate}%
                    </button>
                 </div>

                 <div className="flex-1 overflow-y-auto p-3 custom-scrollbar bg-[#05070a]/50 font-mono">
                   {activeTab === 'LOGS' ? (
                       <div className="space-y-2">
                           {logs.length === 0 && <div className="text-center text-gray-700 text-[10px] py-10 uppercase tracking-widest font-bold">Chưa có luồng dữ liệu...</div>}
                           {logs.slice(-15).map((log, i) => (
                             <div key={i} className={`text-[10px] border-l-[3px] pl-3 py-2 leading-relaxed rounded-r-lg
                                ${log.type === 'success' ? 'border-green-500 text-green-300 bg-green-900/10' : 
                                  log.type === 'danger' ? 'border-red-500 text-red-300 bg-red-900/10' : 
                                  log.type === 'analysis' ? 'border-blue-500 text-blue-300 bg-blue-900/10' : 'border-gray-500/50 text-gray-300/70 bg-gray-800/20'}`}>
                                <span className="opacity-50 mr-2">[{log.msg.substring(1, 12)}]</span>
                                {log.msg.substring(13)}
                             </div>
                           ))}
                           <div ref={logsEndRef}/>
                       </div>
                   ) : (
                       <div className="space-y-2">
                           {history.length === 0 && <div className="text-center text-gray-700 text-[10px] py-10 uppercase tracking-widest font-bold">Lịch sử trống.</div>}
                           {history.map((trade) => (
                               <div key={trade.id} className="bg-white/5 p-3 rounded-xl border border-white/5 flex justify-between items-center transition-hover hover:bg-white/10">
                                   <div>
                                       <div className={`text-xs font-black uppercase ${trade.type === 'LONG' ? 'text-green-500' : 'text-red-500'}`}>
                                           {trade.type} <span className="text-gray-500 text-[9px] ml-1">x{CONFIG.LEVERAGE}</span>
                                       </div>
                                       <div className="text-[9px] text-gray-500 font-bold mt-1 uppercase tracking-widest">{new Date(trade.time).toLocaleString()}</div>
                                       <div className="text-[10px] text-gray-300 mt-1 italic opacity-80">{trade.reason}</div>
                                   </div>
                                   <div className="text-right">
                                       <div className={`text-sm font-black ${trade.pnl > 0 ? 'text-green-400 drop-shadow-[0_0_5px_rgba(74,222,128,0.4)]' : 'text-red-400 drop-shadow-[0_0_5px_rgba(248,113,113,0.4)]'}`}>
                                           {trade.pnl > 0 ? '+' : ''}{trade.pnl.toFixed(2)} USDT
                                       </div>
                                       <div className={`text-[10px] font-bold uppercase tracking-widest mt-1 ${trade.pnl > 0 ? 'text-green-500/70' : 'text-red-500/70'}`}>
                                           {trade.pnlPercent.toFixed(1)}% ROE
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
    </div>
  );
}