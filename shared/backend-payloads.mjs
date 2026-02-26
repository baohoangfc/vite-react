export const buildHealthPayload = (environment) => ({
  status: 'ok',
  service: 'btc-trading-bot-backend',
  timestamp: new Date().toISOString(),
  environment,
})

export const buildConfigPayload = (environment) => ({
  symbol: 'BTCUSDT',
  mode: 'paper-trading',
  environment,
})
