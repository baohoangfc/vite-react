import { useState, useEffect, useRef, Dispatch, SetStateAction } from 'react';
import { Wallet, Play, Pause, BarChart2, Zap, WifiOff, Wifi, XCircle, History, MessageSquare, Clock, RefreshCw, TrendingUp, TrendingDown, Minus, Settings } from 'lucide-react';

const CONFIG = {
  SYMBOL: 'BTCUSDT',
  INTERVAL: '1m',       
  HTF_INTERVALS: ['15m', '1h', '4h', '1d'], 
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

type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number; isGreen: boolean; };
type OrderBlock = { type: 'BULLISH' | 'BEARISH'; top: number; bottom: number; candleIndex: number; };
type Trend = 'UP' | 'DOWN' | 'UNKNOWN';
type Analysis = { 
    rsi: number; ema: number; volSma: number; support: number; resistance: number; 
    fvg: 'BULLISH' | 'BEARISH' | null; trend: Trend; obs: OrderBlock[]; 
    mtfTrends: { m15: Trend, h1: Trend, h4: Trend, d1: Trend }; 
};
type TradeHistoryItem = { id: string; type: 'LONG' | 'SHORT'; entryPrice: number; exitPrice: number; pnl: number; pnlPercent: number; reason: string; time: number; fee: number; };

const loadFromStorage = <T,>(key: string, defaultValue: T): T => {
  if (typeof window === 'undefined') return defaultValue;
  try {
    const saved = localStorage.getItem(key);
    if (saved) return JSON.parse(saved);
  } catch (e) { console.error(e); }
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
  let avgG = gains / period; let avgL = losses / period;
  const cD = prices[prices.length - 1] - prices[prices.length - 2];
  if (cD >= 0) { avgG = (avgG * (period - 1) + cD) / period; avgL = (avgL * (period - 1)) / period; } 
  else { avgG = (avgG * (period - 1)) / period; avgL = (avgL * (period - 1) - cD) / period; }
  if (avgL === 0) return 100;
  return 100 - (100 / (1 + (avgG / avgL)));
};

const calculateEMA = (candles: Candle[], period: number) => {
  if (candles.length < period) return candles[candles.length - 1]?.close || 0;
  const k = 2 / (period + 1);
  let ema = candles[0].close;
  for (let i = 1; i < candles.length; i++) ema = candles[i].close * k + ema * (1 - k);
  return ema;
};

const findSR = (candles: Candle[]) => {
  if (candles.length < 20) return { s: 0, r: 0 };
  const w = candles.slice(Math.max(0, candles.length - 31), candles.length - 1); 
  return { s: Math.min(...w.map(c => c.low)), r: Math.max(...w.map(c => c.high)) };
};

const detectFVG = (candles: Candle[]): 'BULLISH' | 'BEARISH' | null => {
  if (candles.length < 4) return null;
  const c1 = candles[candles.length - 4]; const c3 = candles[candles.length - 2]; 
  if (c3.low > c1.high) return 'BULLISH';
  if (c3.high < c1.low) return 'BEARISH';
  return null;
};

const detectOB = (candles: Candle[]): OrderBlock[] => {
    const obs: OrderBlock[] = [];
    if (candles.length < 10) return obs;
    let fBull = false, fBear = false;
    for (let i = candles.length - 3; i > 2; i--) {
        const c = candles[i], n = candles[i+1];
        if (!fBull && !c.isGreen && n.isGreen && n.close > c.high && Math.abs(n.open - n.close) > Math.abs(c.open - c.close) * 1.2) {
            obs.push({ type: 'BULLISH', top: c.high, bottom: c.low, candleIndex: i });
            fBull = true;
        }
        if (!fBear && c.isGreen && !n.isGreen && n.close < c.low && Math.abs(n.open - n.close) > Math.abs(c.open - c.close) * 1.2) {
            obs.push({ type: 'BEARISH', top: c.high, bottom: c.low, candleIndex: i });
            fBear = true;
        }
        if (fBull && fBear) break;
    }
    return obs;
};

export default function BitcoinTradingBot() {
  const [candles, setCandles] = useState<Candle[]>([]);
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
  const [activeTab, setActiveTab] = useState<'LOGS' | 'HISTORY'>('LOGS');
  const [showSettings, setShowSettings] = useState(false);
  const [, setForceRender] = useState<number>(0);
  const [account, setAccount] = useState(() => loadFromStorage('btcBot_account', { balance: CONFIG.INITIAL_BALANCE, pnlHistory: 0 }));
  const [position, setPosition] = useState<{ type: 'LONG' | 'SHORT'; entryPrice: number; margin: number; size: number; tpPrice: number; slPrice: number; liquidationPrice: number; openFee: number; openTime: number; } | null>(() => loadFromStorage('btcBot_position', null));
  const [history, setHistory] = useState<TradeHistoryItem[]>(() => loadFromStorage('btcBot_history', []));
  const [logs, setLogs] = useState<{msg: string, type: string}[]>(() => loadFromStorage('btcBot_logs', []));
  const [tgToken, setTgToken] = useState(() => loadFromStorage('btcBot_tgToken', ''));
  const [tgChatId, setTgChatId] = useState(() => loadFromStorage('btcBot_tgChatId', ''));
  const logsEndRef = useRef<HTMLDivElement>(null);
  const lastALogTime = useRef<number>(0); 
  const wsRefs = useRef<{[key: string]: WebSocket}>({});
  const tgRef = useRef({ token: tgToken, chatId: tgChatId });

  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs, activeTab]);
  useEffect(() => { 
      localStorage.setItem('btcBot_account', JSON.stringify(account));
      localStorage.setItem('btcBot_position', JSON.stringify(position));
      localStorage.setItem('btcBot_history', JSON.stringify(history));
      localStorage.setItem('btcBot_logs', JSON.stringify(logs));
      localStorage.setItem('btcBot_tgToken', JSON.stringify(tgToken)); 
      localStorage.setItem('btcBot_tgChatId', JSON.stringify(tgChatId)); 
      tgRef.current = { token: tgToken, chatId: tgChatId };
  }, [account, position, history, logs, tgToken, tgChatId]);

  const sendTelegram = async (text: string) => {
      const { token, chatId } = tgRef.current;
      if (!token || !chatId) return;
      try {
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
          });
      } catch (e) { console.error(e); }
  };

  const addLog = (message: string, type: 'info' | 'success' | 'danger' | 'warning' | 'analysis' = 'info') => {
    const ts = new Date().toLocaleTimeString();
    setLogs(prev => [...prev.slice(-49), { msg: `[${ts}] ${message}`, type }]);
  };

  useEffect(() => {
    let isMounted = true;
    const initData = async () => {
      try {
        const ivs = [CONFIG.INTERVAL, ...CONFIG.HTF_INTERVALS];
        const res = await Promise.all(ivs.map(i => fetch(`https://api.binance.com/api/v3/klines?symbol=${CONFIG.SYMBOL}&interval=${i}&limit=${CONFIG.LIMIT_CANDLES}`).then(r => r.json())));
        const fmt = (data: any[]) => data.map((k: any) => ({ time: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]), isGreen: parseFloat(k[4]) >= parseFloat(k[1]) }));
        if (isMounted) {
            setCandles(fmt(res[0])); setC15m(fmt(res[1])); setC1h(fmt(res[2])); setC4h(fmt(res[3])); setC1d(fmt(res[4]));
            setIsSimulation(false);
        }
        ivs.forEach(interval => {
            const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${CONFIG.SYMBOL.toLowerCase()}@kline_${interval}`);
            wsRefs.current[interval] = ws;
            ws.onmessage = (e) => {
                if (!isMounted) return;
                const m = JSON.parse(e.data).k;
                const live: Candle = { time: m.t, open: parseFloat(m.o), high: parseFloat(m.h), low: parseFloat(m.l), close: parseFloat(m.c), volume: parseFloat(m.v), isGreen: parseFloat(m.c) >= parseFloat(m.o) };
                const map: {[key: string]: Dispatch<SetStateAction<Candle[]>>} = { '1m': setCandles, '15m': setC15m, '1h': setC1h, '4h': setC4h, '1d': setC1d };
                if (map[interval]) {
                    map[interval](prev => {
                        const arr = [...prev];
                        if (arr.length === 0) return [live];
                        if (live.time === arr[arr.length - 1].time) { arr[arr.length - 1] = live; } 
                        else { arr.push(live); if (arr.length > CONFIG.LIMIT_CANDLES) arr.shift(); }
                        return arr;
                    });
                }
            };
        });
      } catch (e) { if (isMounted) setIsSimulation(true); }
    };
    initData();
    return () => { isMounted = false; Object.values(wsRefs.current).forEach(ws => ws.close()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
      if (candles.length === 0) return;
      const last = candles[candles.length - 1];
      const rsi = calculateRSI(candles, CONFIG.RSI_PERIOD);
      const ema = calculateEMA(candles, CONFIG.EMA_PERIOD);
      const volSma = candles.slice(-20).reduce((a, b) => a + b.volume, 0) / 20;
      const { s, r } = findSR(candles);
      const fvg = detectFVG(candles);
      const obs = detectOB(candles);
      const getT = (arr: Candle[]): Trend => arr.length > 0 ? (arr[arr.length-1].close > calculateEMA(arr, 50) ? 'UP' : 'DOWN') : 'UNKNOWN';
      const nAnalysis: Analysis = { rsi, ema, volSma, support: s, resistance: r, fvg, trend: last.close > ema ? 'UP' : 'DOWN', obs, mtfTrends: { m15: getT(c15m), h1: getT(c1h), h4: getT(c4h), d1: getT(c1d) } };
      setCurrentPrice(last.close); setAnalysis(nAnalysis);
      if (isRunning) {
          if (position) {
              const isL = position.type === 'LONG';
              const p = isL ? (last.close - position.entryPrice) * (position.size / position.entryPrice) : (position.entryPrice - last.close) * (position.size / position.entryPrice);
              let reason = '';
              if ((isL && last.close <= position.liquidationPrice) || (!isL && last.close >= position.liquidationPrice)) reason = 'LIQUIDATION';
              else if ((isL && last.close >= position.tpPrice) || (!isL && last.close <= position.tpPrice)) reason = 'TAKE PROFIT';
              else if ((isL && last.close <= position.slPrice) || (!isL && last.close >= position.slPrice)) reason = 'STOP LOSS';
              if (reason) {
                  const cFee = position.size * CONFIG.FEE;
                  const net = p - cFee - position.openFee;
                  setHistory(prev => [{ id: Date.now().toString(), type: position.type, entryPrice: position.entryPrice, exitPrice: last.close, pnl: net, pnlPercent: (net/position.margin)*100, reason, time: Date.now(), fee: position.openFee + cFee }, ...prev]);
                  setAccount(acc => ({ balance: acc.balance + position.margin + (p - cFee), pnlHistory: acc.pnlHistory + net }));
                  setPosition(null);
                  sendTelegram(`${net > 0 ? '✅' : '❌'} <b>ĐÓNG ${position.type}</b>\nLãi: ${net.toFixed(2)} USDT\nLý do: ${reason}`);
                  addLog(`ĐÓNG ${position.type}: ${net.toFixed(2)} USDT`, net > 0 ? 'success' : 'danger');
              }
          } else {
              const now = Date.now();
              const trends = [nAnalysis.mtfTrends.m15, nAnalysis.mtfTrends.h1, nAnalysis.mtfTrends.h4, nAnalysis.mtfTrends.d1];
              const upS = trends.filter(t => t === 'UP').length;
              const downS = trends.filter(t => t === 'DOWN').length;
              const inB = nAnalysis.obs.find(o => o.type === 'BULLISH') && last.close <= (nAnalysis.obs.find(o => o.type === 'BULLISH')?.top || 0) && last.close >= (nAnalysis.obs.find(o => o.type === 'BULLISH')?.bottom || 0) * 0.999;
              const inS = nAnalysis.obs.find(o => o.type === 'BEARISH') && last.close >= (nAnalysis.obs.find(o => o.type === 'BEARISH')?.bottom || 0) && last.close <= (nAnalysis.obs.find(o => o.type === 'BEARISH')?.top || 0) * 1.001;
              if (last.volume > (nAnalysis.volSma * CONFIG.VOL_MULTIPLIER) && nAnalysis.rsi < CONFIG.RSI_OVERSOLD && (nAnalysis.fvg === 'BULLISH' || inB) && upS >= 3) {
                  const sz = account.balance * CONFIG.LEVERAGE; const f = sz * CONFIG.FEE;
                  setAccount(acc => ({ ...acc, balance: acc.balance - account.balance }));
                  setPosition({ type: 'LONG', entryPrice: last.close, margin: account.balance - f, size: sz, tpPrice: last.close * (1 + CONFIG.TP_PERCENT), slPrice: last.close * (1 - CONFIG.SL_PERCENT), liquidationPrice: last.close * (1 - 1/CONFIG.LEVERAGE), openFee: f, openTime: now });
                  sendTelegram(`🚀 <b>MỞ LONG</b>\nGiá: ${last.close.toFixed(2)}`); addLog(`MỞ LONG: SMC + MTF`, 'success');
              } else if (last.volume > (nAnalysis.volSma * CONFIG.VOL_MULTIPLIER) && nAnalysis.rsi > CONFIG.RSI_OVERBOUGHT && (nAnalysis.fvg === 'BEARISH' || inS) && downS >= 3) {
                  const sz = account.balance * CONFIG.LEVERAGE; const f = sz * CONFIG.FEE;
                  setAccount(acc => ({ ...acc, balance: acc.balance - account.balance }));
                  setPosition({ type: 'SHORT', entryPrice: last.close, margin: account.balance - f, size: sz, tpPrice: last.close * (1 - CONFIG.TP_PERCENT), slPrice: last.close * (1 + CONFIG.SL_PERCENT), liquidationPrice: last.close * (1 + 1/CONFIG.LEVERAGE), openFee: f, openTime: now });
                  sendTelegram(`🔥 <b>MỞ SHORT</b>\nGiá: ${last.close.toFixed(2)}`); addLog(`MỞ SHORT: SMC + MTF`, 'danger');
              } else if (now - lastALogTime.current > 60000) {
                  addLog(`AI: Xu hướng ${upS >= 3 ? 'Tăng' : downS >= 3 ? 'Giảm' : 'Sideway'} | Score:${upS}-${downS}`, 'analysis');
                  lastALogTime.current = now;
              }
          }
      }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, c15m, c1h, c4h, c1d]); 

  const { pnl: uPnl, roe: uRoe } = position ? (() => {
      const p = position.type === 'LONG' ? (currentPrice - position.entryPrice) * (position.size / position.entryPrice) : (position.entryPrice - currentPrice) * (position.size / position.entryPrice);
      return { pnl: p, roe: (p / position.margin) * 100 };
  })() : { pnl: 0, roe: 0 };

  useEffect(() => {
      if (!isRunning) return;
      const t = setInterval(() => setForceRender(Date.now()), 1000);
      return () => clearInterval(t);
  }, [isRunning]);

  const renderCandles = () => {
    if (candles.length === 0) return null;
    const max = Math.max(...candles.map(c => c.high)); const min = Math.min(...candles.map(c => c.low)); const range = max - min;
    const getT = (v: number) => ((max - v) / range) * 100;
    return (
      <div className="flex items-end justify-between h-full w-full px-2 relative">
        {analysis.obs.map((ob, idx) => (
            <div key={idx} className={`absolute w-full border-y ${ob.type === 'BULLISH' ? 'bg-green-500/10 border-green-500/20' : 'bg-red-500/10 border-red-500/20'} z-0`} style={{ top: `${getT(ob.top)}%`, height: `${((ob.top - ob.bottom)/range)*100}%` }} />
        ))}
        <div className="absolute w-full border-t border-purple-500/30 z-10" style={{ top: `${getT(analysis.ema)}%` }} />
        {position && <div className="absolute w-full border-t border-yellow-400 z-20" style={{ top: `${getT(position.entryPrice)}%` }} />}
        {candles.map((c, i) => (
          <div key={i} className="flex-1 relative mx-[1px] group z-10" style={{ height: '100%' }}>
            <div className={`absolute w-[1px] left-1/2 -translate-x-1/2 ${c.isGreen ? 'bg-green-500' : 'bg-red-500'}`} style={{ height: `${((c.high-c.low)/range)*100}%`, top: `${getT(c.high)}%` }}></div>
            <div className={`absolute w-full ${c.isGreen ? 'bg-green-500' : 'bg-red-500'}`} style={{ height: `${Math.max((Math.abs(c.open-c.close)/range)*100, 1)}%`, top: `${getT(Math.max(c.open, c.close))}%` }}></div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[#0b0e11] text-gray-100 font-sans p-2 sm:p-4 md:p-6 flex flex-col gap-4">
      {showSettings && (
        <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
          <div className="bg-[#1e2329] p-6 rounded-lg border border-gray-700 max-w-md w-full shadow-2xl">
              <h2 className="text-lg font-bold mb-4">Cấu hình</h2>
              <div className="space-y-3">
                  <input value={tgToken} onChange={e => setTgToken(e.target.value)} placeholder="Bot Token" className="w-full bg-[#0b0e11] border border-gray-700 rounded p-2 text-sm text-white" />
                  <input value={tgChatId} onChange={e => setTgChatId(e.target.value)} placeholder="Chat ID" className="w-full bg-[#0b0e11] border border-gray-700 rounded p-2 text-sm text-white" />
              </div>
              <div className="mt-4 flex justify-end gap-2">
                  <button onClick={() => setShowSettings(false)} className="px-4 py-2 text-sm">Hủy</button>
                  <button onClick={() => { setShowSettings(false); addLog("Đã lưu cài đặt.", "success"); sendTelegram("✅ Bot đã kết nối!"); }} className="px-4 py-2 bg-blue-600 rounded text-sm font-bold">Lưu</button>
              </div>
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-12 flex justify-between items-center bg-[#1e2329] p-4 rounded-lg border border-gray-800">
          <div className="flex items-center gap-3">
            <Zap className="text-purple-500" />
            <div>
              <h1 className="text-base font-bold flex items-center gap-2 uppercase tracking-widest">PRO BOT V2 {isSimulation ? <WifiOff size={12} className="text-red-500"/> : <Wifi size={12} className="text-green-500 animate-pulse"/>}</h1>
              <div className="flex gap-2 mt-1">
                <button onClick={() => setShowSettings(true)} className="text-[10px] bg-gray-800 px-2 py-0.5 rounded flex items-center gap-1 hover:bg-gray-700 transition-colors"><Settings size={10}/> Cài đặt</button>
                <span className="text-[10px] text-gray-500">BTC/USDT x{CONFIG.LEVERAGE}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-right font-mono"><p className={`text-xl font-bold ${currentPrice >= (candles[candles.length-1]?.open || 0) ? 'text-green-500' : 'text-red-500'}`}>{currentPrice.toLocaleString()}</p></div>
            <button onClick={() => setIsRunning(!isRunning)} className={`px-6 py-2 rounded font-bold transition-all ${isRunning ? 'bg-red-500' : 'bg-green-500'}`}>{isRunning ? <Pause size={18}/> : <Play size={18}/>}</button>
          </div>
        </div>
        <div className="lg:col-span-7 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-[#1e2329] p-4 rounded-lg border border-gray-800 relative group overflow-hidden">
              <span className="text-[10px] text-gray-500 uppercase font-bold">Ví USDT</span>
              <p className="text-lg font-mono text-white">${account.balance.toFixed(2)}</p>
              <button onClick={() => { localStorage.clear(); window.location.reload(); }} className="absolute top-2 right-2 text-gray-700 hover:text-red-500"><RefreshCw size={12}/></button>
            </div>
            <div className={`bg-[#1e2329] p-4 rounded-lg border transition-all duration-300 ${position ? 'border-blue-500' : 'border-gray-800 opacity-50'}`}>
              <span className="text-[10px] text-gray-500 uppercase font-bold">Lệnh {position?.type || 'Trống'}</span>
              <p className={`text-lg font-mono ${uPnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>{uPnl.toFixed(2)} ({uRoe.toFixed(1)}%)</p>
            </div>
          </div>
          <div className="bg-[#1e2329] p-4 rounded-lg border border-gray-800 h-[300px] flex flex-col">
             <div className="flex justify-between mb-2 items-center"><h3 className="text-xs font-bold text-gray-400 uppercase flex items-center gap-2"><BarChart2 size={14}/> Biểu đồ M1</h3></div>
             <div className="flex-1 w-full relative">{renderCandles()}</div>
          </div>
          <div className="grid grid-cols-4 gap-2">
            <div className="bg-[#1e2329] p-2 rounded border border-gray-800 text-center flex flex-col justify-center">
                <span className="text-[9px] text-gray-500 block uppercase mb-1">RSI M1</span>
                <span className={`text-xs font-bold ${analysis.rsi > 65 ? 'text-red-500' : analysis.rsi < 35 ? 'text-green-500' : 'text-white'}`}>{analysis.rsi.toFixed(1)}</span>
            </div>
            {['15m', '1h', '4h', '1d'].map(tf => (
                <div key={tf} className="bg-[#1e2329] p-2 rounded border border-gray-800 text-center uppercase">
                    <span className="text-[9px] text-gray-500 block mb-1">{tf}</span>
                    <div className="flex justify-center">{analysis.mtfTrends[tf.toLowerCase() as keyof typeof analysis.mtfTrends] === 'UP' ? <TrendingUp size={14} className="text-green-500"/> : <TrendingDown size={14} className="text-red-500"/>}</div>
                </div>
            ))}
          </div>
        </div>
        <div className="lg:col-span-5 h-[520px] flex flex-col">
          <div className="bg-[#1e2329] rounded-lg border border-gray-800 flex flex-col flex-1 overflow-hidden">
             <div className="flex border-b border-gray-800 bg-[#252a30]">
                <button onClick={() => setActiveTab('LOGS')} className={`flex-1 py-3 text-xs font-bold ${activeTab === 'LOGS' ? 'bg-[#1e2329] text-blue-400 border-t-2 border-blue-400' : 'text-gray-500'}`}>NHẬT KÝ</button>
                <button onClick={() => setActiveTab('HISTORY')} className={`flex-1 py-3 text-xs font-bold ${activeTab === 'HISTORY' ? 'bg-[#1e2329] text-yellow-400 border-t-2 border-yellow-400' : 'text-gray-500'}`}>LỊCH SỬ</button>
             </div>
             <div className="flex-1 overflow-y-auto p-3 bg-[#0b0e11] font-mono custom-scrollbar">
               {activeTab === 'LOGS' ? (
                   <div className="space-y-2">
                       {logs.map((log, idx) => (
                         <div key={idx} className={`text-[10px] border-l-2 pl-2 py-1 leading-relaxed ${log.type === 'success' ? 'border-green-500 text-green-300' : log.type === 'danger' ? 'border-red-500 text-red-300' : log.type === 'analysis' ? 'border-blue-500 text-blue-200 italic' : 'border-gray-600 text-gray-400'}`}>{log.msg}</div>
                       ))}
                       <div ref={logsEndRef}/>
                   </div>
               ) : (
                   <div className="space-y-2">
                       {history.map((t) => (
                           <div key={t.id} className="bg-[#1e2329] p-2 rounded border border-gray-800 flex justify-between items-center text-[10px]">
                               <div><span className={`font-bold ${t.type === 'LONG' ? 'text-green-500' : 'text-red-500'}`}>{t.type}</span><p className="text-gray-500 text-[8px]">{new Date(t.time).toLocaleTimeString()}</p></div>
                               <div className="text-right"><p className={`font-bold ${t.pnl > 0 ? 'text-green-500' : 'text-red-500'}`}>{t.pnl.toFixed(2)} USDT</p></div>
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