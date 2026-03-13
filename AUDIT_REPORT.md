# Báo cáo kiểm tra hệ thống

## Phạm vi kiểm tra
- TypeScript type-check frontend/backend.
- Build production frontend (Vite).
- Smoke test backend local endpoint health.
- Rà soát cấu hình/scripts để tìm thiếu sót tính năng và rủi ro vận hành.

## Kết quả chạy kiểm tra
1. `npm run lint` ✅ (đang chạy `tsc --noEmit`).
2. `npm run build` ✅ (build thành công).
3. `npx tsx backend-server.ts` + `curl http://127.0.0.1:3001/api/health` ✅ (health endpoint trả về status `ok`).

## Thiếu sót & điểm cần cải thiện

### 1) Chưa có test tự động
- Hiện tại chưa có script `test` trong `package.json`, nên chưa có regression test tự động cho logic bot/chỉ báo/API.
- Tác động: khó phát hiện lỗi hồi quy sau mỗi lần chỉnh sửa.
- Đề xuất:
  - Bổ sung unit tests cho `src/utils/indicators.ts` và `src/utils/backtest.ts`.
  - Bổ sung smoke/integration test cho endpoint `api/health`, `api/config`, `api/xau/candles`.

### 2) Tên script `lint` chưa đúng bản chất
- `lint` hiện đang map sang `tsc --noEmit` (type-check), chưa chạy ESLint rule-level.
- Tác động: có thể lọt lỗi style/anti-pattern mà type-check không bắt được.
- Đề xuất:
  - Đổi `lint` sang `eslint .`.
  - Tạo thêm script `typecheck` riêng cho `tsc --noEmit`.

### 3) Dữ liệu runtime nhạy cảm được ghi thẳng ra file local
- `runtimeState` chứa `token`/`chatId`, và toàn bộ state được `persistRuntimeState()` ghi vào `.runtime-state.json`.
- Tác động: rò rỉ thông tin nhạy cảm nếu file bị lộ hoặc commit nhầm.
- Đề xuất:
  - Không persist `token`/`chatId` xuống file.
  - Ưu tiên lấy các secret từ environment variables/secret manager.

### 4) Chưa thấy lớp auth/authorization rõ ràng cho backend local
- Backend local cung cấp các route API công khai theo server HTTP tùy biến, nhưng chưa thấy cơ chế xác thực request ở mức khung tổng thể.
- Tác động: dễ bị gọi trái phép trong môi trường mở.
- Đề xuất:
  - Yêu cầu API key/JWT cho endpoint thao tác trạng thái bot.
  - Bật CORS có kiểm soát thay vì wildcard khi deploy công khai.

## Mức độ ổn định hiện tại
- Ở mức **ổn định kỹ thuật cơ bản** (build + health OK).
- Chưa đạt mức “production-hardened” do thiếu test tự động và các lớp bảo mật/vận hành nêu trên.
