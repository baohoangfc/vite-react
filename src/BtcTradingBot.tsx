import React, { useState, useEffect, useRef } from 'react';
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
  calculateRSI, calculateFullEMA, getMACD,
  detectSMC, calculateScores
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
    '1m': 'NEUTRAL', '5m': 'NEUTRAL', '15m': 'NEUTRAL'
  });

  const [isRunning, setIsRunning] = useState(false);
  const [isSimulation] = useState(false);
  const [logs, setLogs] = useState<{ msg: string, type: string }[]>([]);
  const [activeTab, setActiveTab] = useState<'LOGS' | 'HISTORY' | 'DAILY'>('LOGS');
  const [showSettings, setShowSettings] = useState(false);

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
    try { await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }) }); } catch (e) { }
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

  const fetchMTFData = async () => {
    const timeframes: ('5m' | '15m')[] = ['5m', '15m'];
    const newSentiment = { ...sentiment };

    for (const tf of timeframes) {
      try {
        const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${CONFIG.SYMBOL}&interval=${tf}&limit=50`);
        const data = await res.json();
        const prices = data.map((k: any) => parseFloat(k[4]));
        const emaArr = calculateFullEMA(prices, CONFIG.EMA_PERIOD);
        const lastClose = prices[prices.length - 1];
        const lastEma = emaArr[emaArr.length - 1];

        newSentiment[tf] = lastClose > lastEma ? 'BULLISH' : 'BEARISH';
      } catch (e) {
        console.error(`Error fetching ${tf} data`, e);
      }
    }
    setSentiment(newSentiment);
  };

  useEffect(() => {
    if (isRunning) {
      fetchMTFData();
      const interval = setInterval(fetchMTFData, 60000); // 1 minute sync
      return () => clearInterval(interval);
    }
  }, [isRunning]);

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

    const score = calculateScores({ rsi, ema, macd, fvg, ob, trend }, lastCandle, CONFIG);

    setCandles(newCandles);
    setCurrentPrice(lastCandle.close);
    setAnalysis({ rsi, ema, macd, volSma, fvg, ob, trend, score });
    setSentiment(prev => ({ ...prev, '1m': trend === 'UP' ? 'BULLISH' : 'BEARISH' }));

    return { currentPrice: lastCandle.close, analysis: { rsi, ema, macd, volSma, fvg, ob, trend, score }, lastCandle };
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

  // Trading Logic
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
      let thought = `Quét đa tín hiệu [Điểm: ${analysis.score > 0 ? '+' + analysis.score : analysis.score}/5]. `;
      if (!isVolOk) thought += `Thanh khoản thấp (${volRatio}x tb). `;

      if (analysis.score === 0) thought += `Thị trường Sideway/Nhiễu. Tạm dừng giao dịch.`;
      else if (analysis.score > 0 && analysis.score < CONFIG.CONFLUENCE_THRESHOLD) thought += `Phe Mua đang gom hàng (FVG/OB) nhưng xung lực chưa đủ. Rình mồi LONG...`;
      else if (analysis.score < 0 && analysis.score > -CONFIG.CONFLUENCE_THRESHOLD) thought += `Phe Bán đang áp đảo. Áp lực MACD yếu. Rình mồi SHORT...`;

      addLog(`AI Radar: ${thought}`, 'analysis');
      lastAnalysisLogTime.current = now;
    }
  }, [currentPrice, isRunning, position, analysis, candles]);

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
          <div className="flex items-center gap-4 z-10">
            <div className="p-3 bg-gradient-to-br from-blue-600 to-purple-600 rounded-xl text-white shadow-lg shadow-blue-500/30"><Crosshair size={24} /></div>
            <div>
              <h1 className="text-2xl font-black bg-clip-text text-transparent bg-gradient-to-r from-white to-gray-400 tracking-tight flex items-center gap-3">
                NEXUS AI TRADER
                <SentimentIndicators sentiment={sentiment} />
              </h1>
              <div className="flex items-center gap-3 text-[11px] text-gray-400 mt-1 font-medium">
                <span className="flex items-center gap-1"><Layers size={12} /> SMC Confluence Engine</span>
                <span className="border-l border-gray-700 pl-3 text-blue-400 font-bold tracking-widest">LEV x{CONFIG.LEVERAGE}</span>
                <button onClick={() => setShowSettings(true)} className="ml-2 hover:text-white transition-colors underline decoration-gray-700 underline-offset-2">Cài đặt Telegram</button>
                <button onClick={() => signOut(auth)} className="text-red-400 hover:text-red-300 transition-colors ml-2">Đăng xuất</button>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-6 mt-4 md:mt-0 z-10">
            <div className="text-right">
              <p className="text-[10px] text-gray-500 font-bold tracking-widest uppercase">BTC/USDT M1</p>
              <p className={`text-3xl font-mono font-black tracking-tighter ${candles.length > 0 && currentPrice >= candles[candles.length - 1].open ? 'text-[#0ecb81] drop-shadow-[0_0_8px_#0ecb8140]' : 'text-[#f6465d] drop-shadow-[0_0_8px_#f6465d40]'}`}>{currentPrice.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
            </div>
            <button onClick={() => setIsRunning(!isRunning)} className={`flex items-center justify-center gap-2 w-36 py-3.5 rounded-xl font-black uppercase tracking-widest transition-all shadow-lg active:scale-95 border ${isRunning ? 'bg-red-500/10 text-red-500 border-red-500/30 hover:bg-red-500/20' : 'bg-green-500 text-[#05070a] border-green-400 hover:bg-green-400 shadow-green-500/20'}`}>
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
              <div className="flex bg-[#1e2329]/50 border-b border-white/5 p-1">
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
                  <DailyAggregation history={history} />
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}