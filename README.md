# Single-Agent Facebook Messenger AI Customer Service Representative

Hệ thống AI CSKH tự động cho Facebook Messenger cá nhân, vận hành theo mô hình **Single-Agent** (đơn luồng, tuần tự, loại trừ tuyệt đối race conditions và phân mảnh phiên), phục vụ qua giao diện quản trị PWA Dashboard, điều phối hàng đợi trên nền **PostgreSQL 17** (hoàn toàn không dùng Redis/BullMQ), bảo mật và định tuyến qua Cloudflare Tunnel + Cloudflare Access.

---

> ### ⚠️ CẢNH BÁO QUAN TRỌNG VỀ TỰ ĐỘNG HÓA TÀI KHOẢN FACEBOOK CÁ NHÂN (DISCLAIMER)
>
> 1. **Điều khoản dịch vụ của Meta (Terms of Service)**:
>    - Việc sử dụng công cụ tự động hóa, trình duyệt điều khiển (browser automation / Playwright / Puppeteer) trên tài khoản Facebook Messenger cá nhân có thể vi phạm Điều khoản Dịch vụ và Tiêu chuẩn Cộng đồng của Meta.
>    - Meta áp dụng các cơ chế phát hiện tự động hóa (behavioral fingerprinting, TLS fingerprinting, bot detection, rate limits, CAPTCHA, checkpointing).
> 2. **Rủi ro tài khoản**:
>    - Tài khoản sử dụng có thể bị **buộc đăng xuất (session invalidation)**, **yêu cầu xác minh danh tính (checkpoint/2FA challenge)**, **khóa tính năng nhắn tin tạm thời (messaging block)**, hoặc **vô hiệu hóa vĩnh viễn (permanent ban)**.
> 3. **Bản chất Best-Effort**:
>    - Dự án này được thiết kế và cung cấp dưới hình thức **thử nghiệm kỹ thuật (best-effort / experimental)**. Không có bất kỳ cam kết hay bảo đảm nào về tính sẵn sàng liên tục 100%, khả năng miễn nhiễm checkpoint hoặc chống khóa tài khoản từ Meta.
> 4. **Biện pháp giảm thiểu rủi ro đã tích hợp trong kiến trúc**:
>    - **Single-Agent Serialization**: Xử lý tin nhắn tuần tự, tránh gửi tin đồng thời hoặc tạo tải bất thường.
>    - **Human Pacing & Typing Engine**: Mô phỏng tốc độ gõ phím của con người (WPM động, delay ngẫu nhiên, hiển thị trạng thái "đang gõ...").
>    - **Debounce & Aggregation**: Gộp tin nhắn dồn dập từ khách hàng để tránh phản hồi ngắt quãng, spam.
>    - **Persistent Browser Profile**: Lưu trữ phiên đăng nhập (`messenger_browser_profile`) bền vững, không xóa profile khi reset ứng dụng.
>    - **Khuyến nghị vận hành**: Luôn sử dụng tài khoản phụ/chuyên dụng cho CSKH, không dùng tài khoản cá nhân chính chủ quan trọng; theo dõi thường xuyên và có nhân viên hỗ trợ khi xảy ra checkpoint.

---

## 1. Cấu trúc Monorepo

```
├── apps/
│   ├── core/                # Fastify 5 server: REST API, SSE streaming, Cloudflare JWT auth,
│   │                        # PostgreSQL transactional job scheduler & handlers (debounce, ai, outbox, reconcile)
│   ├── dashboard/           # React 18 + Vite responsive PWA dashboard (Overview, Inbox, Queue, Settings, Audit)
│   └── browser-agent/       # Playwright Chromium điều khiển Messenger Web, Xvfb + noVNC (port 6080)
├── packages/
│   ├── contracts/           # Zod schemas & TypeScript types dùng chung
│   ├── config/              # Quản lý & validate biến môi trường fail-fast
│   ├── db/                  # Drizzle ORM schema (PostgreSQL 17), repositories & migrations
│   ├── channel/             # ChannelAdapter interface, TypingEngine (WPM pacing) & Mock adapter
│   └── ai/                  # OpenAI/xAI-compatible client, Persona & Output guards
├── docker/
│   ├── Dockerfile.core          # Multi-stage build cho Core + Dashboard static assets
│   ├── Dockerfile.browser-agent # Multi-stage build Playwright + Bun (non-root pwuser, no SYS_ADMIN)
│   └── entrypoint-browser.sh    # Virtual display Xvfb, optional noVNC runner
├── scripts/
│   ├── deploy.sh            # Điều phối deploy zero-downtime, selective restart, backup & rollback
│   ├── backup.sh            # Sao lưu PostgreSQL (pg_dump + gzip)
│   ├── restore.sh           # Khôi phục cơ sở dữ liệu an toàn
│   ├── bootstrap-vps.sh     # Cài đặt Docker, cấu hình VPS ban đầu
│   └── image-retention.sh   # Dọn dẹp images cũ, bảo vệ current + previous release
├── tests/                   # Vitest unit & invariant tests, Bash ops tests
├── compose.prod.yml         # Production multi-tier hardened Compose stack
├── compose.debug.yml        # Localhost debug override (SSH tunnel port forwarding)
├── compose.dev.yml          # Local development stack (PostgreSQL 17)
└── .env.example             # Mẫu biến môi trường production
```

---

## 2. Kiến trúc Hạ tầng & Bảo mật (Infrastructure & Security)

### Kiến trúc Core + PostgreSQL (Không Redis / Không BullMQ)
- **Hàng đợi giao dịch PostgreSQL 17**: Sử dụng cơ chế hàng đợi transactional trong PostgreSQL (`SELECT ... FOR UPDATE SKIP LOCKED`), monotonic `fencing_epoch` tokens, lease timeouts và advisory locks.
- **Microservices tối giản**: Toàn bộ logic API, Dashboard static files, Background Job Scheduler và AI Worker được hợp nhất trong `apps/core`, giao tiếp với `apps/browser-agent` qua mạng nội bộ cô lập.

### Cô lập Mạng (Network Segmentation)
Hệ thống sử dụng 3 Docker networks riêng biệt:
1. `data` (`internal: true`): Chỉ chứa `postgres`, `migrate`, `core`, và `browser-agent`. Hoàn toàn không có đường ra internet trực tiếp từ mạng này.
2. `app` (`internal: true`): Giao tiếp API và Sender Worker nội bộ giữa `core` và `browser-agent`.
3. `edge`: Kết nối giữa `core` và `cloudflared` (Cloudflare Tunnel). Chỉ có `cloudflared` mở kết nối ra ngoài tới Cloudflare Edge; không mở bất kỳ public port nào trên host VPS.

### Siết chặt Container (Hardening)
- `read_only: true`: Root filesystem ở chế độ chỉ đọc.
- `cap_drop: [ALL]`: Loại bỏ toàn bộ Linux capabilities nguy hiểm. Tuyệt đối **không** dùng `SYS_ADMIN`.
- `security_opt: [no-new-privileges:true]`: Ngăn chặn privilege escalation.
- `init: true`: Chạy qua dumb-init / tini để gặt zombie processes đúng cách.
- **Non-root users**:
  - `core`: user `bun` (UID 1000:1000).
  - `browser-agent`: user `pwuser` (UID 1000:1000).
  - `postgres`: user `postgres` (UID 70:70).
  - `cloudflared`: user `nonroot` (UID 65532:65532).
- `tmpfs`: Gắn thư mục tạm `/tmp` (và `/dev/shm` 1GB cho trình duyệt Chromium) vào RAM.
- **Resource Limits**: Đặt trần CPU và RAM cho từng dịch vụ để chống DoS và cạn kiệt tài nguyên host.

---

## 3. Phát triển Cục bộ (Local Development)

### Yêu cầu:
- [Bun](https://bun.sh) >= 1.4.1
- Docker & Docker Compose (cho PostgreSQL dev)

### Khởi chạy:
```bash
# 1. Cài đặt dependencies
bun install

# 2. Khởi chạy PostgreSQL cục bộ
docker compose -f compose.dev.yml up -d

# 3. Tạo file cấu hình môi trường
cp .env.example .env
# Chỉnh sửa XAI_API_KEY hoặc OMNIROUTE_API_KEY, mật khẩu DB nếu cần

# 4. Chạy migration cơ sở dữ liệu
bun --filter=@messenger/db run db:generate
bun run db:migrate

# 5. Kiểm tra chất lượng mã nguồn
bun run lint
bun run typecheck
bun run build
bun run test
```

---

## 4. Triển khai Production & CI/CD

### Pipeline Tự động (`.github/workflows/deploy.yml`)
Mỗi commit push lên `main` sẽ kích hoạt pipeline tự động:
1. **Quality Gates (Verify)**:
   - Cài đặt dependencies (`bun install --frozen-lockfile`).
   - Linter (`bun run lint`).
   - Typecheck (`bun run typecheck`).
   - Build (`bun run build`).
   - Unit & Invariant Tests (`bun run test`).
   - Migration Invariant Check (`bun --filter=@messenger/db run db:generate` - đảm bảo không sửa schema mà quên tạo migration).
   - Shell Script Validation (`tests/deploy-script.test.sh`, `tests/image-retention.test.sh`).
2. **Selective Build & Publish**:
   - Dùng `paths-filter` phát hiện thay đổi giữa `core` và `browser_agent`.
   - Build container multi-stage, publish lên GHCR (`ghcr.io`) với SHA bất biến.
   - Pinned 40-character commit SHAs cho tất cả GitHub Actions.
3. **VPS Deploy**:
   - Tự động SSH vào VPS, đồng bộ `compose.prod.yml` và scripts.
   - Chạy `scripts/deploy.sh` với cờ selective (`--core`, `--browser-agent`, `--migrate`, `--reconcile`).

### Cấu hình GitHub Secrets & Variables
| Tên | Loại | Mô tả |
|---|---|---|
| `VPS_HOST` | Secret | Địa chỉ IP hoặc hostname VPS |
| `VPS_PORT` | Secret | Cổng SSH (mặc định: `22`) |
| `VPS_USER` | Secret | Tên người dùng SSH (ví dụ: `ubuntu` hoặc `opc`) |
| `VPS_SSH_KEY` | Secret | Private key SSH tương ứng |
| `VPS_KNOWN_HOSTS` | Secret | Output từ lệnh `ssh-keyscan -p <port> <host>` |
| `BUILD_RUNNER` | Variable | Runner build image (mặc định: `ubuntu-24.04-arm`) |
| `DEPLOY_PLATFORM` | Variable | Kiến trúc mục tiêu (mặc định: `linux/arm64`) |

---

## 5. Vận hành & Bảo trì (Operations Runbook)

### 1. Khởi tạo VPS ban đầu:
```bash
sudo ./scripts/bootstrap-vps.sh
# Tạo file /opt/facebook-messenger-ai-rep/.env với các khóa bí mật production
chmod 600 /opt/facebook-messenger-ai-rep/.env
```

### 2. Quản trị Deploy (`scripts/deploy.sh`):
```bash
# Kiểm tra trạng thái hiện tại
./scripts/deploy.sh --status

# Chạy migration thủ công
./scripts/deploy.sh --migrate

# Cập nhật riêng service core
./scripts/deploy.sh --core ghcr.io/<owner>/facebook-messenger-ai-core:latest

# Cập nhật riêng browser-agent
./scripts/deploy.sh --browser-agent ghcr.io/<owner>/facebook-messenger-ai-browser-agent:latest
```

### 3. Sao lưu & Khôi phục Cơ sở dữ liệu:
```bash
# Tạo bản backup tức thời (tự động nén gzip)
./scripts/backup.sh

# Khôi phục từ file backup cụ thể
./scripts/restore.sh /opt/facebook-messenger-ai-rep/backups/backup_2026-09-05.sql.gz
```

### 4. Đăng nhập Facebook lần đầu qua noVNC (Debug Mode):
noVNC được **vô hiệu hóa mặc định** trên production để đảm bảo an toàn tuyệt đối. Khi cần xử lý checkpoint hoặc đăng nhập Facebook lần đầu:
```bash
# 1. Bật debug override trên VPS (chỉ bind localhost port 6080)
docker compose -f compose.prod.yml -f compose.debug.yml up -d browser-agent

# 2. Tạo SSH Tunnel từ máy local của bạn tới VPS:
ssh -L 6080:localhost:6080 -p <VPS_PORT> <VPS_USER>@<VPS_HOST>

# 3. Mở trình duyệt trên máy local:
# Truy cập: http://localhost:6080/vnc.html và nhập VNC_PASSWORD

# 4. Sau khi hoàn tất đăng nhập, tắt debug override:
docker compose -f compose.prod.yml up -d browser-agent
```

### 5. Khôi phục / Reset Database An Toàn:
Lệnh reset xóa sạch dữ liệu ứng dụng để bắt đầu lại:
```bash
./scripts/deploy.sh --reset-db
```
> **Đảm bảo an toàn tuyệt đối**: Lệnh này chỉ drop schema `public` trong PostgreSQL và dọn dẹp volume Redis cũ (nếu có). Volume `messenger_browser_profile` (chứa cookie và phiên đăng nhập Facebook) được **giữ nguyên 100%**, không bao giờ bị xóa.

---

## 6. Kiểm thử Tự động (Test Suites)

Toàn bộ hệ thống được bảo vệ bởi bộ test tự động toàn diện:
```bash
# Chạy bộ test TypeScript (Vitest)
bun run test

# Chạy kiểm thử các scripts triển khai (Bash)
bash tests/deploy-script.test.sh
bash tests/image-retention.test.sh
```
- `tests/ai-guards.test.ts`: Kiểm tra chống ảo giác, rò rỉ prompt và giới hạn ký tự.
- `tests/typing-engine.test.ts`: Kiểm tra tốc độ gõ phím WPM tự nhiên và hủy gõ phím khi có tin mới.
- `tests/dedupe-debounce.test.ts`: Kiểm tra gộp tin nhắn dồn dập và xử lý stale cancellation.
- `tests/scheduler-single-agent.test.ts`: Kiểm tra khóa lease fencing monotonic epoch trong PostgreSQL.
- `tests/stale-version-cancellation.test.ts`: Kiểm tra race condition và hủy bỏ draft cũ khi phiên bản inbound tăng.
- `tests/full-e2e-simulation.test.ts`: Mô phỏng luồng tiếp nhận tin nhắn đa khách hàng và thứ tự xử lý công bằng.
- `tests/settings-api-auth.test.ts`: Kiểm tra bảo vệ API quản trị và phân quyền Cloudflare Access / Session.
- `tests/ai-generator-error-handling.test.ts`: Kiểm tra xử lý lỗi khi gọi nhà cung cấp AI.
