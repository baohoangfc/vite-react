import { createServer } from 'node:http';

const port = Number(process.env.PORT || 3001);

const json = (res, statusCode, payload) => {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(payload));
};

const server = createServer((req, res) => {
  if (!req.url) {
    json(res, 400, { error: 'Invalid request' });
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

  json(res, 404, { error: 'Not found' });
});

server.listen(port, () => {
  console.log(`Backend running at http://localhost:${port}`);
});
