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

## 2. Phát triển cục bộ (Local Development)

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

## 3. Triển khai Production (Docker Compose)

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

## 4. Kiểm thử tự động (Unit & Invariant Tests)

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
