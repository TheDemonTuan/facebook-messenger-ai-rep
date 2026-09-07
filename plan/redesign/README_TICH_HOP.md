# Tích hợp giao diện “Theo dõi trả lời”

Bản thay thế dành cho source `86418efdc049638a70a6058bf10dbb1b3e8aa7d4`.
Không deploy trực tiếp lên production chỉ vì HTML xem trước chạy đúng.

## Xem thử trước

Mở `WORKFLOW_PREVIEW.html` bằng trình duyệt. Có thể tìm khách, chọn bước, xem nhật ký và thử “Chạy đến bước gửi” với khách Mai Anh. Chọn Hoàng Nam để xem trạng thái chưa rõ kết quả gửi; bản mô phỏng không tự thử gửi lại.

Tất cả dữ liệu là giả. Không cần API key, Facebook cookie, server hay Internet. Bản preview dùng cùng phép chiếu trạng thái và CSS với bộ React, nhưng renderer của demo là JavaScript độc lập; không thay thế kiểm thử tích hợp React.

## Bốn file đưa vào repo

```text
apps/dashboard/src/pages/WorkflowPage.tsx
apps/dashboard/src/pages/WorkflowPage.css
apps/dashboard/src/features/workflow/model.ts
apps/dashboard/src/features/workflow/useWorkflowData.ts
```

Thư mục `ui/` đã chứa đúng cấu trúc. `WorkflowPage.tsx` ghi đè trang cũ; ba file còn lại là phần hỗ trợ. Không đổi `App.tsx`, không thêm package; dùng React, react-router-dom và lucide-react vốn có.

Ví dụ, chạy từ thư mục repo đã tải về, thay đường dẫn bundle bằng đường dẫn thật:

```bash
git status --short
git switch -c ui/workflow-execution-view
cp -R /path/to/MESSENGER_REVIEW_86418ef/ui/apps/dashboard/src/. apps/dashboard/src/

bun run lint
bun run typecheck
bun run build
bun run test
git diff --stat
git diff -- apps/dashboard/src/pages/WorkflowPage.tsx
```

Không sao chép file demo vào `public/` rồi coi đó là dashboard thật. Không cần sao chép `tests/model.cjs` vào ứng dụng.

## API đang dùng

- `GET /api/inbox?limit=50`: danh sách giới hạn 50 hội thoại, không phải toàn bộ dữ liệu.
- `GET /api/inbox/:conversationId?messageLimit=50`: chi tiết hội thoại.
- Luồng SSE và `apiFetch` hiện có.

Trang không gọi `/api/workflow/live` vì endpoint đó chưa đảm bảo mọi phần thuộc cùng khách/lượt. Trang cũng không thêm lệnh resume, resolve-all hay send.

Danh sách cập nhật theo chu kỳ 20 giây; chi tiết theo chu kỳ 10 giây và sự kiện liên quan. SSE được gộp, giới hạn tần suất; request timeout 12 giây; tab ẩn hoặc người dùng dừng cập nhật sẽ không tiếp tục vòng refresh bình thường. Chuyển khách hủy request chi tiết cũ. **Nút dừng chỉ dừng cập nhật màn hình, không dừng bot.**

Hook này cần được kiểm thử trong App/SseContext thật. Các khoảng thời gian là mặc định khởi đầu, không phải cam kết “real-time” hay SLA.

## Điều giao diện làm khác

Không lưu object node làm dependency của callback fetch. Lưu ID bước rồi tính bước được chọn từ snapshot hiện tại.

Không hiển thị “đã gửi” chỉ vì AI status SUCCESS. Có hai tin dự kiến thì phải có đủ hai action confirmed; thiếu action hoặc thiếu expected count sẽ không kết luận đã hoàn tất.

Không trộn AI run khác conversation/account/version. Đối với messages/actions/events, API cha vẫn phải kiểm tra quyền và account scope ở server. Lọc phía client không phải ranh giới bảo mật.

Dữ liệu API cũ có giới hạn số runs/actions/events. Giao diện hiện cảnh báo phạm vi; không tự dựng thời gian, progress hoặc trạng thái xanh để lấp dữ liệu thiếu.

Danh sách mới chỉ cho biết “cần xem” từ trạng thái hội thoại được endpoint list cung cấp. Nếu backend giữ WAITING_CUSTOMER dù action SEND_UNCERTAIN, việc phát hiện đó sẽ rõ ở phần chi tiết; backend nên bổ sung `attentionReason` vào list.

## Những việc bộ này KHÔNG sửa

Lỗi gửi key sai đích, overview GET tự bật kênh, resolve-all, action reset, polling kép, lấy snippet thay tin thật, token cap/output cap và retention vẫn cần PR backend. Xem `AUDIT_VA_THIET_KE_WORKFLOW.md`.

Không có thay đổi vào bảng DB, queue, browser profile hoặc cơ chế gửi. Không đảm bảo tài khoản Facebook cá nhân không bị hạn chế.

## Kết quả kiểm thử cục bộ

- 16/16 kiểm thử Node: 13 trường hợp của model hiển thị; 3 mô phỏng tối giản lỗi nguồn đã rà.
- 3 file TypeScript/TSX qua kiểm tra chuyển mã/cú pháp. Không phải full typecheck.
- HTML chạy Chromium ở 1440 px và 390 px; không lỗi JavaScript hay tràn ngang toàn trang trong lần kiểm tra.
- Chưa chạy React/API/DB thật hoặc toàn bộ suite của repo trong môi trường bàn giao.

Xem `tests/model-results.tap`, `tests/preview-qa.json`, `screenshots/`.

Để chạy lại model tests mà không cần TypeScript (dùng bản JS được sinh sẵn):
```bash
node --test tests/workflow-model.test.cjs
```

Để sinh lại từ TypeScript, chạy ở môi trường có package `typescript`:
```bash
node tests/transpile.cjs
node --test tests/workflow-model.test.cjs
```

`preview_qa.py` dùng Python Playwright và Chromium cục bộ. Đổi `executable_path` nếu môi trường khác. Test này nạp HTML bằng `set_content`, không cần chạy web server; nội dung preview phải được tái dựng nếu thay model/CSS/demo.

## Kiểm thử bổ sung trước merge

Chạy với API có độ trễ và lỗi: chọn A rồi B khi A chưa trả về; 401, 403, 429, 500; SSE burst; unmount/StrictMode; chuyển tab ẩn/hiện; pause/resume UI; timestamps không hợp lệ; body chat dài; 50 hội thoại; action nhiều hơn giới hạn API; hai khách đang được AI xử lý đồng thời.

Kiểm thử bàn phím, focus, màn hình điện thoại và container dashboard thực tế, không chỉ viewport trống. Giao diện mới có CSS scope `.wf`, container query và reduced-motion; shell/navigation hiện tại vẫn giữ nguyên.

## Rollback

Rollback commit frontend trên nhánh thử nghiệm. Không reset database hoặc queue. Nếu chưa rõ kết quả gửi, giữ trạng thái đối soát; không đổi về PENDING để làm dashboard hết báo lỗi.
