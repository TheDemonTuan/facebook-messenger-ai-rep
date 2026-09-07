# Rà soát bản mới và thiết kế lại màn hình theo dõi trả lời
## Facebook Messenger AI Rep — snapshot 86418ef

**Ngày rà soát:** 07/09/2026.  
**Commit được đọc:** `86418efdc049638a70a6058bf10dbb1b3e8aa7d4`.  
**Phạm vi:** mã nguồn của các đường nhận tin, xử lý AI, gửi tin, trạng thái, API quản trị, xác thực và workflow; thông tin CI của commit; thiết kế và kiểm thử cục bộ giao diện thay thế.

> **Kết luận:** Có tiến bộ, nhưng chưa đủ cơ sở coi hệ thống đã ổn định hoặc được bảo mật toàn diện. Còn lỗi có thể làm bot hoạt động lại không đúng lúc, làm mất ý nghĩa chống gửi trùng, chuyển API key sang đích không được duyệt và hiển thị sai lượt xử lý. Không nên chỉ thay màu sắc cho workflow rồi coi vấn đề đã được giải quyết.

Bộ này cung cấp **giao diện thay thế và kế hoạch sửa backend**, không phải bản vá hoàn chỉnh cho mọi phát hiện. Không thay đổi repo từ xa, không triển khai VPS, không truy cập tài khoản Facebook, không sử dụng khóa thật để thử lỗ hổng.

## 1. Bằng chứng kiểm thử và giới hạn kết luận

Workflow GitHub Actions `34049954036` của commit này báo thành công: kiểm tra source, build core và deploy. Đây là kết quả CI tại thời điểm chạy, không chứng minh phiên Facebook hiện tại luôn nhận và gửi đúng. [Nguồn CI][CI]

Trong lần rà soát này:
- Đã đọc source qua GitHub tại commit cố định, không chỉ dựa vào README hay tên commit.
- Đã chạy **16 kiểm thử cục bộ**: 13 kiểm thử phép chiếu trạng thái của giao diện mới và 3 mô phỏng tối giản cơ chế lỗi của source cũ. Kết quả nằm ở `tests/model-results.tap`.
- Đã kiểm tra chuyển mã/cú pháp 3 file TypeScript/TSX mới. Đây **không phải** typecheck đầy đủ của monorepo.
- Đã kiểm tra HTML tương tác bằng Chromium ở desktop và mobile 390 px: tìm kiếm, bộ lọc, chọn khách, chọn bước, nhật ký, mô phỏng xác nhận, không tự coi tin chưa rõ kết quả là đã gửi. Không có lỗi JavaScript hoặc request mạng ngoài trong các thao tác được kiểm tra.
- Chưa chạy lại toàn bộ test của repo trong môi trường này, chưa thử tích hợp React/API/DB thật, chưa đo tải hay độ trễ VPS, chưa tái hiện các lỗi gửi bằng tài khoản Facebook thật.

**Cách đọc mức ưu tiên:** P0 là chặn phát hành tự động không giám sát; P1 là sửa trước mở rộng tải hoặc tính năng; P2 là cải thiện vận hành/UX. Đây là ưu tiên cho dự án, không phải điểm CVSS hoặc chứng nhận kiểm toán.

## 2. Những cải thiện đã có

| Hạng mục | Đã thấy trong source | Điều chưa thể kết luận |
|---|---|---|
| Gõ phản hồi | Thêm `Intl.Segmenter` và giới hạn tổng độ trễ chủ động mặc định 2.500 ms | Không đồng nghĩa toàn bộ thao tác gõ hoặc phản hồi mất tối đa 2,5 giây |
| Context | Có cấu hình số tin, số tin người gửi, tuổi lịch sử và manifest | Giới hạn tổng token đang bị công thức nội bộ nâng lên |
| Lưu trữ | Đã thêm xóa `messages`, `ai_runs` sau thời hạn | Chưa bao phủ toàn bộ bản sao nội dung và dữ liệu chống gửi trùng |
| Xác thực | Xác minh JWT Cloudflare bằng JWKS, issuer, audience; production từ chối danh tính chưa được cấp quyền trong DB | Không thay thế kiểm soát quyền trên từng tài nguyên/đích gọi dịch vụ |
| Workflow | Có trang, sự kiện và trạng thái trung gian | Dữ liệu đang được ghép theo “mới nhất của kênh”, chưa là trace một khách |
| CI | Có build, lint, typecheck, test và kiểm tra migration | Các lỗi logic dưới đây vẫn có thể tồn tại dù CI xanh |

Nguồn: [TypingEngine][TYPING], [settings][SETTINGS], [context builder][CONTEXT], [retention][RETENTION], [Cloudflare JWT][CF], [session middleware][AUTH], [workflow backend][ADMIN].

## 3. Các phát hiện cần xử lý

### SEC-01 — P0: thử kết nối AI có thể gửi API key đã lưu sang địa chỉ khác

**Bằng chứng:** Trong `/api/settings/test-ai`, người có quyền `OPERATOR` có thể cung cấp `baseUrl` mới, nhưng nếu không cung cấp `apiKey`, code vẫn lấy `current.apiKey`. Validator chấp nhận URL HTTPS bất kỳ. Client gửi credential đến đích được cấu hình. [admin.ts: test-ai][ADMIN] · [URL validator][SETTINGS] · [client][CLIENT]

Đây là đường rò rỉ credential trong trường hợp tài khoản vận hành bị lạm dụng, bị chiếm hoặc cấu hình sai. Chưa thực hiện gửi khóa thật và không khẳng định người chưa đăng nhập khai thác được.

**Sửa bắt buộc:**
1. Endpoint thử chỉ nhận `providerConfigId` đã được OWNER duyệt; server tự lấy URL/key của cùng bản cấu hình.
2. Khi thử URL mới, tuyệt đối không tự dùng lại key lưu cho origin khác. Chỉ chấp nhận credential riêng được cấp rõ ràng cho đích đã duyệt.
3. Ràng buộc protocol, origin, port và path prefix; kiểm soát redirect, DNS và egress. Proxy nội bộ hợp lệ phải có ngoại lệ cụ thể, không mở toàn bộ mạng private.
4. Không đưa key vào lỗi/log/snapshot; tách quyền xem cấu hình khỏi quyền thay dịch vụ và chi ngân sách test.
5. Test bằng credential giả và HTTP client giả; không dùng khóa production.

OWASP khuyến nghị phối hợp kiểm tra đích hợp lệ và kiểm soát mạng, không coi HTTPS là chứng minh đích đáng tin. [OWASP SSRF][SSRF]

### SAFE-01 — P0: mở trang tổng quan có thể tự bật lại kênh bị treo

**Bằng chứng:** `GET /api/overview` cập nhật kênh sang `RUNNING` khi `isSuspended`, không còn incident OPEN và không pause. Không yêu cầu xác nhận sức khỏe phiên hoặc kiểm tra toàn bộ action chưa rõ đã gửi. [admin.ts: overview][ADMIN]

GET giám sát không được thay đổi trạng thái cho phép bot gửi. Số incident OPEN bằng 0 không tương đương hết checkpoint, hết khóa nhắn tin hoặc đã đối soát đủ.

**Sửa:** bỏ mọi thay đổi nghiệp vụ khỏi GET. Dùng command `resume` riêng, kiểm tra nguyên nhân treo còn tồn tại không, trạng thái adapter còn mới không, action chưa rõ kết quả và cờ pause/takeover. Ghi audit trước/sau và thực hiện đổi trạng thái bằng điều kiện phiên bản.

**Nghiệm thu:** gọi overview 100 lần phải tạo **0** thay đổi trạng thái kênh/hội thoại/action.

### SAFE-02 — P0: đóng incident không được đồng nghĩa thả takeover và bật bot

**Bằng chứng:** resolve một incident có thể đặt `manualMode=false`; resolve-all cũng làm vậy và bỏ `isSuspended` toàn kênh. [admin.ts: incidents][ADMIN]

**Sửa:** phân biệt bốn thao tác:
- ghi nhận đã đọc sự cố;
- ghi nhận sự cố đã xử lý;
- kiểm tra điều kiện cho kênh hoạt động;
- kết thúc việc nhân viên đang hỗ trợ khách.

Mỗi thao tác có quyền, điều kiện và audit riêng. Không có nút “đóng tất cả” trên màn hình theo dõi tiến trình. Không tự phục hồi kênh chỉ vì người vận hành đã dọn danh sách cảnh báo.

### SAFE-03 — P0: createAction vẫn có thể reset action chưa rõ kết quả về PENDING

**Bằng chứng:** `TERMINAL_STATUSES` không gồm `SEND_INTENT`, `SEND_UNCERTAIN`, `UNCONFIRMED`. `createAction()` có đường cập nhật mọi trạng thái ngoài danh sách đó về `PENDING`, dù bảng chuyển trạng thái yêu cầu đối soát trước thử lại. [outbound-repo.ts][OUTBOUND]

Đường này làm yếu cơ chế chống gửi trùng. Đây là rủi ro từ code, không phải kết luận đã quan sát tin trùng trên VPS.

**Sửa:**
- Tạo action bất biến với khóa duy nhất; gọi lại trả đúng action cũ, không đổi payload hay trạng thái.
- Action sau bước có thể đã gửi chỉ được xác nhận hoặc đi qua quy trình duyệt thử lại có bằng chứng.
- Không cho đường tạo draft/AI retry đặt lại action sau Enter.
- Giữ thông tin ownership/fencing; loại bỏ alias/fallback làm bỏ qua điều kiện khi hoàn tất migration.
- Sau lỗi giữa thao tác gửi và ghi DB: giữ “chưa rõ kết quả”, không chuyển thành “chưa gửi” để worker tự gửi lại.

**Nghiệm thu:** cùng actionId gọi create nhiều lần ở mọi trạng thái; `SEND_UNCERTAIN` vẫn giữ nguyên, không tạo job gửi lại.

### REL-01 — P1: vòng observer vẫn có thể lập hai lịch polling

**Bằng chứng:** nhánh baseline và nhánh lỗi phiên tự đặt `setTimeout`, sau đó `finally` đặt thêm lịch. Nhánh rate-limited có lịch nghỉ 15 phút nhưng vẫn có lịch thường từ finally. [messenger-adapter.ts: observeInbound][ADAPTER]

**Sửa:** một nơi duy nhất đặt timer; mỗi lượt trả về `nextDelayMs`; có single-flight và generation token để vòng cũ không sống lại sau stop/reinitialize. `stop()` hủy toàn bộ lượt đang chờ và callback cũ. Lỗi checkpoint/rate limit cần dừng đúng trạng thái, không tự reload để cố vượt hạn chế.

**Nghiệm thu:** fake timers xác nhận chỉ có một lượt kế tiếp; nhánh bị hạn chế không sinh thêm poll sớm. Có kiểm thử start/stop/reinitialize liên tiếp.

### REL-02 — P1: sidebar preview đang được coi như tin nhắn đầy đủ

**Bằng chứng:** observer phát `inboundCallback` từ snippet, đặt messageId gồm `Date.now()`, bỏ qua snippet giống lần trước và đánh dấu seen trước khi callback thành công. [messenger-adapter.ts][ADAPTER]

Rủi ro: thiếu đoạn cuối tin dài; thiếu tin trong burst; nhầm hai lần khách gửi cùng nội dung; mất cơ hội ingest lại sau callback/DB lỗi.

**Sửa:** preview chỉ báo “hội thoại có thay đổi”. Tiếp nhận authoritative message có ID/nguồn rõ ràng bằng đọc tăng dần có giới hạn. Chỉ cập nhật checkpoint/dedupe sau khi giao dịch DB đã commit. Nếu không lấy được bằng chứng đủ tin cậy, báo chưa xác minh và dừng xử lý tự động thay vì phát minh ID “chuẩn”.

Không tăng polling dày đặc hoặc mở hàng loạt tab để bù cho thiếu correctness. Đo số lần điều hướng, thời gian quan sát và backlog riêng.

### AI-01 — P1: token cap cấu hình không phải hard cap

**Bằng chứng:**
```ts
const effectiveMaxInputTokens =
  Math.max(systemTokens + 4096, maxInputTokens, 16384);
```
Đặt `contextMaxInputTokens=4096` vẫn có ngưỡng hiệu dụng ít nhất 16384. Ước lượng `text.length / 2.5` không đảm bảo số token theo tokenizer của mọi model. Summary và phần prompt được thêm ở tầng sau cũng cần được tính. [context-builder.ts][CONTEXT]

**Sửa:** tính ngân sách trên request thực tế sau dựng system/history/summary/wrappers; không âm thầm nâng cap của chủ shop. Khi phần bắt buộc đã vượt cap: trả lỗi cấu hình có giải thích hoặc chuyển sang chính sách rút gọn được chọn trước. Provider lạ chưa có tokenizer phải ghi rõ số ước tính, có headroom và giới hạn byte; không hứa đếm tuyệt đối chính xác.

Giữ cả cụm tin chưa trả lời của lượt hiện tại, không chỉ một tin cuối. Nếu cụm quá dài, xử lý theo chính sách giới hạn rõ ràng, không mất tin ở inbox. Một tin quá lớn không được làm vô hiệu toàn bộ cap.

### AI-02 — P1: aiMaxOutputTokens chưa nối vào request thật; kết quả cũ chưa được chặn ở điểm cuối

**Bằng chứng:** settings có `aiMaxOutputTokens`; nhánh OpenAI chưa truyền giới hạn output trong body, nhánh Anthropic dùng cố định 1024. Handler gọi AI rồi tạo draft/action mà chưa có giao dịch kiểm tra lại version ngay trước công bố kết quả. [settings][SETTINGS] · [client][CLIENT] · [AI handler][AIHANDLER]

**Sửa:**
- Map đúng tên tham số giới hạn theo adapter/model; test request body thật, không chỉ kiểm tra form.
- Một deadline tổng cho lượt; retry nằm trong deadline và ngân sách, không nhân thời gian chờ vô hạn.
- Truyền AbortSignal từ job đến client; abort khi lượt bị thay thế. Abort không bảo đảm nhà cung cấp hoàn tiền, nên vẫn lưu usage thực sự biết được.
- Sau response: kiểm tra lại inboundVersion, ownership, manual mode, quyền trả lời. Giao dịch publish draft + actions + jobs phải thất bại nếu lượt đã cũ.
- Ghi từng attempt, prompt manifest và usage. Số không biết là `null`, không ghi `0` như miễn phí.

### PERF-01 — P1: click vào node workflow có thể gây vòng fetch liên tục

**Bằng chứng:** `loadWorkflow` phụ thuộc `selectedNode`; fetch lại đặt `selectedNode` thành object JSON mới; effect phụ thuộc `loadWorkflow` và gọi fetch ngay. [WorkflowPage.tsx][WORKFLOW]

**Sửa trong giao diện đính kèm:** lưu `selectedStageId` dạng chuỗi, derive node từ dữ liệu; chọn node không gọi API. Hook riêng có timeout, một request đang chạy cho từng tài nguyên, hủy request khi đổi khách, gộp sự kiện và dừng refresh khi tab ẩn.

Cần chạy kiểm thử React với fake timers sau tích hợp, vì HTML demo không chạy hook React thật.

### OBS-01 — P1: workflow ghép dữ liệu từ nhiều khách và có trạng thái thành công mặc định

**Bằng chứng:** `/api/workflow/live` lấy latest inbound, turn, AI run và action độc lập theo channel. Nội dung latestTrace có thể không cùng conversation/version. Một số nhãn `CONFIRMED`, “Gửi thành công”, “BẢO VỆ” là fallback/chuỗi cố định. Thời hạn xác minh hiển thị 15 giây trong khi sender dùng 10 giây. [admin.ts: workflow][ADMIN] · [sender-worker.ts][SENDER]

**Sửa:** màn hình chi tiết chỉ mô tả một execution. Summary toàn hệ thống là số lượng theo trạng thái, không trộn nội dung cá nhân vào một trace giả. Mọi node chứa nguồn bằng chứng hoặc `UNKNOWN`; không có hàng nào không dữ liệu mà tô xanh.

Giao diện mới dùng API chi tiết một hội thoại và lọc cùng inboundVersion. Đây là bước chuyển tiếp; các giới hạn của API hiện tại được hiển thị rõ.

### OBS-02 — P1: hoàn tất turn sau một action chưa bảo đảm cả lượt đã gửi đủ

**Bằng chứng:** sender cập nhật `WAITING_CUSTOMER`, gọi `completeTurn(turnId)` sau một action confirmed. Một lượt có thể có nhiều action. [sender-worker.ts][SENDER]

**Sửa:** tách trạng thái action và lượt. Chỉ đóng lượt khi mọi action dự kiến đã đạt trạng thái kết thúc hợp lệ; “1/2 đã xác nhận” không là “2/2”. Chặn sắp lịch lượt sau dựa trên trạng thái hoàn tất giả.

Giao diện đính kèm kiểm tra số action dự kiến và số confirmed; không chỉ tin `WAITING_CUSTOMER`. Bằng chứng gửi trên UI vẫn phụ thuộc độ đúng của xác minh backend.

### DATA-01 — P1: retention mới chỉ giải quyết một phần

**Bằng chứng:** handler dọn jobs, outbox, messages và ai_runs. Hai hàm mới dùng DELETE không chia lô; còn các bản sao nội dung như inbound raw payload và event/action cần chính sách riêng. [retention.ts][RETENTION] · [conversation-repo.ts][CONVREPO]

**Sửa:** đo `pg_total_relation_size`/TOAST/index trước; phân lớp thời hạn:
- nội dung chat phục vụ chăm sóc: ví dụ 14–30 ngày, tùy nhu cầu;
- body request/response AI: ngắn hơn, ví dụ 3–7 ngày; lỗi debug theo quyền;
- metadata chống gửi trùng, watermark, action chưa đối soát: không xóa chỉ vì text hết hạn;
- audit bảo mật và backup: lịch riêng, quyền và lý do rõ ràng.

Chia lô theo cursor, giới hạn thời gian và số dòng mỗi lần; không xóa bằng chứng của action còn chạy/chưa rõ kết quả. Tạo chỉ mục phù hợp. DELETE không mặc nhiên trả ngay toàn bộ dung lượng file cho hệ điều hành; theo dõi vacuum và bloat. Không dùng VACUUM FULL như tác vụ mặc định trên DB đang phục vụ. [PostgreSQL 17][PG]

Không cần thêm Redis để sửa những điểm này. Cache là bước sau số đo, không là nơi duy nhất lưu sự thật về gửi tin.

### SEC-02 — P1/P2 theo mô hình tài khoản: quyền tài nguyên và log cần chặt hơn

**Bằng chứng:** endpoint chi tiết hội thoại tìm theo conversationId, các truy vấn con theo conversationId; chưa thể hiện kiểm tra channelAccountId của người dùng tại handler này. API AI runs trả snapshot trong danh sách. [inbox.ts][INBOX] · [admin.ts][ADMIN]

Với một chủ/một channel, nguy cơ thấp hơn đa kênh, nhưng đây là ranh giới phải sửa trước mở rộng. UUID không phải quyền truy cập.

**Sửa:** repository bắt buộc account scope; permission riêng cho body chat, body AI, export và thay cấu hình; danh sách chỉ metadata, chi tiết mới tải body. Không gửi cookie/token/khóa/prompt nhạy cảm vào SSE hay log mặc định. Kiểm tra log tại điểm ghi, không chỉ sanitize khi trả HTTP. Có thời hạn lưu và audit khi đọc/xuất nội dung nhạy cảm. [OWASP logging][LOGGING]

### REL-03 — P2: cap thời gian gõ và tín hiệu hủy cần đo theo thực tế

2.500 ms hiện giới hạn tổng các lần sleep do typing engine chủ động thêm, không gồm thời gian gọi browser cho mỗi grapheme. Giữ cải tiến Unicode, nhưng đặt deadline theo thời gian đã trôi qua; gom thao tác nhập vừa đủ, hủy được; kiểm tra `completed === true` trước Enter. [TypingEngine][TYPING] · [sender][SENDER]

Observer hiện ngừng khi giữ sendLock. Không nên kéo dài pha gõ để “giống người thật” đến mức làm chậm nhận tin và hủy lượt cũ. Mục tiêu là phản hồi đúng, nhanh và thể hiện trạng thái trung thực, không tạo delay giả.

## 4. Thiết kế workflow mới: theo dõi một lần trả lời, không phải trình vẽ sơ đồ

### Vì sao chọn hướng này

Một workflow editor trả lời “đã cấu hình các bước nào?”. Màn hình vận hành cần trả lời “khách A đang ở bước nào của lần trả lời B, chờ ai, lỗi ở đâu?”. n8n tách danh sách/lịch sử executions khỏi việc xây workflow; cách đọc trace của Grafana đặt các bước và thời gian trong cùng một lần thực thi. Lấy nguyên tắc này, không sao chép một canvas nhiều dây nối vào bài toán chỉ có vài bước. [n8n][N8N] · [Grafana][GRAFANA]

### Bố cục đã xây

**Trái:** danh sách khách gần đây, tìm theo tên/nội dung, bộ lọc đang xử lý/cần xem. Số đếm chỉ cho tập dữ liệu đã tải, không giả làm KPI toàn hệ thống.

**Giữa:** đúng khách, đúng lượt; trạng thái chính; sáu bước dễ hiểu; số tin confirmed/tổng dự kiến; tin khách và câu trả lời; nhật ký theo thời gian. AI thành công không biến thành gửi thành công.

**Phải:** bằng chứng của bước đang chọn; model/token/lượt; liên kết đến hội thoại/log; chi tiết kỹ thuật thu gọn.

**Mobile:** các bước chuyển thành danh sách dọc, không bắt kéo một canvas rất rộng. Các khu vực co về một cột. Bản xem trước 390 px không tràn ngang trang.

Màu chỉ hỗ trợ: xanh cho có bằng chứng hoàn tất; tím cho đang xử lý; vàng cho cần đối soát; xám cho thiếu dữ liệu. Mỗi trạng thái có chữ, không dựa riêng màu hoặc hiệu ứng nhấp nháy.

### Những thứ cố ý không thêm

Không thêm React Flow/n8n/Redis chỉ để dựng sáu bước. Không thêm remote font, CDN icon, graph engine, drag node, auto-zoom hoặc hiệu ứng chạy dây liên tục. Không hiển thị raw JSON làm nội dung chính. Không cho thao tác đóng tất cả sự cố hoặc tự gửi lại từ màn hình theo dõi.

Nếu sau này xuất hiện phân nhánh thực sự, mới cân nhắc thư viện graph với read-only nodes. Mặc định vẫn là execution viewer; không cho người dùng kéo node để thay đổi nghiệp vụ ngoài ý muốn.

## 5. Hợp đồng trace backend cần làm tiếp

### Định danh

```text
channelAccountId
  -> conversationId
    -> executionId / turnId
      -> inboundBatchMessageIds[]
      -> aiAttempts[]
      -> outboundActions[]
      -> orderedEvents[]
```

`inboundVersion` hữu ích cho chống stale nhưng không thay thế danh sách các tin trong một cụm gom tin. Một attempt AI không phải cả execution; một action gửi không phải cả lượt.

Không dùng tên khách làm khóa. Không nhét Facebook ID vào prompt chỉ để truy log. Log kỹ thuật dùng ID nội bộ; người có quyền xem chi tiết mới thấy tên/nội dung.

### API đề xuất, chưa được triển khai trong bộ giao diện

```http
GET /api/workflow/executions?status=active&cursor=...&limit=30
GET /api/workflow/executions/:executionId
GET /api/workflow/executions/:executionId/events?afterSequence=...
```

Response phải có `channelAccountId`, `conversationId`, `executionId`, `inboundVersion`, `snapshotSequence`, `generatedAt`, `isPartial`, `nextCursor`. Mỗi bước có:
```ts
type StageState =
  | "NOT_STARTED" | "RUNNING" | "WAITING" | "SUCCEEDED"
  | "FAILED" | "CANCELLED" | "UNKNOWN";

interface StageEvidence {
  stage: string;
  state: StageState;
  startedAt: string | null;
  finishedAt: string | null;
  deadlineAt: string | null;
  waitingReasonCode: string | null;
  evidenceEventIds: string[];
}
```

Trạng thái kênh tách khỏi trạng thái giao diện đang kết nối. `generatedAt` cũ thì hiển thị dữ liệu cũ, không giả là live. Không có deadline thì chỉ hiện thời gian đã chờ; không bịa phần trăm tiến độ.

Mỗi event được ghi với việc đổi state trong cùng transaction/outbox, có sequence bền vững. SSE chỉ đưa metadata cần để refresh hoặc delta có phiên bản; không stream toàn bộ prompt/chat mặc định. Client reconnect dùng sequence cursor, lấy snapshot khi thiếu đoạn; không trộn cursor UUID với số parseInt.

Dữ liệu projection có thể nằm trong PostgreSQL hiện có. Chỉ thêm cache khi đo thấy truy vấn thực sự là nút thắt. Index bắt đầu từ `(channel_account_id, conversation_id, inbound_version, created_at, id)` theo truy vấn cụ thể; không tạo hàng loạt index không có số đo.

### Thời gian cần đo

Ghi riêng thời điểm Facebook hiển thị tin nếu thực sự có, thời điểm observer thấy, commit ingest, kết thúc gom, chờ worker, AI từng attempt, chờ sender, bắt đầu/hoàn tất gõ, send intent và xác minh. Khi không biết thời điểm Facebook gửi thật, không gắn nhãn thời gian observer như end-to-end latency của khách.

Chỉ sau instrumentation mới đặt mục tiêu p50/p95 và so sánh trước/sau. Không hứa mốc vài giây khi chưa biết model/proxy/tải/độ dài câu trả lời.

## 6. Giới hạn của giao diện thay thế đính kèm

Bốn file trong `ui/` dùng endpoint hiện có `/api/inbox` và `/api/inbox/:conversationId`, không dùng latestTrace toàn kênh.

API cũ chỉ trả tối đa số lượng nhất định: 10 AI runs, 10 actions, 30 events; việc chọn lượt cũ có thể thiếu bằng chứng. Giao diện luôn nêu phạm vi không đầy đủ, không suy diễn phần bị cắt. [inbox.ts][INBOX]

Chưa thể:
- cho biết toàn bộ cụm tin chưa trả lời nếu backend chưa gắn batch IDs;
- khẳng định tổng thời gian từng bước nếu source chưa lưu timestamps tương ứng;
- xác minh trạng thái adapter/seen/delivery bên ngoài DB;
- sửa lỗi retention, key, observer hoặc action bằng việc thay frontend;
- tự bảo vệ quyền truy cập tài nguyên nếu backend thiếu account scope.

Các mẫu dữ liệu của HTML là giả, không phải ảnh chụp dashboard production. Giao diện React cần đi qua CI và thử staging thật trước khi triển khai.

## 7. Kiểm tra bảo mật và vận hành trước phát hành

### Kiểm soát truy cập và hạ tầng

Giữ xác minh JWT Cloudflare hiện có; kiểm thử thiếu token, sai audience, hết hạn, email không được cấp quyền và header danh tính tự giả. Xác nhận origin không mở trực tiếp ra Internet để bỏ qua Access. Kiểm tra MFA/policy tại Cloudflare bằng cấu hình thực tế, không suy từ source.

Tách database user migration khỏi runtime khi khả thi; browser chỉ quyền cần thiết; secrets không vào image hoặc git. Kiểm tra noVNC chỉ bật trong phiên bảo trì được kiểm soát, profile browser không bị xóa khi dọn cache/storage. Kiểm tra image/container cấu hình thực, dependency scan và quyền file backup; chưa có dữ liệu đủ để xác nhận các mục này trên VPS.

Giới hạn CORS về origin dashboard; kiểm thử CSRF cho mọi command; giới hạn chi phí endpoint test AI theo người/tài khoản; giới hạn kích thước payload và pagination. Xem xét CSP phù hợp app; bản preview tự chứa dùng inline scripts cho tiện xem, **không phải CSP production mẫu**.

### Độ tin cậy gửi và tiếp quản

Mô phỏng restart trước Enter, ngay sau Enter, trước confirm DB, mất ownership, tin mới khi AI chạy, tin mới khi typing, nhân viên tiếp quản giữa lượt và hai action trong một lượt. Bất kỳ trường hợp đã có thể gửi phải về chưa rõ kết quả nếu thiếu bằng chứng.

Không hứa chống khóa Facebook bằng delay/WPM. Dừng khi checkpoint/rate-limit; dùng thao tác hợp lệ và có người xử lý xác minh. Hướng Page/Messenger Platform là một adapter khác cần đánh giá riêng, không thể biến browser cá nhân thành API Page bằng một cài đặt.

### Lưu trữ

Đo bảng/index/WAL/backup/browser-profile/container-log riêng. Kiểm tra khôi phục backup, không chỉ tạo backup thành công. Sau retention vẫn phải chống phát lại những action đã gửi và không mất thông tin đối soát. Không xóa cookie/profile để lấy dung lượng.

## 8. Thứ tự triển khai

| PR | Phạm vi | Điều kiện hoàn thành |
|---|---|---|
| 1 | SEC-01, SAFE-01/02 | Không có request key sai đích; GET không ghi nghiệp vụ; đóng incident không tự bật bot |
| 2 | SAFE-03, REL-01/02 | Không reset action hậu-Enter; timer đơn; callback lỗi không làm mất ingest; test burst/restart |
| 3 | AI-01/02, REL-03 | Budget thực thi đúng; output cap vào body; stale response không publish; deadline có kiểm thử |
| 4 | Giao diện mới | Typecheck/lint/build/React integration test; không fetch loop; mobile/keyboard; trạng thái thiếu dữ liệu rõ ràng |
| 5 | Trace API bền vững | Đúng execution/batch/attempt/action; reconnect và thứ tự event; không trộn khách |
| 6 | DATA-01 và vận hành | Retention chia lô; dedupe ledger còn đúng; backup restore; có biểu đồ dung lượng và độ trễ thật |

Không gom tất cả vào một refactor lớn. Giữ sender concurrency an toàn; không tăng số worker gửi để che độ trễ chưa đo.

## 9. Release gates và rollback

Chặn phát hành tự động không giám sát nếu còn SEC-01 hoặc SAFE-01/02/03. UI có thể thử trước trên staging vì phần thay thế chỉ đọc dữ liệu; điều đó không biến backend hiện tại thành an toàn.

Các gate bắt buộc:
1. Test hai khách cùng lúc: không có nội dung/AI run/action lẫn sang nhau.
2. Test `AI SUCCESS + chưa send` và `1/2 confirmed`: không hiện hoàn tất cả lượt.
3. Test click node 100 lần: không tăng số fetch ngoài lịch/sự kiện cho phép.
4. Test output/input cap bằng request thật tới mock, kể cả prompt dài và một tin quá lớn.
5. Test viewer/operator/owner và resource thuộc kênh khác.
6. Test các điểm crash gửi và takeover; không blind retry.
7. Test retention với dữ liệu đang xử lý và cũ hơn thời hạn; chống phát lại vẫn đúng.
8. Canary có giám sát, so sánh error/backlog/p95, rồi mới mở rộng.

Rollback frontend bằng commit trước trên nhánh thử nghiệm. Không rollback DB bằng cách xóa bảng/history/action; migration dùng expand/contract, có backup và kiểm thử restore. Khi chưa rõ kết quả gửi, giữ kênh ở trạng thái cần kiểm tra thay vì reset queue.

## 10. Nội dung bộ bàn giao

- `WORKFLOW_PREVIEW.html`: mở độc lập, bấm thử, không kết nối Facebook/API.
- `ui/`: bốn file giao diện dùng cấu trúc repo hiện tại.
- `README_TICH_HOP.md`: cách áp dụng vào nhánh, giới hạn và lệnh kiểm tra.
- `tests/`: phép chiếu trạng thái, mô phỏng lỗi tối giản và kết quả cục bộ.
- `screenshots/`: desktop, mobile, tình huống gửi chưa xác định.
- Tài liệu này: các lỗi backend **cần sửa tiếp**, không phải tuyên bố đã sửa.

## Nguồn đối chiếu

[CI]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/actions/runs/34049954036
[ADMIN]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/apps/core/src/routes/admin.ts
[SETTINGS]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/packages/contracts/src/settings.ts
[CLIENT]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/packages/ai/src/client.ts
[CONTEXT]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/packages/ai/src/context-builder.ts
[AIHANDLER]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/apps/core/src/jobs/handlers/ai.ts
[OUTBOUND]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/packages/db/src/repository/outbound-repo.ts
[ADAPTER]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/apps/browser-agent/src/messenger-adapter.ts
[SENDER]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/apps/browser-agent/src/sender-worker.ts
[TYPING]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/packages/channel/src/typing-engine.ts
[RETENTION]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/apps/core/src/jobs/handlers/retention.ts
[CONVREPO]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/packages/db/src/repository/conversation-repo.ts
[WORKFLOW]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/apps/dashboard/src/pages/WorkflowPage.tsx
[INBOX]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/apps/core/src/routes/inbox.ts
[CF]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/apps/core/src/auth/cloudflare.ts
[AUTH]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/apps/core/src/auth/session.ts
[SSRF]: https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html
[LOGGING]: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
[N8N]: https://docs.n8n.io/build/understand-workflows/understand-executions/view-executions-for-a-single-workflow
[GRAFANA]: https://grafana.com/docs/learning-paths/read-a-trace/read-the-waterfall/
[PG]: https://www.postgresql.org/docs/17/routine-vacuuming.html
