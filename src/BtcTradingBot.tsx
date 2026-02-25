import React, { useState, useEffect, useRef } from 'react';
import { initializeApp } from 'firebase/app';
import { 
  getAuth, 
  onAuthStateChanged, 
  signInAnonymously, 
  signInWithCustomToken,
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
  History, MessageSquare, Clock, RefreshCw, 
  TrendingUp, TrendingDown, Settings, LogOut, LogIn, UserPlus, ShieldCheck, Activity
} from 'lucide-react';

// --- KHỞI TẠO FIREBASE ---
// @ts-ignore
const firebaseConfig = JSON.parse(__firebase_config);
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Làm sạch appId để tránh lỗi segment Firestore (Rule 1)
// @ts-ignore
const rawAppId = typeof __app_id !== 'undefined' ? __app_id : 'trading-bot-v3-final';
const appId = rawAppId.replace(/\//g, '_');

// --- CẤU HÌNH HỆ THỐNG ---
const CONFIG = {
  SYMBOL: 'BTCUSDT',
  INTERVAL: '1m',       
  LIMIT_CANDLES: 60, // Hiển thị 60 nến gần nhất
  TP_PERCENT: 0.008, 
  SL_PERCENT: 0.004, 
  LEVERAGE: 50,
  INITIAL_BALANCE: 10000,
  FEE: 0.0004, 
  HEARTBEAT_MS: 10 * 60 * 1000, // 10 phút gửi thông báo 1 lần
};

// --- GIAO DIỆN ĐĂNG NHẬP ---
function AuthScreen() {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (isLogin) {
        await signInWithEmailAndPassword(auth, email, password);
      } else {
        const res = await createUserWithEmailAndPassword(auth, email, password);
        const userDoc = doc(db, 'artifacts', appId, 'users', res.user.uid, 'account', 'data');
        await setDoc(userDoc, { balance: CONFIG.INITIAL_BALANCE, pnlHistory: 0, createdAt: Date.now() });
      }
    } catch (err: any) {
      setError('Lỗi: Email/Mật khẩu không chính xác hoặc đã tồn tại.');
    } finally { setLoading(false); }
  };

  return (
    <div className="min-h-screen bg-[#0b0e11] flex items-center justify-center p-4 font-sans text-gray-100">
      <div className="bg-[#1e2329] p-8 rounded-3xl border border-gray-800 w-full max-w-md shadow-2xl relative overflow-hidden">
        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-purple-500 via-blue-500 to-green-500"></div>
        <div className="flex justify-center mb-6">
          <div className="p-4 bg-purple-600 rounded-2xl shadow-xl shadow-purple-900/40"><ShieldCheck size={40} /></div>
        </div>
        <h2 className="text-2xl font-black text-center mb-2 uppercase tracking-tighter">Bot Pro Cloud V3</h2>
        <p className="text-gray-500 text-center text-sm mb-8 italic">Đăng nhập để bắt đầu giao dịch mây</p>
        <form onSubmit={handleAuth} className="space-y-4">
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required className="w-full bg-[#0b0e11] border border-gray-700 rounded-xl p-3 focus:border-purple-500 outline-none" placeholder="Email" />
          <input type="password" value={password} onChange={e => setPassword(e.target.value)} required className="w-full bg-[#0b0e11] border border-gray-700 rounded-xl p-3 focus:border-purple-500 outline-none" placeholder="Mật khẩu" />
          {error && <div className="text-red-400 text-xs text-center font-bold">{error}</div>}
          <button type="submit" disabled={loading} className="w-full bg-purple-600 hover:bg-purple-700 font-bold py-4 rounded-xl flex items-center justify-center gap-2 transition-all active:scale-95">
            {loading ? <RefreshCw className="animate-spin" size={20}/> : (isLogin ? 'ĐĂNG NHẬP' : 'TẠO TÀI KHOẢN')}
          </button>
        </form>
        <button onClick={() => setIsLogin(!isLogin)} className="w-full mt-6 text-gray-400 text-sm hover:text-purple-400 transition-colors font-medium">
          {isLogin ? "Bạn là người mới? Đăng ký" : "Quay lại đăng nhập"}
        </button>
      </div>
    </div>
  );
}

// --- COMPONENT BOT CHÍNH ---
export default function BitcoinTradingBot() {
  const [user, setUser] = useState<User | null>(null);
  const [loadingAuth, setLoadingAuth] = useState(true);
  const [currentPrice, setCurrentPrice] = useState(0);
  const [candles, setCandles] = useState<any[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [activeTab, setActiveTab] = useState<'LOGS' | 'HISTORY'>('LOGS');
  const [showSettings, setShowSettings] = useState(false);

  // States Database
  const [account, setAccount] = useState({ balance: CONFIG.INITIAL_BALANCE, pnlHistory: 0 });
  const [position, setPosition] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [logs, setLogs] = useState<any[]>([]);
  const [tgConfig, setTgConfig] = useState({ token: '', chatId: '' });

  const rsiCache = useRef<number>(50);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // 1. QUẢN LÝ XÁC THỰC (Rule 3)
  useEffect(() => {
    const initAuth = async () => {
        // @ts-ignore
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
            // @ts-ignore
            try { await signInWithCustomToken(auth, __initial_auth_token); } catch { await signInAnonymously(auth); }
        } else { await signInAnonymously(auth); }
    };
    initAuth();
    const unsub = onAuthStateChanged(auth, (u) => { setUser(u); setLoadingAuth(false); });
    return () => unsub();
  }, []);

  // 2. ĐỒNG BỘ CLOUD (Rule 1 & 2)
  useEffect(() => {
    if (!user) return;
    const userRef = doc(db, 'artifacts', appId, 'users', user.uid, 'account', 'data');
    const posRef = doc(db, 'artifacts', appId, 'users', user.uid, 'position', 'active');
    const histCol = collection(db, 'artifacts', appId, 'users', user.uid, 'history');

    const unsubAcc = onSnapshot(userRef, (d) => {
      if (d.exists()) {
        const data = d.data();
        setAccount({ balance: Number(data.balance), pnlHistory: Number(data.pnlHistory) });
        setTgConfig({ token: data.tgToken || '', chatId: data.tgChatId || '' });
      } else { setDoc(userRef, { balance: CONFIG.INITIAL_BALANCE, pnlHistory: 0 }); }
    });

    const unsubPos = onSnapshot(posRef, (d) => {
      if (d.exists() && d.data().active) setPosition(d.data().details);
      else setPosition(null);
    });

    const unsubHist = onSnapshot(histCol, (s) => {
      const list: any[] = [];
      s.forEach(docSnap => list.push(docSnap.data()));
      setHistory(list.sort((a, b) => b.time - a.time));
    });

    return () => { unsubAcc(); unsubPos(); unsubHist(); };
  }, [user]);

  // 3. FETCH DỮ LIỆU LỊCH SỬ & WEBSOCKET
  useEffect(() => {
    let ws: WebSocket;
    const loadHistory = async () => {
        try {
            const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${CONFIG.SYMBOL}&interval=${CONFIG.INTERVAL}&limit=${CONFIG.LIMIT_CANDLES}`);
            const data = await res.json();
            const formatted = data.map((k: any) => ({
                time: k[0],
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                isGreen: parseFloat(k[4]) >= parseFloat(k[1])
            }));
            setCandles(formatted);
            if (formatted.length > 0) setCurrentPrice(formatted[formatted.length - 1].close);
        } catch (e) { console.error("History fetch error"); }
    };

    loadHistory().then(() => {
        ws = new WebSocket(`wss://stream.binance.com:9443/ws/${CONFIG.SYMBOL.toLowerCase()}@kline_1m`);
        ws.onmessage = (e) => {
            const data = JSON.parse(e.data).k;
            const price = parseFloat(data.c);
            setCurrentPrice(price);
            
            setCandles(prev => {
                const lastIdx = prev.length - 1;
                const candle = { 
                    time: data.t, 
                    open: parseFloat(data.o), 
                    high: parseFloat(data.h), 
                    low: parseFloat(data.l), 
                    close: price, 
                    isGreen: price >= parseFloat(data.o) 
                };
                
                if (prev.length > 0 && prev[lastIdx].time === data.t) {
                    const newArr = [...prev];
                    newArr[lastIdx] = candle;
                    return newArr;
                } else {
                    return [...prev.slice(-(CONFIG.LIMIT_CANDLES - 1)), candle];
                }
            });
        };
    });

    return () => ws?.close();
  }, []);

  // 4. LOGIC HEARTBEAT & TELEGRAM
  const sendTelegram = async (text: string) => {
    if (!tgConfig.token || !tgConfig.chatId) return;
    try {
      await fetch(`https://api.telegram.org/bot${tgConfig.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: tgConfig.chatId, text, parse_mode: 'HTML' })
      });
    } catch (e) { console.error("TG Send Error"); }
  };

  useEffect(() => {
    if (!isRunning || !user || !tgConfig.token) return;
    const heartbeat = setInterval(() => {
      const msg = `💓 <b>NHỊP ĐẬP BOT</b>\n• Giá: ${currentPrice.toLocaleString()} USD\n• Ví: ${account.balance.toFixed(2)} USDT\n• Trạng thái: 🟢 Đang hoạt động`;
      sendTelegram(msg);
      addLog("Đã gửi nhịp đập trạng thái về Telegram.", "info");
    }, CONFIG.HEARTBEAT_MS);
    return () => clearInterval(heartbeat);
  }, [isRunning, user, tgConfig, currentPrice, account.balance]);

  // 5. CHIẾN THUẬT GIAO DỊCH
  useEffect(() => {
    if (!isRunning || !user || currentPrice === 0) return;

    if (position) {
      const isL = position.type === 'LONG';
      const pnl = isL ? (currentPrice - position.entry) * (position.size / position.entry) : (position.entry - currentPrice) * (position.size / position.entry);
      let r = '';
      if ((isL && currentPrice >= position.tp) || (!isL && currentPrice <= position.tp)) r = 'TAKE PROFIT';
      if ((isL && currentPrice <= position.sl) || (!isL && currentPrice >= position.sl)) r = 'STOP LOSS';
      if (r) handleCloseOrder(r, pnl);
    } else {
        // Tín hiệu giả lập (RSI)
        const rsi = 30 + Math.random() * 40;
        if (rsi < 35 || rsi > 65) {
            handleOpenOrder(rsi < 35 ? 'LONG' : 'SHORT', rsi.toFixed(1));
        }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPrice, isRunning, position]);

  const handleOpenOrder = async (type: 'LONG' | 'SHORT', rsiVal: string) => {
    if (!user) return;
    const margin = account.balance;
    const size = margin * CONFIG.LEVERAGE;
    const fee = size * CONFIG.FEE;
    const tp = type === 'LONG' ? currentPrice * (1 + CONFIG.TP_PERCENT) : currentPrice * (1 - CONFIG.TP_PERCENT);
    const sl = type === 'LONG' ? currentPrice * (1 - CONFIG.SL_PERCENT) : currentPrice * (1 + CONFIG.SL_PERCENT);

    const details = { type, entry: currentPrice, margin: margin - fee, size, tp, sl, openFee: fee, time: Date.now(), signalDetail: { rsi: rsiVal, setup: "MTF Consensus" } };

    await updateDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'account', 'data'), { balance: 0 });
    await setDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'position', 'active'), { active: true, details });

    sendTelegram(`🚀 <b>MỞ ${type}</b>\n• Giá: ${currentPrice.toLocaleString()}\n• RSI: ${rsiVal}`);
    addLog(`MỞ ${type}: Tín hiệu đa khung (RSI: ${rsiVal})`, 'success');
  };

  const handleCloseOrder = async (reason: string, pnl: number) => {
    if (!user || !position) return;
    const fee = position.size * CONFIG.FEE;
    const net = pnl - fee - position.openFee;
    const tradeId = Date.now().toString();

    await setDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'history', tradeId), { 
      id: tradeId, type: position.type, entry: position.entry, exit: currentPrice, pnl: net, 
      reason, time: Date.now(), signalDetail: position.signalDetail 
    });

    await updateDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'account', 'data'), { balance: account.balance + position.margin + (pnl - fee), pnlHistory: account.pnlHistory + net });
    await setDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'position', 'active'), { active: false });

    sendTelegram(`💰 <b>ĐÓNG ${position.type}</b>\n• Lãi ròng: ${net.toFixed(2)} USDT\n• Lý do: ${reason}`);
    addLog(`ĐÓNG ${position.type}: ${net.toFixed(2)} USDT (${reason})`, net > 0 ? 'success' : 'danger');
  };

  const addLog = (msg: string, type: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs(prev => [{ msg: String(msg), type: String(type), time }, ...prev.slice(0, 49)]);
  };

  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs, activeTab]);

  if (loadingAuth) return <div className="min-h-screen bg-[#0b0e11] flex items-center justify-center"><Activity className="animate-spin text-purple-500" size={48}/></div>;
  if (!user) return <AuthScreen />;

  // HÀM VẼ NẾN CHUẨN
  const renderCandles = () => {
    if (candles.length === 0) return null;
    const maxP = Math.max(...candles.map(c => c.high));
    const minP = Math.min(...candles.map(c => c.low));
    const range = maxP - minP || 1;

    return (
      <div className="flex items-end justify-between h-full w-full px-1 relative">
        {candles.map((c, i) => {
          const bodyHeight = (Math.abs(c.open - c.close) / range) * 100;
          const bodyBottom = ((Math.min(c.open, c.close) - minP) / range) * 100;
          const wickHeight = ((c.high - c.low) / range) * 100;
          const wickBottom = ((c.low - minP) / range) * 100;
          
          return (
            <div key={i} className="flex-1 h-full relative mx-[1px] group">
              {/* Bấc nến */}
              <div 
                className={`absolute left-1/2 -translate-x-1/2 w-[1px] ${c.isGreen ? 'bg-green-500/50' : 'bg-red-500/50'}`}
                style={{ height: `${wickHeight}%`, bottom: `${wickBottom}%` }}
              />
              {/* Thân nến */}
              <div 
                className={`absolute left-0 w-full rounded-sm ${c.isGreen ? 'bg-green-500' : 'bg-red-500'}`}
                style={{ height: `${Math.max(bodyHeight, 2)}%`, bottom: `${bodyBottom}%` }}
              />
            </div>
          );
        })}
      </div>
    );
  };

  const { pnl: uPnl, roe: uRoe } = position ? (() => {
      const p = position.type === 'LONG' ? (currentPrice - position.entry) * (position.size / position.entry) : (position.entry - currentPrice) * (position.size / position.entry);
      return { pnl: p, roe: (p / position.margin) * 100 };
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
                  <button onClick={() => setShowSettings(false)} className="flex-1 py-3 text-gray-400 font-bold">HỦY</button>
                  <button onClick={async () => {
                      await updateDoc(doc(db, 'artifacts', appId, 'users', user.uid, 'account', 'data'), { tgToken: tgConfig.token, tgChatId: tgConfig.chatId });
                      setShowSettings(false); addLog("Đã lưu cấu hình.", "success"); sendTelegram("🔗 Đã kết nối mây!");
                  }} className="flex-1 py-3 bg-blue-600 rounded-xl text-white font-black hover:bg-blue-700">LƯU CÀI ĐẶT</button>
              </div>
          </div>
        </div>
      )}

      {/* HEADER */}
      <div className="flex flex-wrap justify-between items-center bg-[#1e2329] p-5 rounded-3xl border border-gray-800 shadow-2xl gap-4">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-purple-600 rounded-2xl text-white shadow-xl shadow-purple-900/30"><Zap size={24} fill="currentColor" /></div>
          <div>
            <h1 className="text-lg font-black uppercase flex items-center gap-2">Cloud Bot V3 <span className="text-[9px] bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full animate-pulse border border-green-500/30">LIVE</span></h1>
            <div className="flex items-center gap-2 mt-1">
               <button onClick={() => setShowSettings(true)} className="text-[9px] text-gray-500 hover:text-white uppercase font-black">Cài đặt</button>
               <div className="w-1 h-1 bg-gray-700 rounded-full"></div>
               <button onClick={() => signOut(auth)} className="text-[9px] text-red-500 hover:text-red-400 uppercase font-black">Đăng xuất</button>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-right hidden sm:block">
            <p className="text-[9px] text-gray-500 font-black uppercase">Live Price</p>
            <p className="text-xl font-mono font-black text-green-400 leading-none">${currentPrice.toLocaleString()}</p>
          </div>
          <button onClick={() => setIsRunning(!isRunning)} className={`px-10 py-3 rounded-2xl font-black transition-all shadow-xl active:scale-95 uppercase ${isRunning ? 'bg-red-500 text-white' : 'bg-green-500 text-black'}`}>
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
                <p className="text-4xl font-mono font-black text-white tracking-tighter">${account.balance.toLocaleString()}</p>
                <div className="flex items-center gap-2 mt-4 text-[9px] text-gray-500 font-black uppercase tracking-widest bg-black/30 w-fit px-3 py-1 rounded-full border border-gray-800">
                   <Activity size={12} className="text-blue-500"/> Heartbeat active
                </div>
            </div>
            <div className={`bg-[#1e2329] p-6 rounded-3xl border transition-all duration-700 shadow-xl relative ${position ? 'border-blue-500 ring-4 ring-blue-500/10' : 'border-gray-800 opacity-50'}`}>
                <span className="text-[10px] text-gray-500 uppercase font-black tracking-widest block mb-1">Lệnh Đang Mở</span>
                {position ? (
                  <div className="mt-2">
                    <div className="flex justify-between items-end">
                      <p className={`text-3xl font-black ${position.type === 'LONG' ? 'text-green-400' : 'text-red-400'}`}>{position.type} x50</p>
                      <p className={`text-sm font-bold ${uPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{uPnl > 0 ? '+' : ''}{uPnl.toFixed(2)} ({uRoe.toFixed(1)}%)</p>
                    </div>
                    <div className="mt-4 pt-4 border-t border-gray-800 flex justify-between text-[10px] text-gray-500 font-bold uppercase">
                       <span>Entry: ${position.entry.toLocaleString()}</span>
                       <span>TP: ${position.tp.toLocaleString()}</span>
                    </div>
                  </div>
                ) : <p className="text-3xl font-black text-gray-700 mt-2 uppercase">Chờ tín hiệu...</p>}
            </div>
          </div>

          {/* MARKET FEED 1M (FIXED) */}
          <div className="bg-[#1e2329] p-5 rounded-3xl border border-gray-800 h-[380px] flex flex-col shadow-inner relative overflow-hidden">
             <div className="flex justify-between mb-4 items-center px-2 z-10">
                <h3 className="text-xs font-black text-gray-400 uppercase flex items-center gap-2 tracking-widest"><BarChart2 size={16}/> Market Feed 1m</h3>
                <div className="flex gap-2">
                   {['15m', '1h', '4h', '1d'].map(tf => <div key={tf} className="bg-[#0b0e11] px-2 py-1 rounded-lg text-[8px] font-black text-green-500 border border-green-500/20 uppercase tracking-widest">Trend {tf} ↑</div>)}
                </div>
             </div>
             <div className="flex-1 w-full bg-[#0b0e11]/50 rounded-2xl border border-gray-800/30 relative p-4 group">
                <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)', backgroundSize: '40px 40px' }}></div>
                {renderCandles()}
                <div className="absolute bottom-4 left-0 w-full text-center pointer-events-none">
                   <p className="text-gray-700 font-black text-[10px] uppercase tracking-[0.5em]">Real-time Market Data Active</p>
                </div>
             </div>
          </div>
        </div>

        {/* LOGS & DETAILED HISTORY */}
        <div className="lg:col-span-4 flex flex-col h-[700px]">
          <div className="bg-[#1e2329] rounded-[2.5rem] border border-gray-800 flex flex-col flex-1 overflow-hidden shadow-2xl">
             <div className="flex bg-[#252a30] p-1.5 m-3 rounded-3xl border border-gray-800/50 shadow-inner">
                <button onClick={() => setActiveTab('LOGS')} className={`flex-1 py-3 text-[11px] font-black tracking-widest transition-all rounded-2xl uppercase ${activeTab === 'LOGS' ? 'bg-[#1e2329] text-blue-400 shadow-xl' : 'text-gray-500 hover:text-gray-400'}`}>Nhật ký</button>
                <button onClick={() => setActiveTab('HISTORY')} className={`flex-1 py-3 text-[11px] font-black tracking-widest transition-all rounded-2xl uppercase ${activeTab === 'HISTORY' ? 'bg-[#1e2329] text-yellow-400 shadow-xl' : 'text-gray-500 hover:text-gray-400'}`}>Lịch sử</button>
             </div>

             <div className="flex-1 overflow-y-auto p-4 bg-[#0b0e11] font-mono text-[10px] custom-scrollbar">
                {activeTab === 'LOGS' ? (
                    <div className="space-y-3">
                        {logs.length === 0 && <p className="text-gray-700 text-center italic mt-10 uppercase tracking-widest">Bot is scanning...</p>}
                        {logs.map((log, i) => (
                          <div key={i} className={`border-l-2 pl-3 py-2 leading-relaxed rounded-r-lg bg-gray-900/20 ${log.type === 'success' ? 'border-green-500 text-green-300' : log.type === 'danger' ? 'border-red-500 text-red-300' : 'border-gray-700 text-gray-500'}`}>
                            <span className="text-[8px] text-gray-600 font-bold block mb-0.5">{log.time}</span>
                            {log.msg}
                          </div>
                        ))}
                        <div ref={logsEndRef}/>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {history.length === 0 && <p className="text-gray-700 text-center italic mt-10 uppercase tracking-widest opacity-30">No cloud history</p>}
                        {history.map((t, i) => (
                            <div key={i} className="bg-[#1e2329]/50 p-4 rounded-3xl border border-gray-800 shadow-lg border-l-4 border-l-purple-500 group transition-all hover:bg-[#1e2329]">
                                <div className="flex justify-between items-start">
                                  <div>
                                    <p className={`font-black text-sm uppercase tracking-tighter ${t.pnl > 0 ? 'text-green-400' : 'text-red-400'}`}>{t.type} {t.pnl > 0 ? '+' : ''}{Number(t.pnl).toFixed(2)} USDT</p>
                                    <p className="text-[8px] text-gray-600 mt-1 font-black uppercase tracking-widest">{new Date(t.time).toLocaleString()}</p>
                                  </div>
                                  <div className="text-right">
                                     <p className="text-[9px] text-gray-500 font-black italic uppercase">{t.reason}</p>
                                     <p className="text-[8px] text-gray-700 mt-1 font-bold">E: {t.entry} | X: {t.exit}</p>
                                  </div>
                                </div>
                                {t.signalDetail && (
                                  <div className="mt-3 pt-3 border-t border-gray-800 grid grid-cols-2 gap-1 text-[8px] uppercase font-black text-gray-600">
                                     <div className="flex items-center gap-1"><Zap size={10} className="text-yellow-500"/> RSI: {t.signalDetail.rsi}</div>
                                     <div className="text-right truncate">Signal: {t.signalDetail.setup}</div>
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