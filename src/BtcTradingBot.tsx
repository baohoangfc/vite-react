import React, { useState, useEffect, useRef } from 'react';
import { Activity, Wallet, Play, Pause, BarChart2, Zap, Terminal, WifiOff, Wifi, XCircle, Clock, AlertTriangle, History, CheckCircle, X } from 'lucide-react';

// --- CẤU HÌNH ---
const CONFIG = {
  SYMBOL: 'BTCUSDT',
  INTERVAL: '1m',
  LIMIT_CANDLES: 60, 
  
  // Chỉ báo kỹ thuật
  RSI_PERIOD: 14,
  EMA_PERIOD: 50, 
  
  // Logic Tín hiệu
  RSI_OVERSOLD: 35, 
  RSI_OVERBOUGHT: 65,
  VOL_MULTIPLIER: 1.1, 
  
  // Quản lý vốn
  LEVERAGE: 50, 
  INITIAL_BALANCE: 10000,
  TP_PERCENT: 0.008, // 0.8% giá * 50 = 40% lãi
  SL_PERCENT: 0.004, // 0.4% giá * 50 = 20% lỗ
  FEE: 0.0004, 
  REFRESH_RATE: 2000, 
};

// --- TYPES ---
type Candle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  isGreen: boolean;
};

type Analysis = {
  rsi: number;
  ema: number;
  volSma: number;
  support: number;
  resistance: number;
  fvg: 'BULLISH' | 'BEARISH' | null; 
  trend: 'UP' | 'DOWN';
};

type TradeHistoryItem = {
  id: string;
  type: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice: number;
  pnl: number;
  pnlPercent: number;
  reason: string;
  time: number;
};

// --- HELPER FUNCTIONS ---
const calculateRSI = (candles: Candle[], period: number = 14) => {
  if (candles.length < period + 1) return 50;
  const prices = candles.map(c => c.close);
  let gains = 0, losses = 0;
  for (let i = prices.length - period - 1; i < prices.length - 1; i++) {
    const diff = prices[i + 1] - prices[i];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const currentDiff = prices[prices.length - 1] - prices[prices.length - 2];
  if (currentDiff >= 0) {
    avgGain = (avgGain * (period - 1) + currentDiff) / period;
    avgLoss = (avgLoss * (period - 1)) / period;
  } else {
    avgGain = (avgGain * (period - 1)) / period;
    avgLoss = (avgLoss * (period - 1) - currentDiff) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
};

const calculateEMA = (candles: Candle[], period: number) => {
  if (candles.length < period) return candles[candles.length - 1].close;
  const k = 2 / (period + 1);
  let ema = candles[0].close;
  for (let i = 1; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k);
  }
  return ema;
};

const findSupportResistance = (candles: Candle[]) => {
  if (candles.length < 20) return { support: 0, resistance: 0 };
  const window = candles.slice(candles.length - 31, candles.length - 1); 
  const support = Math.min(...window.map(c => c.low));
  const resistance = Math.max(...window.map(c => c.high));
  return { support, resistance };
};

const detectFVG = (candles: Candle[]): 'BULLISH' | 'BEARISH' | null => {
  if (candles.length < 3) return null;
  const c1 = candles[candles.length - 4]; 
  const c3 = candles[candles.length - 2]; 
  if (!c1 || !c3) return null;
  if (c3.low > c1.high) return 'BULLISH';
  if (c3.high < c1.low) return 'BEARISH';
  return null;
};

// --- MOCK DATA ---
const generateMockCandle = (lastCandle: Candle | null): Candle => {
    const now = Date.now();
    let open = lastCandle ? lastCandle.close : 95000;
    const change = (Math.random() - 0.5) * 100; 
    const close = open + change;
    const high = Math.max(open, close) + Math.random() * 20;
    const low = Math.min(open, close) - Math.random() * 20;
    const volume = Math.random() * 100;
    return { time: now, open, high, low, close, volume, isGreen: close >= open };
};

const generateInitialMockData = (count: number): Candle[] => {
    const candles: Candle[] = [];
    let lastCandle = null;
    for (let i = 0; i < count; i++) {
        const candle = generateMockCandle(lastCandle);
        candle.time = Date.now() - (count - i) * 60000;
        candles.push(candle);
        lastCandle = candle;
    }
    return candles;
};

// --- MAIN COMPONENT ---
export default function BitcoinTradingBot() {
  const [candles, setCandles] = useState<Candle[]>([]);
  const [currentPrice, setCurrentPrice] = useState<number>(0);
  const [analysis, setAnalysis] = useState<Analysis>({
    rsi: 50, ema: 0, volSma: 0, support: 0, resistance: 0, fvg: null, trend: 'UP'
  });
  
  const [isRunning, setIsRunning] = useState(false);
  const [isSimulation, setIsSimulation] = useState(false);
  const [logs, setLogs] = useState<{msg: string, type: string}[]>([]);
  const [mode, setMode] = useState<'AUTO' | 'MANUAL'>('AUTO');
  const [activeTab, setActiveTab] = useState<'LOGS' | 'HISTORY'>('LOGS');
  
  // Trading State
  const [account, setAccount] = useState({ balance: CONFIG.INITIAL_BALANCE, pnlHistory: 0 });
  const [position, setPosition] = useState<{
    type: 'LONG' | 'SHORT';
    entryPrice: number;
    margin: number;
    size: number;
    tpPrice: number;
    slPrice: number;
    liquidationPrice: number;
    openFee: number;
    openTime: number;
  } | null>(null);
  
  const [history, setHistory] = useState<TradeHistoryItem[]>([]);

  const logsEndRef = useRef<HTMLDivElement>(null);
  const lastAnalysisLogTime = useRef<number>(0); 

  useEffect(() => { logsEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [logs, activeTab]);

  const addLog = (message: string, type: 'info' | 'success' | 'danger' | 'warning' | 'analysis' = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    setLogs(prev => [...prev.slice(-99), { msg: `[${timestamp}] ${message}`, type }]);
  };

  const processAndSetData = (newCandles: Candle[]) => {
    const lastCandle = newCandles[newCandles.length - 1];
    
    const rsi = calculateRSI(newCandles, CONFIG.RSI_PERIOD);
    const ema = calculateEMA(newCandles, CONFIG.EMA_PERIOD);
    const vols = newCandles.map(c => c.volume);
    const volSma = vols.slice(Math.max(0, vols.length - 20)).reduce((a, b) => a + b, 0) / 20;
    const { support, resistance } = findSupportResistance(newCandles);
    const fvg = detectFVG(newCandles);
    const trend = lastCandle.close > ema ? 'UP' : 'DOWN';

    setCandles(newCandles);
    setCurrentPrice(lastCandle.close);
    setAnalysis({ rsi, ema, volSma, support, resistance, fvg, trend });
    
    return { currentPrice: lastCandle.close, analysis: { rsi, ema, volSma, support, resistance, fvg, trend } };
  };

  // --- INITIALIZATION ---
  useEffect(() => {
    const init = async () => {
      try {
        const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${CONFIG.SYMBOL}&interval=${CONFIG.INTERVAL}&limit=${CONFIG.LIMIT_CANDLES}`);
        if (!res.ok) throw new Error("Network response was not ok");
        const data = await res.json();
        const formattedCandles: Candle[] = data.map((k: any) => ({
            time: k[0],
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            volume: parseFloat(k[5]),
            isGreen: parseFloat(k[4]) >= parseFloat(k[1])
        }));
        processAndSetData(formattedCandles);
        addLog("Đã kết nối Binance thành công.", 'info');
        setIsSimulation(false);
      } catch (e) { 
        addLog("Lỗi kết nối API. Chuyển sang chế độ GIẢ LẬP.", 'warning');
        const mockCandles = generateInitialMockData(CONFIG.LIMIT_CANDLES);
        processAndSetData(mockCandles);
        setIsSimulation(true);
      }
    };
    init();
  }, []);

  // --- MAIN LOOP ---
  useEffect(() => {
    if (!isRunning) return;
    
    const interval = setInterval(async () => {
      if (isSimulation) {
          setCandles(prev => {
              const lastCandle = prev[prev.length - 1];
              const newCandle = generateMockCandle(lastCandle);
              const updatedCandles = [...prev.slice(1), newCandle];
              const { currentPrice, analysis } = processAndSetData(updatedCandles);
              if (mode === 'AUTO') runBotStrategy(currentPrice, newCandle.volume, analysis);
              if (position) checkExit(currentPrice);
              return updatedCandles;
          });
      } else {
          try {
            const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${CONFIG.SYMBOL}&interval=${CONFIG.INTERVAL}&limit=${CONFIG.LIMIT_CANDLES}`);
            if (!res.ok) throw new Error("Fetch failed");
            const data = await res.json();
            const formattedCandles: Candle[] = data.map((k: any) => ({
                time: k[0],
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                volume: parseFloat(k[5]),
                isGreen: parseFloat(k[4]) >= parseFloat(k[1])
            }));
            const { currentPrice, analysis } = processAndSetData(formattedCandles);
            if (mode === 'AUTO') runBotStrategy(currentPrice, formattedCandles[formattedCandles.length - 1].volume, analysis);
            if (position) checkExit(currentPrice);
          } catch (e) { /* silent fail */ }
      }
    }, CONFIG.REFRESH_RATE);
    return () => clearInterval(interval);
  }, [isRunning, position, account, mode, isSimulation]);

  // --- TRADING LOGIC ---
  const runBotStrategy = (price: number, vol: number, a: Analysis) => {
    const now = Date.now();
    const shouldLogAnalysis = now - lastAnalysisLogTime.current > 15000; // Log mỗi 15 giây

    if (position) {
        if (shouldLogAnalysis) {
            const pnl = position.type === 'LONG' ? (price - position.entryPrice) : (position.entryPrice - price);
            addLog(`Đang gồng lời/lỗ: ${pnl > 0 ? 'Lãi' : 'Lỗ'} nhẹ. Xu hướng ${a.trend}. Chờ TP/SL...`, 'analysis');
            lastAnalysisLogTime.current = now;
        }
        return;
    }
    
    if (account.balance < 10) return;

    // Phân tích chi tiết
    const isVolOk = vol > (a.volSma * CONFIG.VOL_MULTIPLIER);
    const volRatio = (vol / (a.volSma || 1)).toFixed(1); 
    const isNearSupport = Math.abs(price - a.support) / price < 0.0015;
    const isNearResist = Math.abs(price - a.resistance) / price < 0.0015;

    // Điều kiện Long
    const longReason = a.fvg === 'BULLISH' ? 'Lấp FVG Tăng' : (isNearSupport ? 'Chạm Hỗ trợ' : '');
    const canLong = isVolOk && a.rsi < CONFIG.RSI_OVERSOLD && (longReason !== '');

    // Điều kiện Short
    const shortReason = a.fvg === 'BEARISH' ? 'Lấp FVG Giảm' : (isNearResist ? 'Chạm Kháng cự' : '');
    const canShort = isVolOk && a.rsi > CONFIG.RSI_OVERBOUGHT && (shortReason !== '');

    if (canLong) {
      executeOrder('LONG', price, account.balance);
      addLog(`MỞ LONG: ${longReason} + Vol đột biến (${volRatio}x) + RSI ${a.rsi.toFixed(0)}`, 'success');
      return;
    }
    if (canShort) {
      executeOrder('SHORT', price, account.balance);
      addLog(`MỞ SHORT: ${shortReason} + Vol đột biến (${volRatio}x) + RSI ${a.rsi.toFixed(0)}`, 'danger');
      return;
    }

    // Log suy nghĩ (Reasoning)
    if (shouldLogAnalysis) {
        let thought = "";
        if (!isVolOk) thought = `Volume ${volRatio}x chưa đạt yêu cầu (>1.1x). `;
        else thought = `Volume tốt (${volRatio}x). `;

        if (a.rsi > 40 && a.rsi < 60) {
            thought += `Nhưng RSI ${a.rsi.toFixed(0)} đang ở vùng trung lập (Sideway), chưa rõ xu hướng.`;
        } else if (a.rsi <= 40) {
            thought += `RSI thấp (${a.rsi.toFixed(0)}). Đang rình tín hiệu Long tại hỗ trợ ${a.support.toFixed(0)}...`;
        } else if (a.rsi >= 60) {
            thought += `RSI cao (${a.rsi.toFixed(0)}). Đang canh Short tại kháng cự ${a.resistance.toFixed(0)}...`;
        }
        
        addLog(`AI Suy nghĩ: ${thought}`, 'analysis');
        lastAnalysisLogTime.current = now;
    }
  };

  const executeOrder = (type: 'LONG' | 'SHORT', price: number, margin: number) => {
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

    setAccount(prev => ({ ...prev, balance: prev.balance - fee }));
    setPosition({ 
        type, entryPrice: price, margin: realMargin, size, 
        tpPrice: tp, slPrice: sl, liquidationPrice: liq, 
        openFee: fee, openTime: Date.now()
    });
  };

  const closePosition = (reason: string, pnl: number, currentPrice: number) => {
      if (!position) return;
      const closeFee = position.size * CONFIG.FEE;
      const finalPnl = pnl - closeFee;
      
      // Cập nhật số dư (Cộng lại Margin gốc + Lời/Lỗ ròng)
      const newBalance = account.balance + position.margin + finalPnl;
      
      // Lưu lịch sử
      const newTrade: TradeHistoryItem = {
          id: Date.now().toString(),
          type: position.type,
          entryPrice: position.entryPrice,
          exitPrice: currentPrice,
          pnl: finalPnl,
          pnlPercent: (finalPnl / position.margin) * 100,
          reason: reason,
          time: Date.now()
      };

      setHistory(prev => [newTrade, ...prev]);
      setAccount({ balance: newBalance, pnlHistory: account.pnlHistory + finalPnl });
      setPosition(null);
      
      const logType = finalPnl > 0 ? 'success' : 'danger';
      addLog(`ĐÓNG ${position.type} (${reason}): ${finalPnl > 0 ? '+' : ''}${finalPnl.toFixed(2)} USDT`, logType);
  };

  const checkExit = (price: number) => {
    if (!position) return;
    let reason = '', pnl = 0;
    
    // Tính PnL thô (chưa trừ phí đóng)
    if (position.type === 'LONG') {
      pnl = (price - position.entryPrice) * (position.size / position.entryPrice);
      if (price <= position.liquidationPrice) reason = 'LIQUIDATION';
      else if (price >= position.tpPrice) reason = 'TAKE PROFIT';
      else if (price <= position.slPrice) reason = 'STOP LOSS';
    } else {
      pnl = (position.entryPrice - price) * (position.size / position.entryPrice);
      if (price >= position.liquidationPrice) reason = 'LIQUIDATION';
      else if (price <= position.tpPrice) reason = 'TAKE PROFIT';
      else if (price >= position.slPrice) reason = 'STOP LOSS';
    }

    if (reason) closePosition(reason, pnl, price);
  };

  const getUnrealizedPnl = () => {
    if (!position) return { pnl: 0, roe: 0 };
    let pnl = 0;
    if (position.type === 'LONG') pnl = (currentPrice - position.entryPrice) * (position.size / position.entryPrice);
    else pnl = (position.entryPrice - currentPrice) * (position.size / position.entryPrice);
    const roe = (pnl / position.margin) * 100;
    return { pnl, roe };
  };

  const { pnl: unrealizedPnl, roe: unrealizedRoe } = getUnrealizedPnl();
  const equity = account.balance + (position ? position.margin + unrealizedPnl : 0);
  
  // Winrate Stats
  const totalTrades = history.length;
  const winTrades = history.filter(t => t.pnl > 0).length;
  const winRate = totalTrades > 0 ? ((winTrades / totalTrades) * 100).toFixed(1) : 0;

  // Render Candles & Lines
  const renderCandles = () => {
    if (candles.length === 0) return null;
    const maxPrice = Math.max(...candles.map(c => c.high));
    const minPrice = Math.min(...candles.map(c => c.low));
    const range = maxPrice - minPrice;

    const renderLine = (value: number, colorClass: string, textClass: string, label: string, style: string = 'dashed') => {
        if (value < minPrice || value > maxPrice) return null;
        const top = ((maxPrice - value) / range) * 100;
        return (
            <div className={`absolute w-full border-t ${colorClass} border-${style} opacity-80 text-[10px] ${textClass} z-10`} style={{ top: `${top}%` }}>
                <span className="bg-[#1e2329]/90 px-1 absolute right-0 -translate-y-1/2">{label} {value.toFixed(0)}</span>
            </div>
        );
    };

    return (
      <div className="flex items-end justify-between h-full w-full px-2 relative">
        {renderLine(analysis.support, 'border-green-500/30', 'text-green-500/50', 'Sup')}
        {renderLine(analysis.resistance, 'border-red-500/30', 'text-red-500/50', 'Res')}
        {position && (
            <>
                {renderLine(position.entryPrice, 'border-yellow-400', 'text-yellow-400 font-bold', 'Entry')}
                {renderLine(position.type === 'LONG' ? position.entryPrice * (1 + 2 * CONFIG.FEE) : position.entryPrice * (1 - 2 * CONFIG.FEE), 'border-gray-400', 'text-gray-400', 'BE', 'dotted')}
            </>
        )}
        {candles.map((c, i) => {
          const heightPercent = ((c.high - c.low) / range) * 100;
          const topPercent = ((maxPrice - c.high) / range) * 100;
          const bodyTopPercent = ((maxPrice - Math.max(c.open, c.close)) / range) * 100;
          const bodyHeightPercent = ((Math.abs(c.open - c.close)) / range) * 100;
          return (
            <div key={i} className="flex-1 relative mx-[1px] group" style={{ height: '100%' }}>
              <div className={`absolute w-[1px] left-1/2 -translate-x-1/2 ${c.isGreen ? 'bg-[#0ecb81]' : 'bg-[#f6465d]'}`} style={{ height: `${heightPercent}%`, top: `${topPercent}%` }}></div>
              <div className={`absolute w-full ${c.isGreen ? 'bg-[#0ecb81]' : 'bg-[#f6465d]'}`} style={{ height: `${Math.max(bodyHeightPercent, 0.5)}%`, top: `${bodyTopPercent}%` }}></div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-[#0b0e11] text-gray-100 font-sans p-4 md:p-6">
      <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        
        {/* HEADER */}
        <div className="lg:col-span-12 flex flex-col md:flex-row justify-between items-center bg-[#1e2329] p-4 rounded-lg shadow-lg border border-gray-800">
          <div className="flex items-center gap-4">
            <div className="p-2 bg-purple-600 rounded text-white font-bold"><Zap size={24} /></div>
            <div>
              <h1 className="text-xl font-bold text-white flex items-center gap-2">
                PRO TRADING BOT V2
                {isSimulation ? <span className="bg-yellow-600 text-[10px] px-2 py-0.5 rounded text-white flex items-center gap-1"><WifiOff size={10}/> SIMUL</span> : 
                               <span className="bg-green-600 text-[10px] px-2 py-0.5 rounded text-white flex items-center gap-1"><Wifi size={10}/> LIVE</span>}
              </h1>
              <div className="flex items-center gap-2 text-xs text-gray-400 mt-1">
                 <button onClick={() => setMode('AUTO')} className={`px-3 py-1 rounded ${mode === 'AUTO' ? 'bg-blue-600 text-white' : 'bg-gray-700'}`}>Auto AI</button>
                 <span className="ml-2 border-l border-gray-600 pl-2">x{CONFIG.LEVERAGE}</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-6">
             <div className="text-right">
                <p className="text-xs text-gray-400">BTC/USDT</p>
                <p className={`text-2xl font-mono font-bold ${candles.length > 0 && currentPrice >= candles[candles.length-1].open ? 'text-[#0ecb81]' : 'text-[#f6465d]'}`}>
                  {currentPrice.toLocaleString(undefined, {minimumFractionDigits: 2})}
                </p>
             </div>
             <button onClick={() => setIsRunning(!isRunning)} className={`flex items-center gap-2 px-6 py-2 rounded font-bold ${isRunning ? 'bg-[#f6465d]' : 'bg-[#0ecb81]'}`}>
                {isRunning ? <><Pause size={18} /> STOP</> : <><Play size={18} /> START</>}
             </button>
          </div>
        </div>

        {/* LEFT COLUMN: 5/12 */}
        <div className="lg:col-span-5 space-y-4 w-full">
          
          {/* CHART */}
          <div className="bg-[#1e2329] p-4 rounded-lg border border-gray-800 h-[220px] relative flex flex-col">
             <div className="flex justify-between mb-2 z-10">
                <h3 className="text-sm font-semibold text-gray-300 flex items-center gap-2"><BarChart2 size={16}/> Biểu đồ M1</h3>
             </div>
             <div className="flex-1 w-full relative border-t border-gray-800 pt-2">{renderCandles()}</div>
          </div>

          {/* INDICATORS */}
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-[#1e2329] p-3 rounded-lg border border-gray-800">
               <span className="text-xs text-gray-400 block mb-1">RSI (14)</span>
               <div className="flex items-end justify-between">
                 <span className={`text-lg font-bold ${analysis.rsi > 70 ? 'text-red-500' : analysis.rsi < 30 ? 'text-green-500' : 'text-white'}`}>{analysis.rsi.toFixed(1)}</span>
                 <div className="h-1.5 w-12 bg-gray-700 rounded-full"><div className="h-full bg-blue-500" style={{width: `${analysis.rsi}%`}}></div></div>
               </div>
            </div>
            <div className="bg-[#1e2329] p-3 rounded-lg border border-gray-800">
               <span className="text-xs text-gray-400 block mb-1">Volume</span>
               <span className={`text-sm font-bold ${candles.length > 0 && candles[candles.length-1].volume > analysis.volSma * CONFIG.VOL_MULTIPLIER ? 'text-yellow-400' : 'text-gray-400'}`}>
                  {candles.length > 0 && (candles[candles.length-1].volume / (analysis.volSma || 1)).toFixed(1)}x TB
               </span>
            </div>
          </div>

          {/* WALLET & EQUITY */}
          <div className="bg-[#1e2329] p-4 rounded-lg border border-gray-800 space-y-3">
            <div className="flex justify-between items-center">
                <span className="text-gray-400 text-xs flex items-center gap-1"><Wallet size={14}/> Số dư khả dụng</span>
                <span className="text-white font-mono">${account.balance.toFixed(2)}</span>
            </div>
            <div className="flex justify-between items-center pt-2 border-t border-gray-700">
                <span className="text-gray-300 text-sm font-bold">Tổng tài sản ròng (Equity)</span>
                <span className={`text-xl font-mono font-bold ${equity >= CONFIG.INITIAL_BALANCE ? 'text-green-400' : 'text-red-400'}`}>${equity.toFixed(2)}</span>
            </div>
          </div>

          {/* POSITION DETAILS */}
          <div className={`p-3 rounded-lg border ${position ? 'bg-[#1e2329] border-gray-700' : 'bg-[#1e2329] border-gray-800 opacity-50'}`}>
            <h3 className="text-gray-300 text-sm font-semibold mb-2 flex justify-between">
               <span>Lệnh đang mở</span>
               {position && <span className={`text-xs px-2 rounded ${position.type === 'LONG' ? 'bg-green-600' : 'bg-red-600'}`}>{position.type} x{CONFIG.LEVERAGE}</span>}
            </h3>
            {position ? (
              <div className="space-y-2 text-xs">
                <div className="flex justify-between items-center bg-gray-900/50 p-2 rounded mb-2">
                    <span className="text-gray-400">PnL (ROE)</span>
                    <span className={`font-mono font-bold text-lg ${unrealizedPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        {unrealizedPnl > 0 ? '+' : ''}{unrealizedPnl.toFixed(2)} ({unrealizedRoe.toFixed(2)}%)
                    </span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[11px] mb-2 px-1">
                    <div className="flex justify-between"><span className="text-gray-500">Entry</span><span className="text-gray-200">{position.entryPrice.toLocaleString(undefined, {minimumFractionDigits: 1})}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Margin</span><span className="text-gray-200">{position.margin.toFixed(1)}</span></div>
                </div>
                <div className="grid grid-cols-2 gap-4 text-center border-t border-gray-700 pt-2">
                   <div>
                       <span className="block text-gray-500 text-[10px] mb-1">TAKE PROFIT</span>
                       <span className="text-green-400 font-bold text-base">{position.tpPrice.toFixed(1)}</span>
                   </div>
                   <div>
                       <span className="block text-gray-500 text-[10px] mb-1">STOP LOSS</span>
                       <span className="text-red-400 font-bold text-base">{position.slPrice.toFixed(1)}</span>
                   </div>
                </div>
                <button onClick={() => closePosition('MANUAL', position.type === 'LONG' ? (currentPrice - position.entryPrice) * (position.size / position.entryPrice) : (position.entryPrice - currentPrice) * (position.size / position.entryPrice), currentPrice)} 
                        className="w-full mt-2 bg-slate-700 hover:bg-slate-600 text-white text-xs py-2 rounded transition-colors border border-slate-600 flex justify-center items-center gap-1">
                    <XCircle size={14}/> Đóng lệnh ngay
                </button>
              </div>
            ) : <div className="h-40 flex items-center justify-center text-xs text-gray-600 italic">Đang chờ tín hiệu...</div>}
          </div>
        </div>

        {/* RIGHT COLUMN: 7/12 */}
        <div className="lg:col-span-7 space-y-4 w-full">
          <div className="bg-[#1e2329] rounded-lg border border-gray-800 flex flex-col h-[650px]">
             {/* TABS */}
             <div className="flex border-b border-gray-800 bg-[#252a30] rounded-t-lg overflow-hidden">
                <button 
                    onClick={() => setActiveTab('LOGS')}
                    className={`flex-1 py-3 text-xs font-bold flex items-center justify-center gap-2 ${activeTab === 'LOGS' ? 'bg-[#1e2329] text-blue-400 border-t-2 border-blue-400' : 'text-gray-500 hover:text-gray-300'}`}
                >
                    <Terminal size={14}/> NHẬT KÝ AI
                </button>
                <button 
                    onClick={() => setActiveTab('HISTORY')}
                    className={`flex-1 py-3 text-xs font-bold flex items-center justify-center gap-2 ${activeTab === 'HISTORY' ? 'bg-[#1e2329] text-yellow-400 border-t-2 border-yellow-400' : 'text-gray-500 hover:text-gray-300'}`}
                >
                    <History size={14}/> LỊCH SỬ ({winRate}%)
                </button>
             </div>

             {/* CONTENT */}
             <div className="flex-1 overflow-y-auto p-3 custom-scrollbar bg-[#0b0e11] font-mono">
               {activeTab === 'LOGS' ? (
                   // LOGS VIEW
                   <div className="space-y-2">
                       {logs.length > 10 && <div className="text-center text-gray-700 text-[10px] py-1 italic">... lịch sử cũ ...</div>}
                       {logs.slice(-10).map((log, i) => (
                         <div key={i} className={`text-xs border-l-2 pl-3 py-2 leading-relaxed rounded-r
                            ${log.type === 'success' ? 'border-green-500 text-green-300 bg-green-900/10' : 
                              log.type === 'danger' ? 'border-red-500 text-red-300 bg-red-900/10' : 
                              log.type === 'analysis' ? 'border-blue-500 text-blue-200 bg-blue-900/5 italic' : 'border-gray-600 text-gray-400'}`}>
                            {log.msg}
                         </div>
                       ))}
                       <div ref={logsEndRef}/>
                   </div>
               ) : (
                   // HISTORY VIEW
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
