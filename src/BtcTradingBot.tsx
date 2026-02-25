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
  Wallet, Play, Pause, BarChart2, Zap, WifiOff, Wifi, 
  History, Clock, RefreshCw, 
  TrendingUp, TrendingDown, Settings, LogOut, LogIn, UserPlus, ShieldCheck, Activity, Database, AlertTriangle, Target
} from 'lucide-react';

// ============================================================================
// 1. KHỞI TẠO FIREBASE
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
  return 'trading-bot-v3-smc';
};
const APP_ID = getSafeAppId();

// ============================================================================
// 2. CẤU HÌNH BOT & HÀM CHỈ BÁO (SMC, RSI, EMA, MA)
// ============================================================================
const CONFIG = {
  SYMBOL: 'BTCUSDT',
  LIMIT_CANDLES: 250, // Cần 200 nến để tính MA200
  RSI_PERIOD: 14,
  EMA_PERIOD: 50,
  MA_PERIOD: 200,
  TP_PERCENT: 0.008, 
  SL_PERCENT: 0.004, 
  LEVERAGE: 50,
  INITIAL_BALANCE: 10000,
  FEE: 0.0004, 
  HEARTBEAT_MS: 10 * 60 * 1000, 
  COOLDOWN_MS: 60 * 1000, 
  REASONING_MS: 60 * 1000, 
};

// --- CHỈ BÁO CƠ BẢN ---
const calculateRSI = (candles: any[], period: number = 14) => {
  if (!candles || candles.length < period + 1) return 50;
  const prices = candles.map(c => Number(c.close));
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

const calculateMA = (candles: any[], period: number) => {
  if (!candles || candles.length < period) return 0;
  const slice = candles.slice(-period);
  return slice.reduce((acc, c) => acc + Number(c.close), 0) / period;
};

const calculateEMA = (candles: any[], period: number) => {
  if (!candles || candles.length < period) return 0;
  const k = 2 / (period + 1);
  let ema = Number(candles[0].close);
  for (let i = 1; i < candles.length; i++) ema = (Number(candles[i].close) - ema) * k + ema;
  return ema;
};

// --- KỸ THUẬT SMART MONEY CONCEPT (SMC) ---
const findOrderBlocks = (candles: any[], lookback: number = 20) => {
    const obs = { bullish: [] as any[], bearish: [] as any[] };
    if (candles.length < lookback + 2) return obs;
    const recent = candles.slice(-(lookback + 1), -1); 
    
    for (let i = 0; i < recent.length - 2; i++) {
        const c1 = recent[i], c2 = recent[i+1];
        if (!c1.isGreen && c2.isGreen && c2.close > c1.high) {
            obs.bullish.push({ top: Math.max(c1.open, c1.close), bottom: c1.low });
        }
        if (c1.isGreen && !c2.isGreen && c2.close < c1.low) {
            obs.bearish.push({ top: c1.high, bottom: Math.min(c1.open, c1.close) });
        }
    }
    return obs;
};

const findFVGs = (candles: any[], lookback: number = 20) => {
    const fvgs = { bullish: [] as any[], bearish: [] as any[] };
    if (candles.length < lookback + 2) return fvgs;
    const recent = candles.slice(-(lookback + 1), -1);
    
    for (let i = 0; i < recent.length - 2; i++) {
        const c1 = recent[i], c3 = recent[i+2];
        if (c1.high < c3.low) fvgs.bullish.push({ top: c3.low, bottom: c1.high });
        if (c1.low > c3.high) fvgs.bearish.push({ top: c1.low, bottom: c3.high });
    }
    return fvgs;
};

// ============================================================================
// 3. MÀN HÌNH SETUP & ĐĂNG NHẬP
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
    } catch (e: any) { setError("Lỗi: Không thể đọc cấu hình. Vui lòng kiểm tra lại Object."); }
  };

  return (
    <div className="min-h-screen bg-[#0b0e11] text-white flex flex-col items-center justify-center p-6 font-sans">
       <Database size={60} className="text-purple-500 mb-6 animate-pulse" />
       <h1 className="text-3xl font-black mb-3 text-center uppercase tracking-tighter">Kết nối Database</h1>
       <div className="w-full max-w-xl space-y-4">
         <textarea value={jsonInput} onChange={(e) => setJsonInput(e.target.value)} className="w-full h-48 bg-[#1e2329] border border-gray-700 rounded-3xl p-5 font-mono text-sm text-green-400 focus:border-purple-500 outline-none" placeholder={`{\n  apiKey: "AIzaSy...",\n  authDomain: "...",\n  projectId: "...",\n  appId: "..."\n}`} />
         {error && <p className="text-red-400 text-xs font-bold text-center">{error}</p>}
         <button onClick={handleSaveConfig} className="w-full bg-purple-600 hover:bg-purple-700 font-black py-4 rounded-xl transition-all shadow-lg active:scale-95 uppercase">Xác nhận Cấu hình</button>
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
    <div className="min-h-screen bg-[#0b0e11] flex items-center justify-center p-4 font-sans text-gray-100">
      <div className="bg-[#1e2329] p-8 rounded-[2rem] border border-gray-800 w-full max-w-md shadow-2xl relative">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-purple-500 via-blue-500 to-green-500"></div>
        <div className="flex justify-center mb-6"><div className="p-4 bg-purple-600 rounded-2xl shadow-xl"><ShieldCheck size={40} /></div></div>
        <h2 className="text-2xl font-black text-center mb-2 uppercase tracking-tighter">Bot Pro SMC (MTF)</h2>
        <form onSubmit={handleAuth} className="space-y-4">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required className="w-full bg-[#0b0e11] border border-gray-700 rounded-xl p-4 text-sm outline-none" placeholder="Địa chỉ Email" />
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} required className="w-full bg-[#0b0e11] border border-gray-700 rounded-xl p-4 text-sm outline-none" placeholder="Mật khẩu bảo mật" />
          {error && <p className="text-red-400 text-xs text-center font-bold">{error}</p>}
          <button type="submit" disabled={loading} className="w-full bg-purple-600 hover:bg-purple-700 font-black py-4 rounded-xl uppercase transition-all active:scale-95 mt-2">
            {loading ? 'ĐANG XỬ LÝ...' : (isLogin ? 'ĐĂNG NHẬP' : 'TẠO TÀI KHOẢN')}
          </button>
        </form>
        <button onClick={() => setIsLogin(!isLogin)} className="w-full mt-6 text-gray-500 text-xs hover:text-purple-400 uppercase font-bold">{isLogin ? "Đăng ký tài khoản mới" : "Quay lại đăng nhập"}</button>
      </div>
    </div>
  );
}

// ============================================================================
// 4. TRADING ENGINE
// ============================================================================
export default function BitcoinTradingBot() {
  if (!isFirebaseConfigured) return <SetupScreen />;

  const [user, setUser] = useState<User | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [currentPrice, setCurrentPrice] = useState(0);
  const [candles, setCandles] = useState<any[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [activeTab, setActiveTab] = useState<'LOGS' | 'HISTORY'>('LOGS');
  const [showSettings, setShowSettings] = useState(false);

  // States MTF & Indicators
  const [mtfTrends, setMtfTrends] = useState({ '15m': 'UNKNOWN', '1h': 'UNKNOWN', '4h': 'UNKNOWN', '1d': 'UNKNOWN' });
  const [indicators, setIndicators] = useState({ rsi: 50, ema50: 0, ma200: 0 });
  const mtfCandlesRef = useRef<Record<string, any[]>>({ '15m': [], '1h': [], '4h': [], '1d': [] });

  const [account, setAccount] = useState({ balance: CONFIG.INITIAL_BALANCE, pnlHistory: 0 });
  const [position, setPosition] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [tgConfig, setTgConfig] = useState({ token: '', chatId: '' });

  const logsEndRef = useRef<HTMLDivElement>(null);
  const tgConfigRef = useRef(tgConfig);
  const latestPriceRef = useRef(currentPrice);
  const latestAccountRef = useRef(account);
  
  const isProcessingRef = useRef(false);
  const lastTradeTimeRef = useRef<number>(0);
  const lastReasoningTimeRef = useRef<number>(0);

  useEffect(() => { tgConfigRef.current = tgConfig; }, [tgConfig]);
  useEffect(() => { latestPriceRef.current = currentPrice; }, [currentPrice]);
  useEffect(() => { latestAccountRef.current = account; }, [account]);

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

  // Động cơ dữ liệu Đa khung thời gian (MTF Engine)
  useEffect(() => {
    let ws: WebSocket;
    const intervals = ['1m', '15m', '1h', '4h', '1d'];
    
    const loadHistory = async () => {
        try {
            const fetches = intervals.map(inv =>
                fetch(`https://api.binance.com/api/v3/klines?symbol=${CONFIG.SYMBOL}&interval=${inv}&limit=${CONFIG.LIMIT_CANDLES}`).then(r => r.json())
            );
            const results = await Promise.all(fetches);

            const formatData = (data: any[]) => data.map((k: any) => ({
                time: Number(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), isGreen: parseFloat(k[4]) >= parseFloat(k[1])
            }));

            // Cập nhật M1
            const c1m = formatData(results[0]);
            setCandles(c1m);
            if (c1m.length > 0) setCurrentPrice(c1m[c1m.length - 1].close);

            // Cập nhật MTF
            mtfCandlesRef.current['15m'] = formatData(results[1]);
            mtfCandlesRef.current['1h'] = formatData(results[2]);
            mtfCandlesRef.current['4h'] = formatData(results[3]);
            mtfCandlesRef.current['1d'] = formatData(results[4]);
            
            updateMtfTrends(c1m.length > 0 ? c1m[c1m.length - 1].close : 0);
        } catch (e) { console.error("History fetch error"); }
    };

    const updateMtfTrends = (currentP: number) => {
        const newTrends: any = {};
        ['15m', '1h', '4h', '1d'].forEach(inv => {
            const c = mtfCandlesRef.current[inv];
            if (c && c.length > 0) {
                const ema = calculateEMA(c, CONFIG.EMA_PERIOD);
                // Trend được xác định bằng việc giá hiện tại nằm trên hay dưới EMA50 của khung đó
                newTrends[inv] = currentP > ema ? 'UP' : 'DOWN';
            } else {
                newTrends[inv] = 'UNKNOWN';
            }
        });
        setMtfTrends(newTrends);
    };

    loadHistory().then(() => {
        // Mở kết nối Multiplex WebSocket
        const streams = intervals.map(inv => `${CONFIG.SYMBOL.toLowerCase()}@kline_${inv}`).join('/');
        ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
        
        ws.onmessage = (e) => {
            try {
                const parsed = JSON.parse(e.data);
                if (!parsed || !parsed.data || !parsed.data.k) return;
                const data = parsed.data.k;
                const streamInv = data.i;
                const price = parseFloat(data.c);
                const candle = { time: Number(data.t), open: parseFloat(data.o), high: parseFloat(data.h), low: parseFloat(data.l), close: price, isGreen: price >= parseFloat(data.o) };

                if (streamInv === '1m') {
                    setCurrentPrice(price);
                    setCandles(prev => {
                        const lastIdx = prev.length - 1;
                        if (prev.length > 0 && prev[lastIdx].time === Number(data.t)) {
                            const newArr = [...prev]; newArr[lastIdx] = candle; return newArr;
                        } else { return [...prev.slice(-(CONFIG.LIMIT_CANDLES - 1)), candle]; }
                    });
                    updateMtfTrends(price);
                } else {
                    // Update MTF Cache Background
                    const mtfArr = mtfCandlesRef.current[streamInv];
                    if (mtfArr && mtfArr.length > 0) {
                        const lastIdx = mtfArr.length - 1;
                        if (mtfArr[lastIdx].time === Number(data.t)) mtfArr[lastIdx] = candle;
                        else { mtfArr.push(candle); if (mtfArr.length > CONFIG.LIMIT_CANDLES) mtfArr.shift(); }
                    }
                }
            } catch (err) {}
        };
    });
    return () => ws?.close();
  }, []);

  // Tính toán Indicator riêng để render UI mượt mà
  useEffect(() => {
      if (candles.length > 0) {
          setIndicators({
              rsi: calculateRSI(candles, CONFIG.RSI_PERIOD),
              ema50: calculateEMA(candles, CONFIG.EMA_PERIOD),
              ma200: calculateMA(candles, CONFIG.MA_PERIOD)
          });
      }
  }, [candles]);

  // Telegram Heartbeat (Chuẩn xác 10 phút)
  useEffect(() => {
    if (!isRunning || !user) return;
    const sendTelegram = async (text: string) => {
      const { token, chatId } = tgConfigRef.current;
      if (!token || !chatId) return;
      try { await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }) }); } catch (e) {}
    };

    const heartbeat = setInterval(() => {
      const msg = `💓 <b>TRẠNG THÁI BOT SMC</b>\n• Giá: ${latestPriceRef.current.toLocaleString()} USD\n• Ví: ${latestAccountRef.current.balance.toFixed(2)} USDT\n• Trạng thái: 🟢 Quét thị trường bình thường`;
      sendTelegram(msg);
      addLog("Đã gửi trạng thái an toàn về Telegram (Heartbeat 10m).", "info");
    }, CONFIG.HEARTBEAT_MS);
    
    return () => clearInterval(heartbeat);
  }, [isRunning, user]);

  // ============================================================================
  // LOGIC VÀO LỆNH KHẮT KHE (MTF + SMC + EMA/MA + RSI) & NHẬT KÝ AI
  // ============================================================================
  useEffect(() => {
    if (!isRunning || !user || currentPrice === 0 || candles.length < CONFIG.MA_PERIOD) return;

    const now = Date.now();
    const ema50 = indicators.ema50;
    const ma200 = indicators.ma200;
    const rsi = indicators.rsi;
    
    // Thống kê sức mạnh MTF
    const upCount = Object.values(mtfTrends).filter(t => t === 'UP').length;
    const downCount = Object.values(mtfTrends).filter(t => t === 'DOWN').length;

    // Xử lý đóng lệnh nếu đang giữ Position
    if (position) {
      if (isProcessingRef.current) return;
      const isL = String(position.type) === 'LONG';
      const entry = Number(position.entry);
      const size = Number(position.size);
      const tp = Number(position.tp);
      const sl = Number(position.sl);
      const pnl = isL ? (currentPrice - entry) * (size / entry) : (entry - currentPrice) * (size / entry);
      
      let r = '';
      if ((isL && currentPrice >= tp) || (!isL && currentPrice <= tp)) r = 'TAKE PROFIT';
      if ((isL && currentPrice <= sl) || (!isL && currentPrice >= sl)) r = 'STOP LOSS';
      
      if (r) {
         isProcessingRef.current = true; 
         handleCloseOrder(r, pnl);
      } else if (now - lastReasoningTimeRef.current >= CONFIG.REASONING_MS) {
         lastReasoningTimeRef.current = now;
         addLog(`Đang gồng lệnh ${position.type} (PnL: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}). Chờ chạm TP/SL...`, 'analysis');
      }
      return;
    } 
    
    // Nhịp suy nghĩ AI (1 phút/lần) nếu chưa có lệnh
    if (now - lastReasoningTimeRef.current >= CONFIG.REASONING_MS) {
        lastReasoningTimeRef.current = now;
        const trendStr = `Đồng thuận MTF: ${upCount}/4 Khung Tăng.`;
        
        if (currentPrice > ema50 && ema50 > ma200 && upCount >= 2) {
            if (rsi > 55) addLog(`${trendStr} Xu hướng M1 Tăng mạnh. RSI cao (${rsi.toFixed(1)}). Đang rình nhịp pullback về Bullish OB.`, 'analysis');
            else addLog(`${trendStr} Xu hướng M1 Tăng. RSI hạ nhiệt (${rsi.toFixed(1)}). Đã sẵn sàng bắt đáy tại SMC Setup.`, 'analysis');
        } else if (currentPrice < ema50 && ema50 < ma200 && downCount >= 2) {
            if (rsi < 45) addLog(`${trendStr} Xu hướng M1 Giảm mạnh. RSI thấp (${rsi.toFixed(1)}). Đang rình nhịp hồi lên Bearish OB.`, 'analysis');
            else addLog(`${trendStr} Xu hướng M1 Giảm. RSI vùng bán đẹp (${rsi.toFixed(1)}). Đã sẵn sàng Short tại SMC Setup.`, 'analysis');
        } else {
            addLog(`Khung thời gian đang nhiễu (Lớn/Nhỏ lệch pha). Đứng ngoài quan sát bảo toàn vốn.`, 'analysis');
        }
    }

    // Kiểm tra Cooldown hoặc Đang bận
    if (isProcessingRef.current || now - lastTradeTimeRef.current < CONFIG.COOLDOWN_MS) return;

    // Quét cấu trúc SMC
    const obs = findOrderBlocks(candles, 20);
    const fvgs = findFVGs(candles, 20);

    // 1. ĐIỀU KIỆN LONG KHẮT KHE
    // M1 Tăng + Ít nhất 2/4 Khung lớn Tăng
    const isMacroBullish = currentPrice > ema50 && ema50 > ma200 && upCount >= 2;
    const touchBullishOB = obs.bullish.some((ob: any) => currentPrice <= ob.top && currentPrice >= ob.bottom);
    const touchBullishFVG = fvgs.bullish.some((fvg: any) => currentPrice <= fvg.top && currentPrice >= fvg.bottom);
    const isRsiBullish = rsi >= 30 && rsi <= 55; // Không quá mua mới Long

    if (isMacroBullish && (touchBullishOB || touchBullishFVG) && isRsiBullish) {
        isProcessingRef.current = true;
        const setupName = touchBullishOB ? "SMC: Chạm Bullish OB" : "SMC: Lấp Bullish FVG";
        handleOpenOrder('LONG', rsi.toFixed(1), setupName, `${upCount}/4`);
        return;
    }

    // 2. ĐIỀU KIỆN SHORT KHẮT KHE
    // M1 Giảm + Ít nhất 2/4 Khung lớn Giảm
    const isMacroBearish = currentPrice < ema50 && ema50 < ma200 && downCount >= 2;
    const touchBearishOB = obs.bearish.some((ob: any) => currentPrice >= ob.bottom && currentPrice <= ob.top);
    const touchBearishFVG = fvgs.bearish.some((fvg: any) => currentPrice >= fvg.bottom && currentPrice <= fvg.top);
    const isRsiBearish = rsi >= 45 && rsi <= 70; // Không quá bán mới Short

    if (isMacroBearish && (touchBearishOB || touchBearishFVG) && isRsiBearish) {
        isProcessingRef.current = true;
        const setupName = touchBearishOB ? "SMC: Chạm Bearish OB" : "SMC: Lấp Bearish FVG";
        handleOpenOrder('SHORT', rsi.toFixed(1), setupName, `${downCount}/4`);
        return;
    }
    
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPrice, isRunning, position, candles, mtfTrends]);

  const handleOpenOrder = async (type: 'LONG' | 'SHORT', rsiVal: string, setupName: string, mtfScore: string) => {
    if (!user) { isProcessingRef.current = false; return; }
    
    const margin = account.balance;
    const size = margin * CONFIG.LEVERAGE;
    const fee = size * CONFIG.FEE;
    const tp = type === 'LONG' ? currentPrice * (1 + CONFIG.TP_PERCENT) : currentPrice * (1 - CONFIG.TP_PERCENT);
    const sl = type === 'LONG' ? currentPrice * (1 - CONFIG.SL_PERCENT) : currentPrice * (1 + CONFIG.SL_PERCENT);

    const details = { type: String(type), entry: Number(currentPrice), margin: Number(margin - fee), size: Number(size), tp: Number(tp), sl: Number(sl), openFee: Number(fee), time: Date.now(), signalDetail: { rsi: String(rsiVal), setup: setupName, mtf: mtfScore } };

    try {
      await setDoc(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'account', 'data'), { balance: 0 }, { merge: true });
      await setDoc(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'position', 'active'), { active: true, details });
      
      const { token, chatId } = tgConfigRef.current;
      if (token && chatId) fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: `🚀 <b>BOT MỞ ${type}</b>\n• Giá: ${currentPrice.toLocaleString()}\n• Tín hiệu: ${setupName}\n• MTF Score: ${mtfScore}\n• RSI: ${rsiVal}`, parse_mode: 'HTML' }) });
      addLog(`VÀO ${type}: Tín hiệu ${setupName} chuẩn xác.`, 'success');
    } catch (e: any) {
      isProcessingRef.current = false;
      addLog(`Lỗi mở lệnh: ${e.message}`, 'danger');
    }
  };

  const handleCloseOrder = async (reason: string, pnl: number) => {
    if (!user || !position) { isProcessingRef.current = false; return; }
    
    lastTradeTimeRef.current = Date.now(); // Kích hoạt Cooldown 1 phút
    const fee = Number(position.size) * CONFIG.FEE;
    const net = Number(pnl) - fee - Number(position.openFee);
    const tradeId = Date.now().toString();

    try {
      await setDoc(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'history', tradeId), { id: tradeId, type: String(position.type), entry: Number(position.entry), exit: Number(currentPrice), pnl: net, reason: String(reason), time: Date.now(), signalDetail: position.signalDetail || null });
      await setDoc(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'account', 'data'), { balance: account.balance + Number(position.margin) + (Number(pnl) - fee), pnlHistory: account.pnlHistory + net }, { merge: true });
      await setDoc(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'position', 'active'), { active: false });

      const icon = net > 0 ? '✅' : '❌';
      const { token, chatId } = tgConfigRef.current;
      if (token && chatId) fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text: `${icon} <b>ĐÓNG ${position.type}</b>\n• PnL: <b>${net > 0 ? '+' : ''}${net.toFixed(2)} USDT</b>\n• Lý do: ${reason}`, parse_mode: 'HTML' }) });
      addLog(`ĐÓNG ${position.type}: ${net.toFixed(2)} USDT (${reason})`, net > 0 ? 'success' : 'danger');
    } catch (e: any) {
      isProcessingRef.current = false;
      addLog(`Lỗi đóng lệnh: ${e.message}`, 'danger');
    }
  };

  const addLog = (msg: string, type: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [{ msg: String(msg), type: String(type), time: String(time) }, ...prev.slice(0, 49)]);
  };

  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs, activeTab]);

  if (loadingAuth) return <div className="min-h-screen bg-[#0b0e11] flex items-center justify-center"><Activity className="animate-spin text-purple-500" size={48}/></div>;
  if (!user) return <AuthScreen />;

  const renderCandles = () => {
    if (!candles || candles.length === 0) return null;
    const displayCandles = candles.slice(-60); // Chỉ render 60 nến gần nhất cho UI đẹp
    const maxP = Math.max(...displayCandles.map(c => Number(c.high) || 0));
    const minP = Math.min(...displayCandles.map(c => Number(c.low) || 0));
    const range = maxP - minP || 1;

    return (
      <div className="flex items-end justify-between h-full w-full px-1 relative">
        {displayCandles.map((c, i) => {
          const bodyHeight = (Math.abs(Number(c.open) - Number(c.close)) / range) * 100;
          const bodyBottom = ((Math.min(Number(c.open), Number(c.close)) - minP) / range) * 100;
          const wickHeight = ((Number(c.high) - Number(c.low)) / range) * 100;
          const wickBottom = ((Number(c.low) - minP) / range) * 100;
          const isGreen = Boolean(c.isGreen);
          
          return (
            <div key={i} className="flex-1 h-full relative mx-[1px] group">
              <div className={`absolute left-1/2 -translate-x-1/2 w-[1px] ${isGreen ? 'bg-green-500/50' : 'bg-red-500/50'}`} style={{ height: `${wickHeight}%`, bottom: `${wickBottom}%` }} />
              <div className={`absolute left-0 w-full rounded-sm ${isGreen ? 'bg-green-500' : 'bg-red-500'}`} style={{ height: `${Math.max(bodyHeight, 2)}%`, bottom: `${bodyBottom}%` }} />
            </div>
          );
        })}
      </div>
    );
  };

  const { pnl: uPnl, roe: uRoe } = position ? (() => {
      const pType = String(position.type);
      const pEntry = Number(position.entry) || 1;
      const pSize = Number(position.size) || 0;
      const pMargin = Number(position.margin) || 1;
      const p = pType === 'LONG' ? (currentPrice - pEntry) * (pSize / pEntry) : (pEntry - currentPrice) * (pSize / pEntry);
      return { pnl: p, roe: (p / pMargin) * 100 };
  })() : { pnl: 0, roe: 0 };

  return (
    <div className="min-h-screen bg-[#0b0e11] text-gray-100 font-sans p-3 md:p-6 flex flex-col gap-4">
      {/* SETTINGS MODAL */}
      {showSettings && (
        <div className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4 backdrop-blur-md">
          <div className="bg-[#1e2329] p-6 rounded-3xl border border-gray-700 max-w-md w-full shadow-2xl">
              <h2 className="text-xl font-black mb-4 flex items-center gap-2 uppercase tracking-tighter"><Settings className="text-purple-500"/> Cấu hình Cloud</h2>
              <div className="space-y-4">
                  <input value={tgConfig.token} onChange={e => setTgConfig({...tgConfig, token: e.target.value})} className="w-full bg-[#0b0e11] border border-gray-700 rounded-xl p-3 text-sm text-white" placeholder="Bot Token Telegram" />
                  <input value={tgConfig.chatId} onChange={e => setTgConfig({...tgConfig, chatId: e.target.value})} className="w-full bg-[#0b0e11] border border-gray-700 rounded-xl p-3 text-sm text-white" placeholder="Chat ID" />
              </div>
              <div className="mt-6 flex gap-3">
                  <button onClick={() => setShowSettings(false)} className="flex-1 py-3 text-gray-400 font-bold hover:text-white">HỦY</button>
                  <button onClick={async () => {
                      await setDoc(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'account', 'data'), { tgToken: tgConfig.token, tgChatId: tgConfig.chatId }, { merge: true });
                      setShowSettings(false); addLog("Đã lưu cấu hình.", "success");
                  }} className="flex-1 py-3 bg-purple-600 rounded-xl text-white font-black hover:bg-purple-700">LƯU CÀI ĐẶT</button>
              </div>
          </div>
        </div>
      )}

      {/* HEADER */}
      <div className="flex flex-wrap justify-between items-center bg-[#1e2329] p-4 sm:p-5 rounded-3xl border border-gray-800 shadow-2xl gap-4">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-purple-600 rounded-2xl text-white shadow-xl shadow-purple-900/30"><Target size={24} /></div>
          <div>
            <h1 className="text-sm sm:text-lg font-black uppercase flex items-center gap-2">SMC EXPERT BOT <span className="text-[9px] bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full animate-pulse border border-green-500/30">MTF FILTER</span></h1>
            <div className="flex items-center gap-2 mt-1">
               <button onClick={() => setShowSettings(true)} className="text-[9px] text-gray-500 hover:text-white uppercase font-black transition-colors">Cài đặt</button>
               <div className="w-1 h-1 bg-gray-700 rounded-full"></div>
               <button onClick={() => signOut(auth)} className="text-[9px] text-red-500 hover:text-red-400 uppercase font-black transition-colors">Đăng xuất</button>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-right hidden md:block">
            <p className="text-[9px] text-gray-500 font-black uppercase">Live Price</p>
            <p className="text-xl font-mono font-black text-green-400 leading-none">${Number(currentPrice).toLocaleString()}</p>
          </div>
          <button onClick={() => setIsRunning(!isRunning)} className={`px-8 py-3 rounded-2xl font-black transition-all shadow-xl active:scale-95 uppercase ${isRunning ? 'bg-red-500 text-white' : 'bg-green-500 text-[#0b0e11]'}`}>
            {isRunning ? 'Dừng Bot' : 'Chạy Bot'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-8 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <div className="bg-[#1e2329] p-6 rounded-3xl border border-gray-800 shadow-xl relative group overflow-hidden">
                <div className="absolute -bottom-4 -right-4 opacity-5"><Wallet size={120}/></div>
                <span className="text-[10px] text-gray-500 uppercase font-black tracking-widest block mb-1">Ví USDT (Mây)</span>
                <p className="text-4xl font-mono font-black text-white tracking-tighter">${Number(account.balance).toLocaleString()}</p>
                <div className="flex items-center gap-2 mt-4 text-[9px] text-gray-500 font-black uppercase tracking-widest bg-black/30 w-fit px-3 py-1 rounded-full border border-gray-800">
                   <Activity size={12} className={candles.length < CONFIG.MA_PERIOD ? "text-yellow-500" : "text-green-500"}/> 
                   {candles.length < CONFIG.MA_PERIOD ? `Data Loading: ${candles.length}/${CONFIG.MA_PERIOD}` : "Filters Active"}
                </div>
            </div>
            <div className={`bg-[#1e2329] p-6 rounded-3xl border transition-all duration-700 shadow-xl relative ${position ? 'border-blue-500 ring-4 ring-blue-500/10' : 'border-gray-800 opacity-50'}`}>
                <span className="text-[10px] text-gray-500 uppercase font-black tracking-widest block mb-1">Lệnh Đang Mở</span>
                {position ? (
                  <div className="mt-2">
                    <div className="flex justify-between items-end">
                      <p className={`text-3xl font-black ${String(position.type) === 'LONG' ? 'text-green-400' : 'text-red-400'}`}>{String(position.type)} x50</p>
                      <p className={`text-sm font-bold ${Number(uPnl) >= 0 ? 'text-green-400' : 'text-red-400'}`}>{Number(uPnl) > 0 ? '+' : ''}{Number(uPnl).toFixed(2)} ({Number(uRoe).toFixed(1)}%)</p>
                    </div>
                    <div className="mt-4 pt-4 border-t border-gray-800 flex justify-between text-[10px] text-gray-500 font-bold uppercase">
                       <span>Entry: ${Number(position.entry).toLocaleString()}</span>
                       <span>TP: ${Number(position.tp).toLocaleString()}</span>
                    </div>
                  </div>
                ) : <p className="text-3xl font-black text-gray-700 mt-2 uppercase">SMC Scanning...</p>}
            </div>
          </div>

          <div className="bg-[#1e2329] p-5 rounded-3xl border border-gray-800 h-[380px] flex flex-col shadow-inner relative overflow-hidden">
             <div className="flex justify-between mb-4 items-center px-2 z-10 flex-wrap gap-2">
                <h3 className="text-xs font-black text-gray-400 uppercase flex items-center gap-2 tracking-widest"><BarChart2 size={16}/> Market Feed 1m</h3>
                <div className="flex gap-2">
                   {['15m', '1h', '4h', '1d'].map(tf => {
                      const trend = mtfTrends[tf as keyof typeof mtfTrends];
                      const isUp = trend === 'UP';
                      return (
                        <div key={tf} className={`bg-[#0b0e11] px-2 py-1 rounded-lg text-[8px] font-black uppercase tracking-widest border ${isUp ? 'text-green-500 border-green-500/20' : trend === 'DOWN' ? 'text-red-500 border-red-500/20' : 'text-gray-500 border-gray-800'}`}>
                           {tf} {isUp ? '↑' : trend === 'DOWN' ? '↓' : '-'}
                        </div>
                      );
                   })}
                </div>
             </div>
             <div className="flex-1 w-full bg-[#0b0e11]/50 rounded-2xl border border-gray-800/30 relative p-4 group">
                <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)', backgroundSize: '40px 40px' }}></div>
                {renderCandles()}
             </div>
          </div>
        </div>

        <div className="lg:col-span-4 flex flex-col h-[700px]">
          <div className="bg-[#1e2329] rounded-[2.5rem] border border-gray-800 flex flex-col flex-1 overflow-hidden shadow-2xl relative">
             <div className="flex bg-[#252a30] p-1.5 m-3 rounded-3xl border border-gray-800/50 shadow-inner">
                <button onClick={() => setActiveTab('LOGS')} className={`flex-1 py-3 text-[11px] font-black tracking-widest transition-all rounded-2xl uppercase ${activeTab === 'LOGS' ? 'bg-[#1e2329] text-blue-400 shadow-xl' : 'text-gray-500 hover:text-gray-400'}`}>Nhật ký AI</button>
                <button onClick={() => setActiveTab('HISTORY')} className={`flex-1 py-3 text-[11px] font-black tracking-widest transition-all rounded-2xl uppercase ${activeTab === 'HISTORY' ? 'bg-[#1e2329] text-yellow-400 shadow-xl' : 'text-gray-500 hover:text-gray-400'}`}>Lịch sử</button>
             </div>

             <div className="flex-1 overflow-y-auto p-4 bg-[#0b0e11] font-mono text-[10px] custom-scrollbar">
                {activeTab === 'LOGS' ? (
                    <div className="space-y-3">
                        {logs.length === 0 && <p className="text-gray-700 text-center italic mt-10 uppercase tracking-widest">Đang kiểm tra FVG/OB...</p>}
                        {logs.map((log, i) => (
                          <div key={i} className={`border-l-2 pl-3 py-2 leading-relaxed rounded-r-lg bg-gray-900/20 ${String(log.type) === 'success' ? 'border-green-500 text-green-300' : String(log.type) === 'danger' ? 'border-red-500 text-red-300' : String(log.type) === 'analysis' ? 'border-blue-500 text-blue-300 italic' : 'border-gray-700 text-gray-500'}`}>
                            <span className="text-[8px] text-gray-600 font-bold block mb-0.5">{String(log.time)}</span>
                            {String(log.msg)}
                          </div>
                        ))}
                        <div ref={logsEndRef}/>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {history.length === 0 && <p className="text-gray-700 text-center italic mt-10 uppercase tracking-widest opacity-30">Chưa có giao dịch chuẩn</p>}
                        {history.map((t, i) => (
                            <div key={i} className="bg-[#1e2329]/50 p-4 rounded-3xl border border-gray-800 shadow-lg border-l-4 border-l-purple-500 transition-all hover:bg-[#1e2329]">
                                <div className="flex justify-between items-start">
                                  <div>
                                    <p className={`font-black text-sm uppercase tracking-tighter ${Number(t.pnl) > 0 ? 'text-green-400' : 'text-red-400'}`}>{String(t.type)} {Number(t.pnl) > 0 ? '+' : ''}{Number(t.pnl).toFixed(2)}</p>
                                    <p className="text-[8px] text-gray-600 mt-1 font-black uppercase tracking-widest">{new Date(Number(t.time) || Date.now()).toLocaleString()}</p>
                                  </div>
                                  <div className="text-right">
                                     <p className="text-[9px] text-gray-500 font-black italic uppercase">{String(t.reason)}</p>
                                     <p className="text-[8px] text-gray-700 mt-1 font-bold">E: {Number(t.entry)} | X: {Number(t.exit)}</p>
                                  </div>
                                </div>
                                {t.signalDetail && (
                                  <div className="mt-3 pt-3 border-t border-gray-800 grid grid-cols-2 gap-1 text-[8px] uppercase font-black text-gray-600">
                                     <div className="flex items-center gap-1"><Zap size={10} className="text-yellow-500"/> MTF: {String(t.signalDetail.mtf)}</div>
                                     <div className="text-right truncate text-blue-400">{String(t.signalDetail.setup)}</div>
                                  </div>
                                )}
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