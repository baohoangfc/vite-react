import { createServer } from 'node:http';

const port = Number(process.env.PORT || 3001);

const runtimeState = {
  isRunning: false,
  startedAt: null,
  token: '',
  chatId: '',
  symbol: 'BTCUSDT',
  heartbeatMs: 10 * 60 * 1000,
  heartbeatTimer: null,
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

const sendTelegram = async (text) => {
  if (!runtimeState.token || !runtimeState.chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${runtimeState.token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: runtimeState.chatId,
        text,
        parse_mode: 'HTML',
      }),
    });
  } catch (_error) {
    // ignore telegram errors to keep runtime loop alive
  }
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
    sendTelegram(
      `💓 <b>BOT BACKGROUND ĐANG CHẠY</b>\n• Cặp: ${runtimeState.symbol}\n• Uptime: ${Math.floor((Date.now() - Number(runtimeState.startedAt || Date.now())) / 60000)} phút\n• Trạng thái: 🟢 Online`,
    );
  }, runtimeState.heartbeatMs);
};

const collectBody = (req) =>
  new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });

const server = createServer(async (req, res) => {
  if (!req.url) {
    json(res, 400, { error: 'Invalid request' });
    return;
  }

  if (req.method === 'OPTIONS') {
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/health') {
    json(res, 200, {
      status: 'ok',
      service: 'btc-trading-bot-backend',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/config') {
    json(res, 200, {
      symbol: 'BTCUSDT',
      mode: 'paper-trading',
    });
    return;
  }

  if (req.method === 'GET' && req.url === '/api/runtime') {
    json(res, 200, {
      isRunning: runtimeState.isRunning,
      startedAt: runtimeState.startedAt,
      symbol: runtimeState.symbol,
      heartbeatMs: runtimeState.heartbeatMs,
      background: true,
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/api/runtime') {
    try {
      const payload = await collectBody(req);
      runtimeState.isRunning = Boolean(payload?.isRunning);
      runtimeState.startedAt = runtimeState.isRunning ? new Date().toISOString() : null;
      runtimeState.token = String(payload?.token || runtimeState.token || '');
      runtimeState.chatId = String(payload?.chatId || runtimeState.chatId || '');
      runtimeState.symbol = String(payload?.symbol || runtimeState.symbol || 'BTCUSDT');

      if (runtimeState.isRunning) {
        sendTelegram(`🟢 <b>BACKGROUND BOT START</b>\n• Cặp: ${runtimeState.symbol}\n• Chế độ: chạy ngầm`);
        startHeartbeat();
      } else {
        stopHeartbeat();
        sendTelegram('🔴 <b>BACKGROUND BOT STOP</b>\n• Bot ngầm đã dừng theo trạng thái nút KHỞI ĐỘNG.');
      }

      json(res, 200, {
        ok: true,
        isRunning: runtimeState.isRunning,
        startedAt: runtimeState.startedAt,
      });
    } catch (error) {
      json(res, 400, {
        ok: false,
        error: error instanceof Error ? error.message : 'Bad request',
      });
    }
    return;
  }

  json(res, 404, { error: 'Not found' });
});

server.listen(port, () => {
  console.log(`Backend running at http://localhost:${port}`);
});
