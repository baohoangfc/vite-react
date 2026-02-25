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
  updateDoc,
  deleteField
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
  return 'trading-bot-v3-smc-multipair';
};
const APP_ID = getSafeAppId();

// ============================================================================
// 2. CẤU HÌNH BOT ĐA CẶP (MULTI-PAIR)
// ============================================================================
const SYMBOLS = ['BTCUSDT', 'PAXGUSDT']; // Chạy đồng thời Bitcoin & Vàng
const INTERVALS = ['1m', '15m', '1h', '4h', '1d'];

const CONFIG = {
  LIMIT_CANDLES: 250, 
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
        if (!c1.isGreen && c2.isGreen && c2.close > c1.high) obs.bullish.push({ top: Math.max(c1.open, c1.close), bottom: c1.low });
        if (c1.isGreen && !c2.isGreen && c2.close < c1.low) obs.bearish.push({ top: c1.high, bottom: Math.min(c1.open, c1.close) });
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
        <h2 className="text-2xl font-black text-center mb-2 uppercase tracking-tighter">Bot Đa Cặp (SMC)</h2>
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
// 4. TRADING ENGINE - ĐA CẶP ĐỒNG THỜI
// ============================================================================
export default function BitcoinTradingBot() {
  if (!isFirebaseConfigured) return <SetupScreen />;

  const [user, setUser] = useState<User | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [viewSymbol, setViewSymbol] = useState(SYMBOLS[0]);
  const [activeTab, setActiveTab] = useState<'LOGS' | 'HISTORY'>('LOGS');
  const [showSettings, setShowSettings] = useState(false);

  // States Đa Cặp (Maps)
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [candles, setCandles] = useState<Record<string, any[]>>({});
  const [mtfTrends, setMtfTrends] = useState<Record<string, any>>({});
  const [indicators, setIndicators] = useState<Record<string, any>>({});
  const [positions, setPositions] = useState<Record<string, any>>({}); // { BTCUSDT: {...}, PAXGUSDT: {...} }
  
  const [account, setAccount] = useState({ balance: CONFIG.INITIAL_BALANCE, pnlHistory: 0 });
  const [history, setHistory] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [tgConfig, setTgConfig] = useState({ token: '', chatId: '' });

  // Lõi Refs riêng cho từng Cặp
  const mtfCandlesRef = useRef<Record<string, Record<string, any[]>>>({});
  const isProcessingRef = useRef<Record<string, boolean>>({});
  const lastTradeTimeRef = useRef<Record<string, number>>({});
  const lastReasoningTimeRef = useRef<Record<string, number>>({});
  
  const logsEndRef = useRef<HTMLDivElement>(null);
  const tgConfigRef = useRef(tgConfig);

  // Khởi tạo Refs an toàn
  if (Object.keys(isProcessingRef.current).length === 0) {
      SYMBOLS.forEach(s => {
          isProcessingRef.current[s] = false;
          lastTradeTimeRef.current[s] = 0;
          lastReasoningTimeRef.current[s] = 0;
          mtfCandlesRef.current[s] = { '15m': [], '1h': [], '4h': [], '1d': [] };
      });
  }

  useEffect(() => { tgConfigRef.current = tgConfig; }, [tgConfig]);

  // Auth Init
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => { setUser(u); setLoadingAuth(false); });
    return () => unsub();
  }, []);

  // Database Sync
  useEffect(() => {
    if (!user) return;
    const userRef = doc(db, 'artifacts', APP_ID, 'users', user.uid, 'account', 'data');
    const posRef = doc(db, 'artifacts', APP_ID, 'users', user.uid, 'trading', 'positions');
    const histCol = collection(db, 'artifacts', APP_ID, 'users', user.uid, 'history');

    const unsubAcc = onSnapshot(userRef, (d) => {
      if (d.exists()) {
        const data = d.data();
        setAccount({ balance: Number(data.balance) || 0, pnlHistory: Number(data.pnlHistory) || 0 });
        setTgConfig({ token: String(data.tgToken || ''), chatId: String(data.tgChatId || '') });
      } else setDoc(userRef, { balance: CONFIG.INITIAL_BALANCE, pnlHistory: 0 });
    });

    const unsubPos = onSnapshot(posRef, (d) => {
      if (d.exists()) {
          const data = d.data();
          const activePos: any = {};
          Object.keys(data).forEach(k => { if (data[k]) activePos[k] = data[k]; });
          setPositions(activePos);
      } else {
          setDoc(posRef, {}); // Init empty map
          setPositions({});
      }
      SYMBOLS.forEach(sym => { isProcessingRef.current[sym] = false; });
    });

    const unsubHist = onSnapshot(histCol, (s) => {
      const list: any[] = [];
      s.forEach(docSnap => list.push(docSnap.data()));
      setHistory(list.sort((a, b) => (Number(b.time) || 0) - (Number(a.time) || 0)));
    });

    return () => { unsubAcc(); unsubPos(); unsubHist(); };
  }, [user]);

  // Data Fetch Đa Khung & Đa Cặp
  useEffect(() => {
    let ws: WebSocket;
    let isMounted = true;
    
    const loadHistory = async () => {
        try {
            const allFetches: Promise<any>[] = [];
            SYMBOLS.forEach(sym => {
                INTERVALS.forEach(inv => {
                    allFetches.push(
                        fetch(`https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${inv}&limit=${CONFIG.LIMIT_CANDLES}`)
                        .then(r => { if (!r.ok) throw new Error("API Error"); return r.json(); })
                        .then(data => ({ sym, inv, data }))
                    );
                });
            });
            
            const results = await Promise.all(allFetches);
            if (!isMounted) return;

            const formatData = (data: any[]) => data.map((k: any) => ({
                time: Number(k[0]), open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), isGreen: parseFloat(k[4]) >= parseFloat(k[1])
            }));

            const initCandles: any = {};
            const initPrices: any = {};

            results.forEach(res => {
                const formatted = formatData(res.data);
                if (res.inv === '1m') {
                    initCandles[res.sym] = formatted;
                    if (formatted.length > 0) initPrices[res.sym] = formatted[formatted.length - 1].close;
                } else {
                    mtfCandlesRef.current[res.sym][res.inv] = formatted;
                }
            });

            setCandles(initCandles);
            setPrices(initPrices);
            SYMBOLS.forEach(sym => updateMtfTrends(sym, initPrices[sym]));
        } catch (e) { 
            if (isMounted) console.error("History fetch error", e); 
        }
    };

    const updateMtfTrends = (sym: string, currentP: number) => {
        setMtfTrends(prev => {
            const newTrends: any = {};
            ['15m', '1h', '4h', '1d'].forEach(inv => {
                const c = mtfCandlesRef.current[sym][inv];
                if (c && c.length > 0) {
                    const ema = calculateEMA(c, CONFIG.EMA_PERIOD);
                    newTrends[inv] = currentP > ema ? 'UP' : 'DOWN';
                } else newTrends[inv] = 'UNKNOWN';
            });
            return { ...prev, [sym]: newTrends };
        });
    };

    loadHistory().then(() => {
        if (!isMounted) return;
        const streams = SYMBOLS.flatMap(sym => INTERVALS.map(inv => `${sym.toLowerCase()}@kline_${inv}`)).join('/');
        ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);
        
        ws.onmessage = (e) => {
            try {
                const parsed = JSON.parse(e.data);
                if (!parsed || !parsed.data || !parsed.data.k) return;
                const data = parsed.data.k;
                const streamInv = data.i;
                const sym = data.s.toUpperCase();
                const price = parseFloat(data.c);
                const candle = { time: Number(data.t), open: parseFloat(data.o), high: parseFloat(data.h), low: parseFloat(data.l), close: price, isGreen: price >= parseFloat(data.o) };

                if (streamInv === '1m') {
                    setPrices(prev => ({ ...prev, [sym]: price }));
                    setCandles(prev => {
                        const symCands = prev[sym] || [];
                        const lastIdx = symCands.length - 1;
                        let newArr;
                        if (symCands.length > 0 && symCands[lastIdx].time === Number(data.t)) {
                            newArr = [...symCands]; newArr[lastIdx] = candle;
                        } else {
                            newArr = [...symCands.slice(-(CONFIG.LIMIT_CANDLES - 1)), candle];
                        }
                        return { ...prev, [sym]: newArr };
                    });
                    updateMtfTrends(sym, price);
                } else {
                    const mtfArr = mtfCandlesRef.current[sym][streamInv];
                    if (mtfArr && mtfArr.length > 0) {
                        const lastIdx = mtfArr.length - 1;
                        if (mtfArr[lastIdx].time === Number(data.t)) mtfArr[lastIdx] = candle;
                        else { mtfArr.push(candle); if (mtfArr.length > CONFIG.LIMIT_CANDLES) mtfArr.shift(); }
                    }
                }
            } catch (err) {}
        };
    });
    return () => { isMounted = false; ws?.close(); };
  }, []);

  // Tính toán Indicator riêng để render UI mượt mà
  useEffect(() => {
      const newInds: any = {};
      SYMBOLS.forEach(sym => {
          if (candles[sym] && candles[sym].length > 0) {
              newInds[sym] = {
                  rsi: calculateRSI(candles[sym], CONFIG.RSI_PERIOD),
                  ema50: calculateEMA(candles[sym], CONFIG.EMA_PERIOD),
                  ma200: calculateMA(candles[sym], CONFIG.MA_PERIOD)
              };
          }
      });
      setIndicators(newInds);
  }, [candles]);

  const sendTelegram = async (text: string) => {
    const { token, chatId } = tgConfigRef.current;
    if (!token || !chatId) return;
    try { await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }) }); } catch (e) {}
  };

  const addLog = (msg: string, type: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [{ msg: String(msg), type: String(type), time: String(time) }, ...prev.slice(0, 49)]);
  };

  // Telegram Heartbeat
  useEffect(() => {
    if (!isRunning || !user) return;
    const heartbeat = setInterval(() => {
      const activeText = Object.keys(positions).length > 0 ? `Giữ: ${Object.keys(positions).join(', ')}` : 'Đang chờ tín hiệu';
      const msg = `💓 <b>NHỊP ĐẬP BOT ĐA CẶP</b>\n• Tín hiệu: ${activeText}\n• Ví: ${latestAccountRef.current.balance.toFixed(2)} USDT\n• Trạng thái: 🟢 Quét 2 mã song song bình thường`;
      sendTelegram(msg);
      addLog("[SYSTEM] Đã gửi trạng thái an toàn về Telegram (Heartbeat).", "info");
    }, CONFIG.HEARTBEAT_MS);
    return () => clearInterval(heartbeat);
  }, [isRunning, user, positions]);

  // ============================================================================
  // LOGIC VÀO LỆNH KHẮT KHE (LẶP QUA TỪNG MÃ)
  // ============================================================================
  useEffect(() => {
    if (!isRunning || !user) return;
    const now = Date.now();

    SYMBOLS.forEach(sym => {
        const currentPrice = prices[sym];
        const symCandles = candles[sym];
        const position = positions[sym];
        const symInds = indicators[sym];
        const symTrends = mtfTrends[sym];

        if (!currentPrice || !symCandles || symCandles.length < CONFIG.MA_PERIOD || !symInds || !symTrends) return;

        const ema50 = symInds.ema50;
        const ma200 = symInds.ma200;
        const rsi = symInds.rsi;
        const upCount = Object.values(symTrends).filter(t => t === 'UP').length;
        const downCount = Object.values(symTrends).filter(t => t === 'DOWN').length;

        // Quản lý Đóng lệnh
        if (position) {
          if (isProcessingRef.current[sym]) return;
          const isL = String(position.type) === 'LONG';
          const pnl = isL ? (currentPrice - position.entry) * (position.size / position.entry) : (position.entry - currentPrice) * (position.size / position.entry);
          
          let r = '';
          if ((isL && currentPrice >= position.tp) || (!isL && currentPrice <= position.tp)) r = 'TAKE PROFIT';
          if ((isL && currentPrice <= position.sl) || (!isL && currentPrice >= position.sl)) r = 'STOP LOSS';
          
          if (r) {
             isProcessingRef.current[sym] = true; 
             handleCloseOrder(sym, r, pnl);
          } else if (now - lastReasoningTimeRef.current[sym] >= CONFIG.REASONING_MS) {
             lastReasoningTimeRef.current[sym] = now;
             addLog(`[${sym}] Đang gồng lệnh ${position.type} (PnL: ${pnl > 0 ? '+' : ''}${pnl.toFixed(2)}). Chờ chạm TP/SL...`, 'analysis');
          }
          return;
        } 
        
        // Suy nghĩ AI khi chưa có lệnh
        if (now - lastReasoningTimeRef.current[sym] >= CONFIG.REASONING_MS) {
            lastReasoningTimeRef.current[sym] = now;
            const trendStr = `Đồng thuận MTF: ${upCount}/4 Khung Tăng.`;
            if (currentPrice > ema50 && ema50 > ma200 && upCount >= 2) {
                if (rsi > 55) addLog(`[${sym}] ${trendStr} Xu hướng M1 Tăng mạnh. RSI cao (${rsi.toFixed(1)}). Đang rình nhịp pullback.`, 'analysis');
                else addLog(`[${sym}] ${trendStr} Xu hướng M1 Tăng. Đã sẵn sàng bắt đáy tại SMC Setup.`, 'analysis');
            } else if (currentPrice < ema50 && ema50 < ma200 && downCount >= 2) {
                if (rsi < 45) addLog(`[${sym}] ${trendStr} Xu hướng M1 Giảm mạnh. RSI thấp (${rsi.toFixed(1)}). Đang rình nhịp hồi lên.`, 'analysis');
                else addLog(`[${sym}] ${trendStr} Xu hướng M1 Giảm. Đã sẵn sàng Short tại SMC Setup.`, 'analysis');
            }
        }

        // Bỏ qua nếu đang Cooldown hoặc đang xử lý lệnh
        if (isProcessingRef.current[sym] || now - lastTradeTimeRef.current[sym] < CONFIG.COOLDOWN_MS) return;

        // Tín hiệu SMC
        const obs = findOrderBlocks(symCandles, 20);
        const fvgs = findFVGs(symCandles, 20);

        // ĐIỀU KIỆN LONG
        const isMacroBullish = currentPrice > ema50 && ema50 > ma200 && upCount >= 2;
        const touchBullishOB = obs.bullish.some((ob: any) => currentPrice <= ob.top && currentPrice >= ob.bottom);
        const touchBullishFVG = fvgs.bullish.some((fvg: any) => currentPrice <= fvg.top && currentPrice >= fvg.bottom);
        const isRsiBullish = rsi >= 30 && rsi <= 55; 

        if (isMacroBullish && (touchBullishOB || touchBullishFVG) && isRsiBullish) {
            isProcessingRef.current[sym] = true;
            handleOpenOrder(sym, 'LONG', rsi.toFixed(1), touchBullishOB ? "SMC: Chạm Bullish OB" : "SMC: Lấp Bullish FVG", `${upCount}/4`);
            return;
        }

        // ĐIỀU KIỆN SHORT
        const isMacroBearish = currentPrice < ema50 && ema50 < ma200 && downCount >= 2;
        const touchBearishOB = obs.bearish.some((ob: any) => currentPrice >= ob.bottom && currentPrice <= ob.top);
        const touchBearishFVG = fvgs.bearish.some((fvg: any) => currentPrice >= fvg.bottom && currentPrice <= fvg.top);
        const isRsiBearish = rsi >= 45 && rsi <= 70; 

        if (isMacroBearish && (touchBearishOB || touchBearishFVG) && isRsiBearish) {
            isProcessingRef.current[sym] = true;
            handleOpenOrder(sym, 'SHORT', rsi.toFixed(1), touchBearishOB ? "SMC: Chạm Bearish OB" : "SMC: Lấp Bearish FVG", `${downCount}/4`);
            return;
        }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prices, isRunning, positions, candles, mtfTrends, indicators]);

  const handleOpenOrder = async (sym: string, type: 'LONG' | 'SHORT', rsiVal: string, setupName: string, mtfScore: string) => {
    if (!user) { isProcessingRef.current[sym] = false; return; }
    
    // Quản lý vốn: Chỉ dùng 48% số dư gốc để có thể vào 2 lệnh cùng lúc
    const margin = account.balance * 0.48;
    if (margin < 10) { 
       addLog(`[${sym}] Số dư khả dụng không đủ để mở lệnh.`, 'danger');
       isProcessingRef.current[sym] = false; 
       return; 
    }

    const price = prices[sym];
    const size = margin * CONFIG.LEVERAGE;
    const fee = size * CONFIG.FEE;
    const tp = type === 'LONG' ? price * (1 + CONFIG.TP_PERCENT) : price * (1 - CONFIG.TP_PERCENT);
    const sl = type === 'LONG' ? price * (1 - CONFIG.SL_PERCENT) : price * (1 + CONFIG.SL_PERCENT);

    const details = { type: String(type), entry: Number(price), margin: Number(margin - fee), size: Number(size), tp: Number(tp), sl: Number(sl), openFee: Number(fee), time: Date.now(), signalDetail: { rsi: String(rsiVal), setup: setupName, mtf: mtfScore } };

    try {
      await setDoc(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'account', 'data'), { balance: account.balance - margin }, { merge: true });
      await setDoc(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'trading', 'positions'), { [sym]: details }, { merge: true });
      
      sendTelegram(`🚀 <b>BOT MỞ ${type}</b>\n• Cặp: <b>${sym}</b>\n• Giá: ${price.toLocaleString()}\n• Tín hiệu: ${setupName}\n• MTF Score: ${mtfScore}\n• RSI: ${rsiVal}`);
      addLog(`[${sym}] VÀO ${type}: Tín hiệu ${setupName} chuẩn xác.`, 'success');
    } catch (e: any) {
      isProcessingRef.current[sym] = false;
      addLog(`[${sym}] Lỗi mở lệnh: ${e.message}`, 'danger');
    }
  };

  const handleCloseOrder = async (sym: string, reason: string, pnl: number) => {
    const position = positions[sym];
    if (!user || !position) { isProcessingRef.current[sym] = false; return; }
    
    lastTradeTimeRef.current[sym] = Date.now(); 
    const fee = Number(position.size) * CONFIG.FEE;
    const net = Number(pnl) - fee - Number(position.openFee);
    const tradeId = Date.now().toString();

    try {
      await setDoc(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'history', tradeId), { id: tradeId, symbol: sym, type: String(position.type), entry: Number(position.entry), exit: Number(prices[sym]), pnl: net, reason: String(reason), time: Date.now(), signalDetail: position.signalDetail || null });
      await setDoc(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'account', 'data'), { balance: account.balance + Number(position.margin) + (Number(pnl) - fee), pnlHistory: account.pnlHistory + net }, { merge: true });
      await updateDoc(doc(db, 'artifacts', APP_ID, 'users', user.uid, 'trading', 'positions'), { [sym]: deleteField() });

      const icon = net > 0 ? '✅' : '❌';
      sendTelegram(`${icon} <b>ĐÓNG ${position.type}</b>\n• Cặp: <b>${sym}</b>\n• PnL: <b>${net > 0 ? '+' : ''}${net.toFixed(2)} USDT</b>\n• Lý do: ${reason}`);
      addLog(`[${sym}] ĐÓNG ${position.type}: ${net.toFixed(2)} USDT (${reason})`, net > 0 ? 'success' : 'danger');
    } catch (e: any) {
      isProcessingRef.current[sym] = false;
      addLog(`[${sym}] Lỗi đóng lệnh: ${e.message}`, 'danger');
    }
  };

  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs, activeTab]);

  if (loadingAuth) return <div className="min-h-screen bg-[#0b0e11] flex items-center justify-center"><Activity className="animate-spin text-purple-500" size={48}/></div>;
  if (!user) return <AuthScreen />;

  // Render Engine cho biểu đồ của viewSymbol
  const viewCandles = candles[viewSymbol] || [];
  const renderCandles = () => {
    if (viewCandles.length === 0) return null;
    const displayCandles = viewCandles.slice(-60); 
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
                      setShowSettings(false); addLog("[SYSTEM] Đã lưu cấu hình.", "success");
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
            <h1 className="text-sm sm:text-lg font-black uppercase flex items-center gap-2">MULTI-PAIR BOT <span className="text-[9px] bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full animate-pulse border border-green-500/30">PARALLEL</span></h1>
            <div className="flex items-center gap-2 mt-1">
               <button onClick={() => setShowSettings(true)} className="text-[9px] text-gray-500 hover:text-white uppercase font-black transition-colors">Cài đặt</button>
               <div className="w-1 h-1 bg-gray-700 rounded-full"></div>
               <button onClick={() => signOut(auth)} className="text-[9px] text-red-500 hover:text-red-400 uppercase font-black transition-colors">Đăng xuất</button>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <button onClick={() => setIsRunning(!isRunning)} className={`px-10 py-4 rounded-2xl font-black transition-all shadow-xl active:scale-95 uppercase tracking-widest ${isRunning ? 'bg-red-500 text-white' : 'bg-green-500 text-[#0b0e11]'}`}>
            {isRunning ? 'Dừng Toàn Bộ' : 'Chạy Hệ Thống'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-8 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <div className="bg-[#1e2329] p-6 rounded-3xl border border-gray-800 shadow-xl relative group overflow-hidden">
                <div className="absolute -bottom-4 -right-4 opacity-5"><Wallet size={120}/></div>
                <span className="text-[10px] text-gray-500 uppercase font-black tracking-widest block mb-1">Ví USDT Khả dụng</span>
                <p className="text-4xl font-mono font-black text-white tracking-tighter">${Number(account.balance).toLocaleString(undefined, {minimumFractionDigits: 2})}</p>
                <div className="flex items-center gap-2 mt-4 text-[9px] text-gray-500 font-black uppercase tracking-widest bg-black/30 w-fit px-3 py-1 rounded-full border border-gray-800">
                   <Activity size={12} className="text-blue-500"/> Margin linh hoạt
                </div>
            </div>
            
            {/* VIEW SWITCHER & ACTIVE POSITIONS */}
            <div className="bg-[#1e2329] p-5 rounded-3xl border border-gray-800 shadow-xl relative flex flex-col">
                <div className="flex gap-2 mb-4 border-b border-gray-800 pb-4">
                    {SYMBOLS.map(s => (
                        <button 
                            key={s} 
                            onClick={() => setViewSymbol(s)} 
                            className={`flex-1 py-2 rounded-xl font-black text-xs transition-all ${viewSymbol === s ? 'bg-purple-600 text-white shadow-lg' : 'bg-[#0b0e11] border border-gray-700 text-gray-500 hover:text-gray-300'}`}
                        >
                            {s}
                        </button>
                    ))}
                </div>
                <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 space-y-3">
                    {Object.keys(positions).length === 0 ? (
                        <p className="text-gray-600 text-xs text-center italic mt-2 uppercase tracking-widest">Đang rình mồi...</p>
                    ) : (
                        Object.entries(positions).map(([sym, pos]) => {
                            const isL = pos.type === 'LONG';
                            const pnl = isL ? (prices[sym] - pos.entry) * (pos.size / pos.entry) : (pos.entry - prices[sym]) * (pos.size / pos.entry);
                            const roe = (pnl / pos.margin) * 100;
                            return (
                                <div key={sym} className="border border-gray-700 p-3 rounded-2xl bg-[#0b0e11]">
                                    <div className="flex justify-between items-center mb-2">
                                        <span className="font-bold text-sm text-gray-200">{sym}</span>
                                        <span className={`text-[10px] px-2 py-0.5 rounded font-black ${isL ? 'bg-green-600 text-white' : 'bg-red-600 text-white'}`}>{pos.type} x50</span>
                                    </div>
                                    <div className="flex justify-between items-end">
                                      <p className={`text-xs font-bold uppercase ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>PnL: {pnl > 0 ? '+' : ''}{pnl.toFixed(2)} ({roe.toFixed(1)}%)</p>
                                      <p className="text-[9px] text-gray-500 font-bold uppercase">E: {Number(pos.entry).toLocaleString()} | TP: {Number(pos.tp).toLocaleString()}</p>
                                    </div>
                                </div>
                            )
                        })
                    )}
                </div>
            </div>
          </div>

          <div className="bg-[#1e2329] p-5 rounded-3xl border border-gray-800 h-[380px] flex flex-col shadow-inner relative overflow-hidden">
             <div className="flex justify-between mb-4 items-center px-2 z-10 flex-wrap gap-2">
                <h3 className="text-xs font-black text-white uppercase flex items-center gap-2 tracking-widest">
                    <BarChart2 size={16}/> {viewSymbol} 
                    <span className="ml-2 font-mono text-green-400">${Number(prices[viewSymbol] || 0).toLocaleString()}</span>
                </h3>
                <div className="flex gap-2">
                   {['15m', '1h', '4h', '1d'].map(tf => {
                      const trend = (mtfTrends[viewSymbol] || {})[tf];
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
                {viewCandles.length < CONFIG.MA_PERIOD ? (
                    <div className="absolute inset-0 flex items-center justify-center flex-col gap-2">
                        <Activity className="animate-spin text-yellow-500" size={30}/>
                        <p className="text-[10px] text-gray-500 font-bold uppercase tracking-widest">Tải nến M1: {viewCandles.length}/{CONFIG.MA_PERIOD}</p>
                    </div>
                ) : renderCandles()}
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
                        {logs.length === 0 && <p className="text-gray-700 text-center italic mt-10 uppercase tracking-widest">Hệ thống đang quét 2 mã...</p>}
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
                                    <p className={`font-black text-sm uppercase tracking-tighter ${Number(t.pnl) > 0 ? 'text-green-400' : 'text-red-400'}`}>
                                        <span className="text-gray-300 mr-2 text-xs">{t.symbol || 'N/A'}</span>
                                        {String(t.type)} {Number(t.pnl) > 0 ? '+' : ''}{Number(t.pnl).toFixed(2)}
                                    </p>
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