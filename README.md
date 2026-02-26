# BTC Trading Bot - Fullstack (Frontend + Backend)

Dự án đã được cấu hình theo hướng **fullstack** và an toàn để deploy production trên **Vercel**:
- **Frontend**: React + Vite.
- **Backend local (dev)**: Node HTTP server tại `backend-server.mjs`.
- **Backend production (Vercel)**: Serverless Functions tại thư mục `api/` (dùng auto-detect mặc định của Vercel, không ép runtime qua `vercel.json`).

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

Payload API local và production dùng chung từ `shared/backend-payloads.mjs` để tránh lệch dữ liệu giữa 2 môi trường.

Nếu gặp conflict khi merge, ưu tiên giữ các file API/backend đồng bộ với `shared/backend-payloads.mjs`.
