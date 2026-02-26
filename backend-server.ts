import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import admin from 'firebase-admin';
import { CONFIG } from './src/config';
import { calculateZLEMA, calculateSMA, calculateRSI, getMACD, detectSMC, calculateScores } from './src/utils/indicators';
import { Candle, Analysis, MTFSentiment } from './src/types';

const port = Number(process.env.PORT || 3001);
const BINANCE_KLINES = 'https://api.binance.com/api/v3/klines';
const RUNTIME_STORE_PATH = resolve(process.cwd(), '.runtime-state.json');

// Khởi tạo Firebase Admin
try {
  if (existsSync(resolve(process.cwd(), 'service-account.json'))) {
    const serviceAccount = JSON.parse(readFileSync(resolve(process.cwd(), 'service-account.json'), 'utf-8'));
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin Initialized Successfully");
  } else {
    console.log("WARNING: service-account.json not found. Firebase syncing will not work.");
  }
} catch (e) {
  console.error("Failed to initialize Firebase Admin:", e);
}

const db = admin.apps.length ? admin.firestore() : null;

const getDayKey = () => new Date().toISOString().slice(0, 10);

const runtimeState: any = {
  isRunning: false,
  startedAt: null,
  token: '',
  chatId: '',
  symbol: CONFIG.SYMBOL,
  heartbeatMs: CONFIG.HEARTBEAT_MS,
  heartbeatTimer: null,
  engineTimer: null,
  position: null,
  balance: CONFIG.INITIAL_BALANCE,
  pnlHistory: 0,
  lastSignalAt: 0,
  dayKey: getDayKey(),
  pnlToday: 0,
  tradesToday: 0,
  consecutiveErrors: 0,
  pausedReason: '',
  uid: '',
  appId: '',
};

const persistRuntimeState = () => {
  const payload = { ...runtimeState };
  delete payload.heartbeatTimer;
  delete payload.engineTimer;
  writeFileSync(RUNTIME_STORE_PATH, JSON.stringify(payload, null, 2));
};

const restoreRuntimeState = () => {
  if (!existsSync(RUNTIME_STORE_PATH)) return;
  try {
    const data = JSON.parse(readFileSync(RUNTIME_STORE_PATH, 'utf-8'));
    Object.assign(runtimeState, data);
  } catch (_error) { }
};

const json = (res: ServerResponse, statusCode: number, payload: any) => {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(payload));
};

const sendTelegram = async (text: string) => {
  if (!runtimeState.token || !runtimeState.chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${runtimeState.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: runtimeState.chatId, text, parse_mode: 'HTML' }),
    });
  } catch (_error) { }
};

const stopHeartbeat = () => {
  if (runtimeState.heartbeatTimer) {
    clearInterval(runtimeState.heartbeatTimer);
    runtimeState.heartbeatTimer = null;
  }
};

const startHeartbeat = () => {
  stopHeartbeat();
  runtimeState.heartbeatTimer = setInterval(() => {
    const posText = runtimeState.position ? `${runtimeState.position.type} @ ${runtimeState.position.entryPrice.toFixed(2)}` : 'Không có lệnh mở';
    sendTelegram(
      `💓 <b>BOT BACKGROUND ĐANG CHẠY</b>\n• Cặp: ${runtimeState.symbol}\n• Uptime: ${Math.floor((Date.now() - Number(runtimeState.startedAt || Date.now())) / 60000)} phút\n• Position: ${posText}\n• Balance: ${runtimeState.balance.toFixed(2)} USDT\n• PnL hôm nay: ${runtimeState.pnlToday.toFixed(2)} USDT`,
    );
  }, runtimeState.heartbeatMs);
};

const refreshDailyState = () => {
  const currentDay = getDayKey();
  if (runtimeState.dayKey !== currentDay) {
    runtimeState.dayKey = currentDay;
    runtimeState.pnlToday = 0;
    runtimeState.tradesToday = 0;
    runtimeState.pausedReason = '';
    persistRuntimeState();
  }
};

const enforceRiskGuards = async () => {
  refreshDailyState();
  if (runtimeState.pnlToday <= -Math.abs(100)) { // 100 USDT max daily loss
    runtimeState.pausedReason = `Đạt ngưỡng lỗ ngày 100 USDT`;
  } else if (runtimeState.tradesToday >= 25) { // 25 trades max
    runtimeState.pausedReason = `Đạt giới hạn 25 lệnh/ngày`;
  }

  if (runtimeState.pausedReason) {
    runtimeState.isRunning = false;
    runtimeState.startedAt = null;
    stopEngine();
    stopHeartbeat();
    persistRuntimeState();
    await sendTelegram(`⛔ <b>BACKGROUND BOT PAUSED</b>\n• ${runtimeState.pausedReason}`);
    return false;
  }
  return true;
};

// --- TÍCH HỢP FIREBASE THỰC SỰ ---
const syncToFirebase = async (updates: any) => {
  if (!db || !runtimeState.uid || !runtimeState.appId) return;
  try {
    const userRef = db.doc(`artifacts/${runtimeState.appId}/users/${runtimeState.uid}/account/data`);
    await userRef.set(updates, { merge: true });
  } catch (e) {
    console.error("Firebase sync error:", e);
  }
};

const syncHistoryToFirebase = async (trade: any) => {
  if (!db || !runtimeState.uid || !runtimeState.appId) return;
  try {
    const histRef = db.doc(`artifacts/${runtimeState.appId}/users/${runtimeState.uid}/history/${Date.now()}`);
    await histRef.set(trade);
  } catch (e) {
    console.error("Firebase history error:", e);
  }
};

const syncPositionToFirebase = async (activePos: any) => {
  if (!db || !runtimeState.uid || !runtimeState.appId) return;
  try {
    const posRef = db.doc(`artifacts/${runtimeState.appId}/users/${runtimeState.uid}/position/active`);
    await posRef.set({ active: !!activePos, details: activePos }, { merge: true });
  } catch (e) {
    console.error("Firebase position error:", e);
  }
}

// --- LOGIC THUẬT TOÁN ĐA KHUNG SMC ---
const fetchCandles = async (interval: string, limit: number): Promise<Candle[]> => {
  const query = new URLSearchParams({ symbol: runtimeState.symbol, interval, limit: String(limit) });
  const response = await fetch(`${BINANCE_KLINES}?${query.toString()}`);
  if (!response.ok) throw new Error(`Failed to fetch candles (${response.status})`);
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length < limit - 2) throw new Error('Not enough candle data');
  return rows.map((k: any) => ({ time: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]), isGreen: Number(k[4]) >= Number(k[1]) }));
};

const openPosition = async (type: string, price: number, signalTime: number, score: number, setup: string) => {
  const size = 50 * CONFIG.LEVERAGE; // 50 margin hardcoded for Demo
  const fee = size * CONFIG.FEE;
  const realMargin = 50 - fee;

  const tpPrice = type === 'LONG' ? price * (1 + CONFIG.TP_PERCENT) : price * (1 - CONFIG.TP_PERCENT);
  const slPrice = type === 'LONG' ? price * (1 - CONFIG.SL_PERCENT) : price * (1 + CONFIG.SL_PERCENT);
  const liquidationPrice = type === 'LONG' ? price * (1 - 1 / CONFIG.LEVERAGE) : price * (1 + 1 / CONFIG.LEVERAGE);

  runtimeState.position = {
    type,
    entryPrice: price,
    margin: realMargin,
    size,
    tpPrice,
    slPrice,
    liquidationPrice,
    openFee: fee,
    openTime: signalTime,
    signalDetail: { setup, score, isBreakeven: false },
  };
  runtimeState.balance -= 50;
  runtimeState.lastSignalAt = signalTime;
  persistRuntimeState();

  await syncPositionToFirebase(runtimeState.position);
  await syncToFirebase({ balance: runtimeState.balance });

  await sendTelegram(`🚀 <b>BACKGROUND MỞ ${type} (SMC)</b>\n• Điểm: ${score}/5\n• Setup: ${setup}\n• Giá: ${price.toFixed(2)}\n• TP: ${tpPrice.toFixed(2)}\n• SL: ${slPrice.toFixed(2)}\n• Margin: 50 USDT`);
};

const closePosition = async (reason: string, currentPrice: number) => {
  const position = runtimeState.position;
  if (!position) return;

  const isLong = position.type === 'LONG';
  const pnl = isLong ? (currentPrice - position.entryPrice) * (position.size / position.entryPrice) : (position.entryPrice - currentPrice) * (position.size / position.entryPrice);
  const closeFee = position.size * CONFIG.FEE;
  const finalPnl = pnl - closeFee - position.openFee;

  runtimeState.balance += position.margin + (pnl - closeFee);
  runtimeState.pnlHistory += finalPnl;
  runtimeState.pnlToday += finalPnl;
  runtimeState.tradesToday += 1;
  runtimeState.position = null;
  persistRuntimeState();

  await syncPositionToFirebase(null);
  await syncToFirebase({ balance: runtimeState.balance, pnlHistory: runtimeState.pnlHistory });

  await syncHistoryToFirebase({
    id: `hist_${Date.now()}`,
    time: Date.now(),
    type: position.type,
    entry: position.entryPrice,
    exit: currentPrice,
    pnl: finalPnl,
    reason,
    margin: position.margin,
    leverage: CONFIG.LEVERAGE,
    signalDetail: position.signalDetail,
  });

  await sendTelegram(`${finalPnl >= 0 ? '✅' : '❌'} <b>BACKGROUND ĐÓNG LỆNH ${position.type}</b>\n• Lý do: ${reason}\n• PnL: ${finalPnl >= 0 ? '+' : ''}${finalPnl.toFixed(2)} USDT\n• Balance: ${runtimeState.balance.toFixed(2)} USDT`);
};

const processStrategyTick = async () => {
  if (!runtimeState.isRunning) return;
  if (!(await enforceRiskGuards())) return;

  try {
    let currentPrice = 0;

    // MTF Check for sentiment
    const intervals: (keyof MTFSentiment)[] = ['1m', '5m', '15m', '1h', '4h', '1d'];
    const sentiment: Partial<MTFSentiment> = {};
    let candles1m: Candle[] = [];

    for (const int of intervals) {
      const limit = int === '1m' ? CONFIG.LIMIT_CANDLES : CONFIG.EMA_PERIOD + 1;
      const c = await fetchCandles(int, limit);
      if (int === '1m') {
        candles1m = c;
        currentPrice = c[c.length - 1].close;
      }

      const closes = c.map(k => k.close);
      const ema = calculateZLEMA(closes, CONFIG.EMA_PERIOD);
      const currP = closes[closes.length - 1];
      const currE = ema[ema.length - 1];
      if (currP > currE) sentiment[int] = 'BULLISH';
      else if (currP < currE) sentiment[int] = 'BEARISH';
      else sentiment[int] = 'NEUTRAL';
    }

    if (candles1m.length < CONFIG.EMA_PERIOD) return;

    if (runtimeState.position) {
      const pos = runtimeState.position;
      const isL = pos.type === 'LONG';

      // Trailing SL / Breakeven Logic at 1.5R
      const riskDist = Math.abs(pos.entryPrice - pos.slPrice);
      const currDist = isL ? (currentPrice - pos.entryPrice) : (pos.entryPrice - currentPrice);

      if (riskDist > 0 && currDist >= riskDist * 1.5 && !pos.signalDetail?.isBreakeven) {
        const newSl = pos.entryPrice;
        if ((isL && newSl > pos.slPrice) || (!isL && newSl < pos.slPrice)) {
          pos.slPrice = newSl;
          pos.signalDetail.isBreakeven = true;
          await syncPositionToFirebase(pos);
          await sendTelegram(`🛡 <b>TRAILING SL KÍCH HOẠT</b>\n• Lệnh ${pos.type} đã lãi 1.5R.\n• Đã dời SL về điểm hòa vốn (${newSl.toFixed(2)}). Giao dịch Free Risk!`);
        }
      }

      const hitTp = isL ? currentPrice >= pos.tpPrice : currentPrice <= pos.tpPrice;
      const hitSl = isL ? currentPrice <= pos.slPrice : currentPrice >= pos.slPrice;
      if (hitTp) await closePosition('TAKE PROFIT', currentPrice);
      else if (hitSl) await closePosition('STOP LOSS', currentPrice);

      runtimeState.consecutiveErrors = 0;
      return;
    }

    if (Date.now() - runtimeState.lastSignalAt < 60_000) return;

    // Thực thi Thuật toán SMC 1m
    const closes = candles1m.map(c => c.close);
    const volumes = candles1m.map(c => c.volume);
    const last = candles1m[candles1m.length - 1];

    const rsi = calculateRSI(closes, CONFIG.RSI_PERIOD);
    const emaArr = calculateZLEMA(closes, CONFIG.EMA_PERIOD);
    const currentEma = emaArr[emaArr.length - 1];
    const macd = getMACD(closes);
    const { fvg, ob } = detectSMC(candles1m);
    const volSma = calculateSMA(volumes, CONFIG.VOL_SMA_PERIOD);

    const trend = last.close > currentEma ? 'UP' : 'DOWN';
    const score = calculateScores({ rsi, ema: currentEma, macd, fvg, ob, trend }, last, CONFIG);

    // Volume Filter
    const volumeOk = volSma > 0 ? last.volume >= volSma * CONFIG.VOL_MULTIPLIER : true;

    if (score >= CONFIG.CONFLUENCE_THRESHOLD && volumeOk) {
      if (trend === 'UP' && rsi < CONFIG.RSI_OVERBOUGHT) {
        if (sentiment['5m'] === 'BULLISH' && sentiment['15m'] === 'BULLISH' && sentiment['1h'] !== 'BEARISH') {
          await openPosition('LONG', last.close, last.time, score, `SMC Score ${score}/5 (MTF Bullish)`);
        }
      } else if (trend === 'DOWN' && rsi > CONFIG.RSI_OVERSOLD) {
        if (sentiment['5m'] === 'BEARISH' && sentiment['15m'] === 'BEARISH' && sentiment['1h'] !== 'BULLISH') {
          await openPosition('SHORT', last.close, last.time, score, `SMC Score ${score}/5 (MTF Bearish)`);
        }
      }
    }

    runtimeState.consecutiveErrors = 0;
  } catch (error: any) {
    runtimeState.consecutiveErrors += 1;
    persistRuntimeState();
    await sendTelegram(`⚠️ <b>BACKGROUND SMC ENGINE ERROR</b>\n• ${error?.message || 'Unknown error'}\n• Lỗi liên tiếp: ${runtimeState.consecutiveErrors}`);
    if (runtimeState.consecutiveErrors >= 5) {
      runtimeState.isRunning = false;
      runtimeState.startedAt = null;
      runtimeState.pausedReason = `Quá 5 lỗi liên tiếp (Network/API)`;
      stopEngine();
      stopHeartbeat();
      persistRuntimeState();
      await sendTelegram(`⛔ <b>BACKGROUND BOT STOP SAFETY</b>\n• ${runtimeState.pausedReason}`);
    }
  }
};

function stopEngine() {
  if (runtimeState.engineTimer) {
    clearInterval(runtimeState.engineTimer);
    runtimeState.engineTimer = null;
  }
}

const startEngine = () => {
  stopEngine();
  processStrategyTick();
  runtimeState.engineTimer = setInterval(processStrategyTick, 15_000);
};

const collectBody = (req: IncomingMessage): Promise<any> =>
  new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error('Payload too large'));
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });

const server = createServer(async (req, res) => {
  if (!req.url) return json(res, 400, { error: 'Invalid request' });
  if (req.method === 'OPTIONS') return json(res, 200, { ok: true });

  if (req.method === 'GET' && req.url === '/api/health') {
    return json(res, 200, { status: 'ok', service: 'btc-trading-bot-backend', timestamp: new Date().toISOString() });
  }

  if (req.method === 'GET' && req.url === '/api/config') {
    return json(res, 200, { symbol: runtimeState.symbol, mode: 'paper-trading-background', interval: CONFIG.INTERVAL });
  }

  if (req.method === 'GET' && req.url === '/api/runtime') {
    return json(res, 200, {
      isRunning: runtimeState.isRunning,
      startedAt: runtimeState.startedAt,
      symbol: runtimeState.symbol,
      heartbeatMs: runtimeState.heartbeatMs,
      background: true,
      balance: runtimeState.balance,
      pnlHistory: runtimeState.pnlHistory,
      pnlToday: runtimeState.pnlToday,
      tradesToday: runtimeState.tradesToday,
      pausedReason: runtimeState.pausedReason,
      position: runtimeState.position,
    });
  }

  if (req.method === 'POST' && req.url === '/api/runtime') {
    try {
      const payload = await collectBody(req);
      runtimeState.isRunning = Boolean(payload?.isRunning);
      runtimeState.startedAt = runtimeState.isRunning ? new Date().toISOString() : null;
      runtimeState.token = String(payload?.token || runtimeState.token || '');
      runtimeState.chatId = String(payload?.chatId || runtimeState.chatId || '');
      runtimeState.symbol = String(payload?.symbol || runtimeState.symbol || CONFIG.SYMBOL);
      runtimeState.heartbeatMs = Number(payload?.heartbeatMs || runtimeState.heartbeatMs || CONFIG.HEARTBEAT_MS);

      // Khóa quan trọng để kết nối với Firebase đúng User
      if (payload?.uid) runtimeState.uid = String(payload.uid);
      if (payload?.appId) runtimeState.appId = String(payload.appId);

      if (runtimeState.isRunning) runtimeState.pausedReason = '';

      persistRuntimeState();

      if (runtimeState.isRunning) {
        await sendTelegram(`🟢 <b>BACKGROUND BOT START</b>\n• Cặp: ${runtimeState.symbol}\n• Chế độ: Nhúng SMC Algorithm & Firebase Sync`);
        // Khởi động lại engine và reset bộ đếm lỗi
        runtimeState.consecutiveErrors = 0;
        startHeartbeat();
        startEngine();
      } else {
        stopHeartbeat();
        stopEngine();
        await sendTelegram('🔴 <b>BACKGROUND BOT STOP</b>\n• Bot ngầm đã dừng theo trạng thái nút KHỞI ĐỘNG trên Web.');
      }

      return json(res, 200, { ok: true, isRunning: runtimeState.isRunning, startedAt: runtimeState.startedAt });
    } catch (error: any) {
      return json(res, 400, { ok: false, error: error?.message || 'Bad request' });
    }
  }

  return json(res, 404, { error: 'Not found' });
});

restoreRuntimeState();
if (runtimeState.isRunning) {
  startHeartbeat();
  startEngine();
}

server.listen(port, () => {
  console.log(`Backend SMC Engine running at http://localhost:${port}`);
  console.log(`Firebase Interop: ${db ? 'ACTIVE' : 'INACTIVE'}`);
});
