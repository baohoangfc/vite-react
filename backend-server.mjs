import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const port = Number(process.env.PORT || 3001);
const BINANCE_KLINES = 'https://api.binance.com/api/v3/klines';
const RUNTIME_STORE_PATH = resolve(process.cwd(), '.runtime-state.json');

const STRATEGY = {
  interval: '1m',
  limitCandles: 120,
  emaPeriod: 50,
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
  tpPercent: 0.008,
  slPercent: 0.004,
  leverage: 50,
  margin: 50,
  fee: 0.0004,
  maxDailyLoss: 100,
  maxTradesPerDay: 25,
  maxConsecutiveErrors: 5,
};

const getDayKey = () => new Date().toISOString().slice(0, 10);

const runtimeState = {
  isRunning: false,
  startedAt: null,
  token: '',
  chatId: '',
  symbol: 'BTCUSDT',
  heartbeatMs: 10 * 60 * 1000,
  heartbeatTimer: null,
  engineTimer: null,
  position: null,
  balance: 1000,
  pnlHistory: 0,
  lastSignalAt: 0,
  dayKey: getDayKey(),
  pnlToday: 0,
  tradesToday: 0,
  consecutiveErrors: 0,
  pausedReason: '',
};

const persistRuntimeState = () => {
  const payload = {
    isRunning: runtimeState.isRunning,
    startedAt: runtimeState.startedAt,
    token: runtimeState.token,
    chatId: runtimeState.chatId,
    symbol: runtimeState.symbol,
    heartbeatMs: runtimeState.heartbeatMs,
    position: runtimeState.position,
    balance: runtimeState.balance,
    pnlHistory: runtimeState.pnlHistory,
    lastSignalAt: runtimeState.lastSignalAt,
    dayKey: runtimeState.dayKey,
    pnlToday: runtimeState.pnlToday,
    tradesToday: runtimeState.tradesToday,
    pausedReason: runtimeState.pausedReason,
  };
  writeFileSync(RUNTIME_STORE_PATH, JSON.stringify(payload, null, 2));
};

const restoreRuntimeState = () => {
  if (!existsSync(RUNTIME_STORE_PATH)) return;
  try {
    const data = JSON.parse(readFileSync(RUNTIME_STORE_PATH, 'utf-8'));
    runtimeState.isRunning = Boolean(data.isRunning);
    runtimeState.startedAt = data.startedAt || null;
    runtimeState.token = String(data.token || '');
    runtimeState.chatId = String(data.chatId || '');
    runtimeState.symbol = String(data.symbol || 'BTCUSDT');
    runtimeState.heartbeatMs = Number(data.heartbeatMs || runtimeState.heartbeatMs);
    runtimeState.position = data.position || null;
    runtimeState.balance = Number(data.balance || runtimeState.balance);
    runtimeState.pnlHistory = Number(data.pnlHistory || runtimeState.pnlHistory);
    runtimeState.lastSignalAt = Number(data.lastSignalAt || 0);
    runtimeState.dayKey = String(data.dayKey || getDayKey());
    runtimeState.pnlToday = Number(data.pnlToday || 0);
    runtimeState.tradesToday = Number(data.tradesToday || 0);
    runtimeState.pausedReason = String(data.pausedReason || '');
  } catch (_error) {
    // ignore broken state file and continue with defaults
  }
};

const json = (res, statusCode, payload) => {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(payload));
};

const calculateSMA = (values, period) => {
  if (values.length < period) return 0;
  const recent = values.slice(-period);
  return recent.reduce((sum, value) => sum + value, 0) / period;
};

const calculateEMA = (values, period) => {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = values[0];
  for (let i = 1; i < values.length; i += 1) ema = values[i] * k + ema * (1 - k);
  return ema;
};

const calculateRSI = (values, period) => {
  if (values.length <= period) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
};

const sendTelegram = async (text) => {
  if (!runtimeState.token || !runtimeState.chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${runtimeState.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: runtimeState.chatId, text, parse_mode: 'HTML' }),
    });
  } catch (_error) {}
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
  if (runtimeState.pnlToday <= -Math.abs(STRATEGY.maxDailyLoss)) {
    runtimeState.pausedReason = `Đạt ngưỡng lỗ ngày ${STRATEGY.maxDailyLoss} USDT`;
  } else if (runtimeState.tradesToday >= STRATEGY.maxTradesPerDay) {
    runtimeState.pausedReason = `Đạt giới hạn ${STRATEGY.maxTradesPerDay} lệnh/ngày`;
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

const fetchCandles = async () => {
  const query = new URLSearchParams({ symbol: runtimeState.symbol, interval: STRATEGY.interval, limit: String(STRATEGY.limitCandles) });
  const response = await fetch(`${BINANCE_KLINES}?${query.toString()}`);
  if (!response.ok) throw new Error(`Failed to fetch candles (${response.status})`);
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length < STRATEGY.emaPeriod + 2) throw new Error('Not enough candle data');
  return rows.map((k) => ({ time: Number(k[0]), open: Number(k[1]), high: Number(k[2]), low: Number(k[3]), close: Number(k[4]), volume: Number(k[5]) }));
};

const shouldOpenSignal = ({ close, ema, rsi, vol, volSma }) => {
  const volumeOk = volSma > 0 ? vol >= volSma * 1.2 : true;
  if (!volumeOk) return null;
  if (close > ema && rsi < STRATEGY.rsiOversold) return 'LONG';
  if (close < ema && rsi > STRATEGY.rsiOverbought) return 'SHORT';
  return null;
};

const openPosition = async (type, price, signalTime) => {
  const size = STRATEGY.margin * STRATEGY.leverage;
  const fee = size * STRATEGY.fee;
  const realMargin = STRATEGY.margin - fee;

  const tpPrice = type === 'LONG' ? price * (1 + STRATEGY.tpPercent) : price * (1 - STRATEGY.tpPercent);
  const slPrice = type === 'LONG' ? price * (1 - STRATEGY.slPercent) : price * (1 + STRATEGY.slPercent);
  const liquidationPrice = type === 'LONG' ? price * (1 - 1 / STRATEGY.leverage) : price * (1 + 1 / STRATEGY.leverage);

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
    signalDetail: { setup: 'Backend EMA/RSI + Volume', score: 0 },
  };
  runtimeState.balance -= STRATEGY.margin;
  runtimeState.lastSignalAt = signalTime;
  persistRuntimeState();

  await sendTelegram(`🚀 <b>BACKGROUND MỞ ${type}</b>\n• Giá: ${price.toFixed(2)}\n• TP: ${tpPrice.toFixed(2)}\n• SL: ${slPrice.toFixed(2)}\n• Margin: ${STRATEGY.margin} USDT`);
};

const closePosition = async (reason, currentPrice) => {
  const position = runtimeState.position;
  if (!position) return;

  const isLong = position.type === 'LONG';
  const pnl = isLong ? (currentPrice - position.entryPrice) * (position.size / position.entryPrice) : (position.entryPrice - currentPrice) * (position.size / position.entryPrice);
  const closeFee = position.size * STRATEGY.fee;
  const finalPnl = pnl - closeFee - position.openFee;

  runtimeState.balance += position.margin + (pnl - closeFee);
  runtimeState.pnlHistory += finalPnl;
  runtimeState.pnlToday += finalPnl;
  runtimeState.tradesToday += 1;
  runtimeState.position = null;
  persistRuntimeState();

  await sendTelegram(`${finalPnl >= 0 ? '✅' : '❌'} <b>BACKGROUND ĐÓNG LỆNH ${position.type}</b>\n• Giá đóng: ${currentPrice.toFixed(2)}\n• Lý do: ${reason}\n• PnL: ${finalPnl >= 0 ? '+' : ''}${finalPnl.toFixed(2)} USDT\n• Balance: ${runtimeState.balance.toFixed(2)} USDT`);
};

const processStrategyTick = async () => {
  if (!runtimeState.isRunning) return;
  if (!(await enforceRiskGuards())) return;

  try {
    const candles = await fetchCandles();
    const closes = candles.map((c) => c.close);
    const volumes = candles.map((c) => c.volume);
    const last = candles[candles.length - 1];

    if (runtimeState.position) {
      const pos = runtimeState.position;
      const hitTp = pos.type === 'LONG' ? last.close >= pos.tpPrice : last.close <= pos.tpPrice;
      const hitSl = pos.type === 'LONG' ? last.close <= pos.slPrice : last.close >= pos.slPrice;
      if (hitTp) await closePosition('TAKE PROFIT', last.close);
      else if (hitSl) await closePosition('STOP LOSS', last.close);
      runtimeState.consecutiveErrors = 0;
      return;
    }

    if (Date.now() - runtimeState.lastSignalAt < 60_000) return;

    const ema = calculateEMA(closes, STRATEGY.emaPeriod);
    const rsi = calculateRSI(closes, STRATEGY.rsiPeriod);
    const volSma = calculateSMA(volumes, 20);

    const signal = shouldOpenSignal({ close: last.close, ema, rsi, vol: last.volume, volSma });
    if (signal) await openPosition(signal, last.close, last.time);
    runtimeState.consecutiveErrors = 0;
  } catch (error) {
    runtimeState.consecutiveErrors += 1;
    persistRuntimeState();
    await sendTelegram(`⚠️ <b>BACKGROUND ENGINE ERROR</b>\n• ${(error && error.message) || 'Unknown error'}\n• Lỗi liên tiếp: ${runtimeState.consecutiveErrors}`);
    if (runtimeState.consecutiveErrors >= STRATEGY.maxConsecutiveErrors) {
      runtimeState.isRunning = false;
      runtimeState.startedAt = null;
      runtimeState.pausedReason = `Quá ${STRATEGY.maxConsecutiveErrors} lỗi liên tiếp`;
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

const collectBody = (req) =>
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
    return json(res, 200, { symbol: runtimeState.symbol, mode: 'paper-trading-background', interval: STRATEGY.interval });
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
      runtimeState.symbol = String(payload?.symbol || runtimeState.symbol || 'BTCUSDT');
      runtimeState.heartbeatMs = Number(payload?.heartbeatMs || runtimeState.heartbeatMs || 600000);
      if (runtimeState.isRunning) runtimeState.pausedReason = '';

      persistRuntimeState();

      if (runtimeState.isRunning) {
        await sendTelegram(`🟢 <b>BACKGROUND BOT START</b>\n• Cặp: ${runtimeState.symbol}\n• Chế độ: backend worker`);
        startHeartbeat();
        startEngine();
      } else {
        stopHeartbeat();
        stopEngine();
        await sendTelegram('🔴 <b>BACKGROUND BOT STOP</b>\n• Bot ngầm đã dừng theo trạng thái nút KHỞI ĐỘNG.');
      }

      return json(res, 200, { ok: true, isRunning: runtimeState.isRunning, startedAt: runtimeState.startedAt });
    } catch (error) {
      return json(res, 400, { ok: false, error: error instanceof Error ? error.message : 'Bad request' });
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
  console.log(`Backend running at http://localhost:${port}`);
});
