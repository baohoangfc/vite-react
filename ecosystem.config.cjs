module.exports = {
  apps: [
    {
      name: 'xau-bot',
      script: 'npm',
      args: 'run start:backend',
      env: {
        NODE_ENV: 'production',
        BOT_AUTO_START: 'true',
        BOT_SYMBOL: 'XAUUSD',
        BOT_TELEGRAM_TOKEN: '',
        BOT_TELEGRAM_CHAT_ID: '',
      },
    },
  ],
};
