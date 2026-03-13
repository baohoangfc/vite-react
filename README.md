# Gold (XAU) Trading Bot - Fullstack (Frontend + Backend)

Dự án đã được cấu hình theo hướng **fullstack** và an toàn để deploy production trên **Vercel**:
- **Frontend**: React + Vite.
- **Backend local (dev)**: Node HTTP server tại `backend-server.ts`.
- **Backend production (Vercel)**: Serverless Functions tại thư mục `api/`.

## Cài đặt

```bash
npm install
```

## Chạy local (frontend + backend)

```bash
npm run dev
```

## Scripts

- `npm run dev`: chạy đồng thời frontend + backend local.
- `npm run dev:frontend`: chạy Vite frontend.
- `npm run dev:backend`: chạy backend local ở `http://localhost:3001`.
- `npm run build`: build frontend production.
- `npm run lint`: chạy TypeScript type-check (`tsc --noEmit`).
- `npm run preview`: preview frontend build.

## API

### Local development
- `GET http://localhost:3001/api/health`
- `GET http://localhost:3001/api/config`

Frontend gọi `/api/*` và được Vite proxy sang backend local khi chạy dev.

### Production trên Vercel
- `GET /api/health`
- `GET /api/config`

Các endpoint production được phục vụ bởi Vercel Functions trong thư mục `api/`.


## Vận hành 24/7 (backend-first)

Backend đã được chuyển sang chế độ **daemon**: khi server backend khởi động thì bot sẽ tự chạy nền, không phụ thuộc việc mở frontend.

> Lưu ý: Vercel Serverless Functions (`/api/*`) **không phù hợp** để chạy bot nền 24/7 liên tục.
> Để bot chạy xuyên suốt, hãy deploy tiến trình `backend-server.ts` trên môi trường có process lâu dài (Render/VM/PM2).


- Mặc định: tự bật bot (`BOT_AUTO_START=true`).
- Muốn tắt tự bật khi boot: chạy backend với `BOT_AUTO_START=false`.
- Có thể cấu hình bot chạy độc lập không cần FE bằng biến môi trường:
  - `BOT_SYMBOL` (mặc định theo `CONFIG.SYMBOL`, ví dụ `XAUUSD`)
  - `BOT_TELEGRAM_TOKEN`
  - `BOT_TELEGRAM_CHAT_ID`
- Frontend chỉ đóng vai trò theo dõi/hiển thị trạng thái và dữ liệu.

Ví dụ chạy backend 24/7 (PM2):

```bash
pm2 start "npm run start:backend" --name xau-bot
pm2 save
```

Hoặc dùng file mẫu `ecosystem.config.cjs` (khuyến nghị cho 24/7):

```bash
pm2 start ecosystem.config.cjs
pm2 save
```


Ví dụ chạy trực tiếp:

```bash
BOT_AUTO_START=true BOT_SYMBOL=XAUUSD BOT_TELEGRAM_TOKEN=xxx BOT_TELEGRAM_CHAT_ID=yyy npm run start:backend
```
