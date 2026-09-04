# Single-Agent Facebook Messenger AI Customer Service Representative

Hệ thống AI CSKH tự động cho Facebook Messenger cá nhân, vận hành theo mô hình **Single-Agent** (đơn luồng, tuần tự, đảm bảo không trùng lặp và không xung đột phiên), tích hợp Dashboard quản trị PWA, bộ điều phối hàng đợi FIFO có ưu tiên (fairness & stickiness), bảo vệ phiên qua Cloudflare Access và noVNC.

---

## 1. Cấu trúc Monorepo

```
├── apps/
│   ├── control-plane/       # Fastify REST API, SSE streaming, Auth & Cloudflare JWT verification
│   ├── dashboard/           # React 18 + Vite responsive PWA dashboard (Overview, Inbox, Queue, Settings, Audit)
│   ├── scheduler/           # Bộ điều phối hàng đợi FIFO, stickiness turns, lease lock & stale claim reconciliation
│   ├── ai-worker/           # Xử lý job AI (OmniRoute client, structured output & hallucination/leak guards)
│   └── browser-agent/       # Playwright Chromium điều khiển Messenger Web, Xvfb + noVNC port 6080
├── packages/
│   ├── contracts/           # Zod schemas & TypeScript types dùng chung
│   ├── config/              # Quản lý & validate biến môi trường fail-fast
│   ├── db/                  # Drizzle ORM schema (PostgreSQL), repositories & migrations
│   ├── queue/               # BullMQ queues, Redis lease manager & debounce coordinator
│   ├── channel/             # ChannelAdapter interface, TypingEngine (WPM pacing) & Mock adapter
│   └── ai/                  # OpenAI-compatible OmniRoute client, Persona & Output guards
├── docker/                  # Multi-stage Dockerfiles cho từng service
├── scripts/                 # backup.sh & restore.sh cho PostgreSQL
├── tests/                   # Vitest unit, invariant & E2E simulation tests
├── compose.prod.yml         # Docker Compose production stack
├── compose.dev.yml          # Docker Compose dev environment (Postgres & Redis)
└── .env.example             # Mẫu biến môi trường
```

---

## 2. Triển khai tự động lên VPS

Mỗi commit được push lên nhánh `main` (hoặc chạy qua `workflow_dispatch`) sẽ kích hoạt `.github/workflows/deploy.yml` theo mô hình chuẩn từ các repository khác (`tuan-portfolio`, `OmniRoute`):

1. **Verify**: Cài dependencies, typecheck, build toàn bộ monorepo, chạy unit & invariant tests và kiểm tra tính đúng đắn của script deploy + image retention.
2. **Build & Publish images**: Build 4 container images riêng biệt cho các microservices (`control-plane`, `scheduler`, `ai-worker`, `browser-agent`), gắn tag commit và đẩy lên GitHub Container Registry (`ghcr.io`) dưới dạng digest bất biến (`@sha256:...`).
3. **Deploy VPS**: Kết nối SSH vào VPS qua `secrets.VPS_SSH_KEY`, đồng bộ `compose.prod.yml`, `scripts/deploy.sh`, `scripts/image-retention.sh` vào `/opt/facebook-messenger-ai-rep/`, đăng nhập GHCR tạm thời và chạy `deploy.sh`.
4. **Safety & Rollback**: Tự động dump backup cơ sở dữ liệu PostgreSQL trước khi chạy migration (`drizzle-orm`), khởi động container và kiểm tra health check `/health`. Nếu có lỗi xảy ra, hệ thống tự động rollback về bộ image trước đó.
5. **Dọn dẹp VPS an toàn**: Tự động dọn dẹp các image digest cũ không còn dùng (chỉ giữ lại image đang chạy và image của phiên trước để rollback), xóa dangling images và các bản backup cũ quá 14 ngày. Toàn bộ volumes dữ liệu (`messenger_postgres_data`, `messenger_redis_data`, `messenger_browser_profile`) và cấu hình `.env` được bảo toàn tuyệt đối.

### Khởi tạo VPS một lần

1. Cài đặt Docker Engine và Docker Compose v2 trên VPS.
2. Tạo thư mục ứng dụng và file cấu hình:
   ```bash
   sudo mkdir -p /opt/facebook-messenger-ai-rep/backups
   sudo chown -R $USER:$USER /opt/facebook-messenger-ai-rep
   ```
3. Tạo file `/opt/facebook-messenger-ai-rep/.env` dựa trên `.env.example` và điền đầy đủ các giá trị production:
   ```bash
   chmod 600 /opt/facebook-messenger-ai-rep/.env
   ```

### Cấu hình GitHub Environment `production`

Pipeline sử dụng environment `production` với các secrets và variables tương tự các repo hiện có của bạn:

| Tên | Loại | Mô tả |
|---|---|---|
| `VPS_HOST` | Secret | IP hoặc hostname của VPS |
| `VPS_PORT` | Secret | Cổng SSH (mặc định `22`) |
| `VPS_USER` | Secret | Tài khoản người dùng SSH (ví dụ: `opc` hoặc `root`) |
| `VPS_SSH_KEY` | Secret | Khóa SSH Private Key tương ứng |
| `VPS_KNOWN_HOSTS` | Secret | Dòng host key từ `ssh-keyscan -p <port> <host>` |
| `BUILD_RUNNER` | Variable | Runner build image (mặc định `ubuntu-24.04-arm`) |
| `DEPLOY_PLATFORM` | Variable | Kiến trúc container (mặc định `linux/arm64`) |

---

## 3. Phát triển cục bộ (Local Development)

### Yêu cầu:
- Node.js >= 22
- pnpm >= 10 (`corepack enable && corepack prepare pnpm@latest --activate`)
- Docker & Docker Compose (cho PostgreSQL và Redis dev)

### Cài đặt:
```bash
# 1. Cài đặt dependencies
pnpm install

# 2. Khởi chạy Postgres & Redis cục bộ
docker compose -f compose.dev.yml up -d

# 3. Tạo file cấu hình môi trường
cp .env.example .env

# 4. Chạy migration và seed database
pnpm db:migrate
pnpm db:seed

# 5. Build toàn bộ packages & apps
pnpm build

# 6. Chạy bộ kiểm thử (Vitest)
pnpm test
```

### Chạy các services ở chế độ Dev:
```bash
# Terminal 1: Control Plane API
pnpm dev:control-plane

# Terminal 2: Dashboard Web
pnpm dev:dashboard

# Terminal 3: Scheduler
pnpm dev:scheduler

# Terminal 4: AI Worker
pnpm dev:ai-worker

# Terminal 5: Browser Agent
pnpm dev:browser-agent
```

---

## 4. Triển khai Production (Docker Compose)

```bash
# 1. Chuẩn bị file .env
cp .env.example .env
# Chỉnh sửa mật khẩu DB, Redis, OmniRoute API key, Cloudflare Tunnel token

# 2. Khởi chạy toàn bộ stack
docker compose -f compose.prod.yml up -d

# 3. Tạo tài khoản quản trị đầu tiên
docker compose -f compose.prod.yml exec control-plane node apps/control-plane/dist/cli/bootstrap.js admin@yourdomain.com YourPassword123!

# 4. Đăng nhập Facebook lần đầu qua noVNC
# Truy cập: https://<domain-session>/vnc.html hoặc http://localhost:6081/vnc.html
```

---

## 5. Kiểm thử tự động (Unit & Invariant Tests)

Hệ thống đi kèm bộ test toàn diện bảo vệ các nguyên lý vận hành:
```bash
pnpm test
```
- `tests/ai-guards.test.ts`: Kiểm tra chống bịa đặt, rò rỉ prompt và giới hạn ký tự.
- `tests/typing-engine.test.ts`: Kiểm tra tốc độ gõ phím WPM tự nhiên và hủy gõ phím khi có tin mới.
- `tests/dedupe-debounce.test.ts`: Kiểm tra gộp tin nhắn dồn dập và chống lặp tin.
- `tests/scheduler-single-agent.test.ts`: Kiểm tra khóa lease fencing token đơn luồng.
- `tests/stale-version-cancellation.test.ts`: Kiểm tra race condition hủy bỏ draft cũ khi có tin mới.
- `tests/full-e2e-simulation.test.ts`: Mô phỏng đầy đủ luồng tiếp nhận nhiều khách và nhường lượt công bằng.
