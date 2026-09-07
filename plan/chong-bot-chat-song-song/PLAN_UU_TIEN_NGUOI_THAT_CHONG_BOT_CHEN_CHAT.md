# Kế hoạch ưu tiên người thật: ngăn bot chen vào khi shop đang chat

**Dự án:** `TheDemonTuan/facebook-messenger-ai-rep`  
**Ngày rà soát:** 07/09/2026 — múi giờ Asia/Ho_Chi_Minh  
**Snapshot đã kiểm tra lại:** `86418efdc049638a70a6058bf10dbb1b3e8aa7d4` trên nhánh `main`. [R01]  
**Loại bàn giao:** kế hoạch triển khai, không phải bản vá đã áp dụng.

> Quy tắc sản phẩm: Khi chủ shop/nhân viên bắt đầu xử lý một hội thoại, bot phải nhường hội thoại đó. Câu trả lời AI đang chờ không được gửi nối theo người thật. Việc hết thời gian tạm dừng không được tự kích hoạt trả lời bù tin cũ.

## 0. Quyết định đề xuất

Giữ PostgreSQL và hàng đợi hiện có. Không thêm Redis chỉ để làm tính năng này. Bổ sung một cơ chế **quyền trả lời theo hội thoại**, dùng chung cho nơi nhận tin, worker AI, sender, tiếp quản thủ công và phục hồi sau restart.

Cấu hình khởi đầu đề xuất:

| Chính sách | Giá trị ban đầu |
|---|---|
| Chờ người thật trả lời trước | 8 giây cho mỗi cụm tin đủ điều kiện; đây không phải tổng thời gian phản hồi |
| Gom các tin khách gửi liên tiếp | 2 giây yên lặng, tối đa 12 giây từ tin đầu của cụm |
| Tự nhường sau khi phát hiện người thật gửi | 30 phút không có hoạt động hội thoại mới |
| Khi hai bên tiếp tục chat trong thời gian nhường | Gia hạn 30 phút từ tin mới nhất của khách hoặc người thật |
| Khi thời gian nhường kết thúc | Chỉ cho phép trả lời **tin mới phát sinh sau mốc kết thúc** |
| Bấm “Tôi đang hỗ trợ” | Giữ quyền người thật đến khi chủ động giao lại, không tự hết hạn |
| Đang gõ trong dashboard | Giữ quyền tạm thời 60 giây, gia hạn khi thực sự nhập liệu |
| Số tin bot trong một lượt trả lời | Mặc định 1 |
| Bot tự nhắn thêm khi không có tin khách mới | Tắt |
| Không xác định được tin đi do ai gửi | Tạm giữ quyền gửi để đối soát, không đoán đó là tin bot |

Các mốc 8 giây, 12 giây và 30 phút là **đề xuất cấu hình để thử nghiệm**, không phải ngưỡng tối ưu đã đo trên VPS hoặc quy định của Facebook. Ưu tiên ban đầu là tránh chen lời; sau khi có số liệu mới điều chỉnh độ trễ.

Tính năng phải hoạt động cả khi bạn nhắn trong dashboard lẫn khi bạn nhắn trực tiếp bằng Facebook/Messenger. Trường hợp thứ hai phụ thuộc vào việc browser-agent quan sát được tin đã đồng bộ; không thể coi tương đương với quyền điều phối chủ động trong dashboard.

---

## 1. Phạm vi và giới hạn kiểm chứng

Đã đọc lại các đường code liên quan trực tiếp: observer, browser entrypoint, sender, manual takeover/manual-send, AI handler, cấu hình, persona, outbound repository, policy recheck, một phần ingest và schema. Các kết luận ở mục 2 là từ snapshot đã nêu, không phải giả định từ bản kế hoạch cũ.

Chưa đo trạng thái VPS đang chạy, chưa xác minh VPS đã deploy đúng commit này, chưa tái hiện trên phiên Facebook thật và chưa chạy kiểm thử tích hợp repo. Các bài kiểm thử trong tài liệu là yêu cầu nghiệm thu cần triển khai, không phải danh sách đã chạy đạt.

Phạm vi chính là hội thoại trực tiếp. Với nhóm chat, tiếp tục tắt trả lời nhóm theo mặc định cho đến khi kiểm tra riêng danh tính người gửi và điều kiện được phép trả lời. Không được suy ra người thật chỉ từ tên hoặc nội dung tin.

### Giới hạn cần nói rõ

Nếu bạn đang gõ trên điện thoại nhưng chưa gửi, source hiện tại không cung cấp tín hiệu đáng tin rằng bạn đang chuẩn bị trả lời. Ngay cả khi bạn đã gửi, tin có thể chưa đồng bộ sang browser của bot.

Vì vậy:

- Có thể kiểm soát chặt các lần gửi đi qua dashboard và sender của hệ thống.
- Có thể giảm mạnh việc chen lời khi chat bằng ứng dụng Messenger khác thông qua phát hiện tin đi, khoảng chờ và kiểm tra ngay trước gửi.
- Không được hứa loại bỏ tuyệt đối mọi tình huống bấm gửi đồng thời giữa hai thiết bị độc lập.
- Khi cần chắc chắn bot im lặng trước cả lúc bạn bắt đầu gõ trên điện thoại, dùng “Tôi đang hỗ trợ” hoặc chế độ chỉ tạo nháp, không tự gửi.

Không đề xuất đọc draft trên thiết bị không được tích hợp, gọi API riêng không được hỗ trợ hoặc vượt cơ chế bảo vệ của Facebook.

---

## 2. Các nguyên nhân đã thấy trong source

| Mã | Phát hiện có căn cứ | Tác động liên quan tới hiện tượng |
|---|---|---|
| F01 | `processInboundBubbles()` dùng tin đi làm mốc để bỏ qua tin cũ, nhưng không phát sự kiện riêng “người thật vừa gửi”. Nhánh sidebar cũng bỏ qua outgoing. [R02] | Bạn đã trả lời nhưng hệ thống không tự chuyển hội thoại sang người thật xử lý. |
| F02 | Browser entrypoint nối `observeInbound()` với ingest và hủy theo `inboundVersion`; không có luồng tương ứng cho tin người thật gửi bên ngoài hệ thống. [R03] | Cơ chế hủy phản ứng với tin khách mới, chưa phản ứng đầy đủ với chủ shop vừa trả lời. |
| F03 | Sender kiểm tra `manualMode` và policy. Điều này có ích, nhưng chỉ hiệu quả khi trạng thái ấy đã được cập nhật. [R04][R09] | Tin gửi trực tiếp trên Messenger không tự làm các kiểm tra này thất bại. |
| F04 | `/manual-send` tạo action nhưng không tự giành quyền người thật và hủy AI trong cùng giao dịch. [R05] | Không được dựa riêng vào nút bấm/giao diện để bảo đảm API không tạo cuộc đua với AI. |
| F05 | `/takeover` dùng giá trị phiên bản giả `9999999`, gửi thông báo hủy rồi trả `cancelAck: true` ngay. [R05] | “Đã yêu cầu dừng” bị trình bày thành “đã dừng thực sự”. |
| F06 | AI handler sau khi nhận kết quả vẫn tạo các outbound action; đoạn sau lời gọi AI không có một giao dịch tái kiểm tra quyền trả lời trước khi tạo action. [R06] | Kết quả sinh trước lúc tiếp quản có thể xuất hiện sau lúc tiếp quản; sender phải gánh kiểm tra cuối. |
| F07 | Action ID được tính từ account + conversation + inboundVersion + responseIndex, không có actor/ý định gửi. Manual-send luôn dùng responseIndex 0. [R05][R07] | Tin người thật và tin AI có thể trùng mã action; hai tin thủ công liên tiếp cũng có thể trùng nếu khách chưa nhắn tiếp. |
| F08 | `createAction()` có thể reset trạng thái chưa kết thúc về PENDING, đồng thời không cập nhật `actor` trong nhánh update. [R07] | Có thể thay nội dung trên action cũ và giữ nhãn nguồn cũ; không an toàn khi kết quả gửi chưa rõ. |
| F09 | Khi giữ `sendLock`, observer bỏ qua lượt đọc. [R08] | Tín hiệu khách/chủ shop mới nhắn có thể bị bỏ lỡ đúng lúc bot đang gõ/gửi. |
| F10 | Mặc định tối đa ba tin; persona còn gợi ý tách câu hỏi/chào kết thành tin thứ hai; AI handler xếp hàng từng phần. [R06][R10][R11] | Bot có thể nối thêm nhiều tin, làm cảm giác chen lời rõ hơn. |
| F11 | Ingest hủy action cũ mà không tách actor và có thể chạm cả trạng thái đã bắt đầu gửi. [R12] | Khi xây takeover mới cần tránh hủy nhầm tin thủ công và xóa mất tình trạng gửi chưa rõ. |

**Kết luận:** đây chủ yếu là lỗi điều phối quyền trả lời và vòng đời tác vụ. Chỉ sửa prompt hoặc tăng `debounceMs` không đủ.

### Kịch bản phù hợp với đường code hiện tại

```text
Khách gửi câu hỏi
    -> ingest tăng inboundVersion
    -> AI bắt đầu tạo câu trả lời

Bạn trả lời trên ứng dụng Messenger
    -> xuất hiện outgoing bubble
    -> observer không phát sự kiện tiếp quản người thật
    -> manualMode vẫn false, inboundVersion của khách không đổi

AI tạo xong câu trả lời
    -> tạo action 0, có thể thêm action 1 và action 2
    -> các kiểm tra DB vẫn có thể cho phép gửi
    -> khách nhận thêm tin của bot sau tin của bạn
```

Đây là diễn giải từ code, không phải trace đã thu từ VPS của bạn.

---

## 3. Đối chiếu cách sản phẩm thực tế xử lý

Intercom ghi rõ việc chỉ giao hội thoại cho nhân viên hoặc snooze không làm Fin dừng; việc nhân viên gửi tin trong hội thoại mới ngắt automation. Bài học nên áp dụng là dùng **hành động trả lời thực sự** làm tín hiệu tiếp quản, thay vì xem trang dashboard hoặc trạng thái online chung. [E01]

Manychat có cơ chế tạm dừng automation theo contact, có thời hạn hoặc cho đến khi mở lại; nhân viên vẫn chat được trong thời gian tạm dừng. Ta áp dụng nguyên tắc “dừng bot, không dừng hộp thư”. Không sao chép giả định rằng công cụ đó cung cấp cùng mức quan sát cho browser cá nhân của repo này. [E02]

Thiết kế dưới đây là đề xuất riêng cho repo, không phải mô tả cách hai sản phẩm trên triển khai nội bộ.

---

## 4. Hành vi sản phẩm phải đạt

### 4.1 Khách nhắn, bạn trả lời ngay

Ví dụ minh họa:

```text
10:00:00  Khách: “Mẫu này còn màu đen không?”
10:00:00  Hệ thống ghi nhận tin, bắt đầu chờ người thật
10:00:04  Bạn: “Dạ còn, bạn lấy size nào?”
10:00:05  Browser quan sát được tin đi của bạn
10:00:05  Hội thoại chuyển sang Người thật đang hỗ trợ
          Hủy công việc AI chưa gửi; không trả lời nối thêm
10:00:20  Khách: “Size L nhé”
          Vẫn thuộc phiên người thật; bot im lặng
10:00:28  Bạn: “Mình chốt size L cho bạn”
          Gia hạn thời gian nhường
10:30:28  Hết thời gian nhường nếu không còn hoạt động mới
          Không gửi bất cứ tin gì
10:35:00  Khách gửi câu hỏi mới
          Lúc này mới được xét một lượt tự động mới
```

Một khi bạn tiếp quản, khách nhắn tiếp **không** được làm bot giành lại hội thoại.

### 4.2 Khách nhắn, không ai xử lý

Hệ thống chờ hết khoảng ưu tiên người thật, kiểm tra hội thoại vẫn thuộc AUTO, rồi mới gọi AI. Bot gửi một câu trả lời có ích; không tự tách riêng lời chào, câu mời mua hoặc câu hỏi gợi mở không cần thiết.

Không tạo thêm tin “shop đang xử lý” trong khoảng chờ 8 giây: chính tin đó cũng là bot chen vào.

### 4.3 Bạn tiếp quản lúc AI đang chạy

Hủy request AI qua AbortSignal nếu adapter hỗ trợ. Dù nhà cung cấp vẫn hoàn thành request hoặc trả kết quả muộn, kết quả đó chỉ được ghi là không sử dụng; không được tạo action gửi hợp lệ.

Hủy request không đồng nghĩa chắc chắn nhà cung cấp ngừng tính phí. Mục tiêu bắt buộc là không gửi kết quả cũ.

### 4.4 Bạn tiếp quản lúc bot đang gõ

Dừng gõ và hủy các phần chưa gửi. Chỉ xóa nội dung composer khi chứng minh đó vẫn là draft do action bot hiện tại sở hữu. Nếu người thật đã sửa composer, không dùng Select All/Backspace để xóa toàn bộ.

### 4.5 Bạn tiếp quản lúc bot đã bắt đầu thao tác gửi

Không giả vờ “chưa gửi”. Đợi xác minh kết quả action đó, chặn tất cả phần còn lại. Không retry tự động và không tự gửi tin xin lỗi để giải thích cuộc đua.

Trong dashboard, phân biệt:
- Quyền trả lời đã được chuyển cho bạn.
- Sender đã dừng xong hay vẫn đang xác minh một tin có thể đã gửi.

### 4.6 Bạn bấm giao lại cho bot

Mặc định là **giao lại cho các tin mới**, không phục hồi draft/job cũ. Nếu còn câu hỏi đang chờ, hiển thị riêng “Tạo nháp cho tin đang chờ” để bạn chủ động kiểm tra; không tự coi việc bật bot là lệnh gửi bù.

---

## 5. Tách quyền trả lời khỏi trạng thái xử lý

Không dùng `THINKING`, `DRAFT_READY`, `WAITING_CUSTOMER` để suy ra ai được quyền nói. Các trạng thái đó chỉ mô tả pipeline.

Bổ sung trạng thái quyền trả lời:

| Trạng thái kỹ thuật | Ý nghĩa giao diện | Cách kết thúc |
|---|---|---|
| `AUTO` | Bot được phép hỗ trợ khi đủ điều kiện | Người thật hoạt động, có cảnh báo hoặc chủ động tiếp quản |
| `HUMAN_DRAFT` | Bạn đang soạn trả lời | Bạn gửi, chủ động hủy draft hoặc lease nhập liệu hết hạn |
| `HUMAN_SESSION` | Người thật đang hỗ trợ | 30 phút không có tin hội thoại mới, hoặc chủ động giao lại |
| `HUMAN_PINNED` | Bạn giữ quyền hỗ trợ | Chỉ người có quyền chủ động giao lại |
| `REVIEW_HOLD` | Tạm dừng để kiểm tra quyền gửi | Đối soát có kết quả hoặc người có quyền xác nhận |

`HUMAN_SESSION` là trạng thái tự nhường sau khi phát hiện gửi thủ công. `HUMAN_PINNED` là tiếp quản chủ động; tuyệt đối không cho timer tự gỡ.

`REVIEW_HOLD` không được tự giải phóng chỉ vì hết một timer ngắn. Phải có kết quả phân loại hoặc lựa chọn người vận hành.

### Dữ liệu đề xuất

Có thể thêm các cột vào `conversations` để giảm số bảng mới:

| Trường | Mục đích |
|---|---|
| `reply_control_mode` | Một trong năm trạng thái trên |
| `control_epoch` | Số phiên quyền gửi tăng đơn điệu |
| `control_reason` | Lý do chuyển quyền |
| `control_changed_at` | Thời điểm chuyển quyền |
| `controlled_by_user_id` | Người tiếp quản qua dashboard, null khi không biết chính xác |
| `last_human_outbound_at` | Mốc tin người thật quan sát được gần nhất |
| `last_human_outbound_ref` | Tham chiếu sự kiện/tin tương ứng |
| `human_session_last_activity_at` | Tin khách/người thật mới trong phiên đang nhường |
| `human_hold_until` | Mốc hết hạn nhường tự động |
| `draft_lease_id` / `draft_lease_expires_at` | Khóa nhập liệu có thời hạn và chủ sở hữu xác thực |
| `suppressed_through_inbound_version` | Không tạo trả lời tự động cho các inbound đến mốc này |
| `last_observed_at` | Lần đọc hội thoại thành công gần nhất |
| `observation_checkpoint` | Mốc quan sát và provenance cần cho đối soát |

Dùng kiểu số phù hợp cho epoch/version và serialize an toàn qua JSON; không đưa `BigInt` trực tiếp vào JSON.

`manualMode` hiện có chỉ là lớp tương thích trong quá trình chuyển đổi. Mọi nơi ghi quyền trả lời phải đi qua **một service duy nhất**; không duy trì hai nguồn chân lý độc lập. Mục tiêu cuối là suy ra `manualMode` từ chế độ quyền người thật.

Các hold của hội thoại không thay thế cờ an toàn của kênh. Hết human hold vẫn không được gửi nếu kênh đang bị Facebook hạn chế, chưa đăng nhập hoặc có kết quả gửi chưa xác định.

### Quy tắc version

`inboundVersion` vẫn chỉ đếm tin khách. Không dùng tin người thật để giả tăng số tin khách, và không dùng số cực lớn như `9999999` để hủy.

`controlEpoch` thay đổi khi quyền gửi thay đổi hoặc khi sự kiện người thật mới làm mất hiệu lực các công việc đã chuẩn bị. Mỗi AI run/action chụp cả `inboundVersion` và `controlEpoch`.

Heartbeat gia hạn draft không cần tăng epoch liên tục nếu không có thay đổi quyền; tránh tự gây vô hiệu hóa quá nhiều tác vụ.

---

## 6. Phát hiện người thật gửi: phải làm ở tầng adapter

### 6.1 Đọc cả hai chiều

Thay tư duy “observer chỉ phát inbound” bằng “observer phát các sự kiện tin nhắn đã quan sát”, rồi phân loại:

```text
INBOUND_CUSTOMER
OUTBOUND_BOT_CONFIRMED
OUTBOUND_MANUAL_DASHBOARD
OUTBOUND_EXTERNAL
OUTBOUND_UNATTRIBUTED
SYSTEM_EVENT
```

Không nhất thiết thay toàn bộ interface trong một lần. Có thể bổ sung callback `onObservedOutbound` trong channel adapter và giữ `observeInbound` để tương thích.

Browser entrypoint nối callback mới vào `ConversationControlService`, không chỉ ghi console log.

### 6.2 Không được coi mọi outgoing là người thật

Nếu thấy bất cứ tin đi nào cũng pause thì bot sẽ tự pause ngay sau khi nó trả lời.

Cần đối soát với sổ action gửi đã lưu trong DB:

| Bằng chứng | Phân loại/biện pháp |
|---|---|
| Stable external message ref khớp action AI đã xác nhận | Bot echo; không kích hoạt human hold |
| Stable ref khớp action `MANUAL_OWNER` | Người thật gửi qua dashboard; cập nhật một lần, không tạo bản sao |
| Outgoing mới có bằng chứng đến từ ngoài sender | External outbound; nhường hội thoại, không khẳng định tên người gửi nếu không biết |
| Outgoing xuất hiện lúc có action đang SEND_INTENT/chưa rõ | `REVIEW_HOLD`; đối soát trước, không đoán human hoặc bot |
| Chỉ có snippet “Bạn: …”, chưa có danh tính tin | Dấu hiệu cần nhường tạm để kiểm tra, không coi là bản ghi tin đầy đủ |
| Outgoing cũ xuất hiện lại sau virtual scroll/restart | So checkpoint/ledger; không coi là hoạt động mới |

Tin gửi ngoài hệ thống có thể là bạn, nhân viên khác hoặc automation khác cùng tài khoản. Về sản phẩm, chọn nhường trước để tránh hai hệ thống cùng nói; về log, ghi đúng “Tin gửi ngoài hệ thống”, không dựng thông tin người thao tác.

### 6.3 Danh tính tin nhắn và ledger

Tận dụng `outbound_actions` làm ledger, với scope account + conversation. Ghi send intent trước thao tác gửi và external message ref sau khi xác minh.

Nếu DOM không có ref ổn định, lưu provenance/fingerprint tổng hợp theo hội thoại, thứ tự xuất hiện, mốc quan sát và bằng chứng của action. Fingerprint chỉ là bằng chứng hỗ trợ, không tương đương ID từ Facebook.

**Không dùng chỉ `textHash` để quyết định nguồn gửi.** Bot và người thật có thể cùng gửi “Dạ vâng”, hoặc khách/người thật lặp lại cùng một câu.

Nếu bằng chứng còn mơ hồ, giữ quyền gửi thay vì gắn nhãn chắc chắn. Ledger cần sống lâu hơn khoảng phục hồi/replay mà hệ thống hỗ trợ; retention không được xóa bằng chứng của action còn chưa rõ.

### 6.4 Ghi nhận bền vững trước khi đánh dấu đã xử lý

Một sự kiện quan sát chỉ được đánh dấu hoàn tất sau khi DB transaction thành công. Callback lỗi thì không được làm mất cơ hội ingest lại.

Dedupe áp dụng riêng theo account + conversation + source identity. Hai tin có cùng nội dung không mặc nhiên là một tin.

Khi đọc một snapshot có cả inbound và outbound mới, cần phân tích toàn bộ snapshot trước khi quyết định enqueue AI. Nếu có outgoing ngoài hệ thống, áp hold trước hoặc cùng giao dịch với ingest; tránh enqueue AI trước rồi mới phát hiện người thật ở cuối vòng lặp.

### 6.5 Không làm observer bị mù trong lúc bot gửi

Tách:
- Đọc DOM hiện tại, nhận sự kiện thay đổi, kiểm tra outgoing mới.
- Điều hướng, focus composer, gõ và gửi.

Chỉ nhóm thứ hai giữ khóa điều khiển browser. Đọc không được click, chuyển hội thoại hoặc dismiss dialog tùy tiện.

Dùng một vòng polling, không tự nhân đôi timer; có thể bổ sung MutationObserver được giới hạn phạm vi và gộp sự kiện DOM. Đây là tối ưu đọc trang đã tải, không phải tăng tần suất gọi Facebook.

Không dùng `event.isTrusted` làm bằng chứng duy nhất phân biệt bot/người thật trong browser được điều khiển: phải dựa thêm vào action đang sở hữu composer và hoạt động dashboard đã xác thực.

### 6.6 Kiểm tra ngay trước gửi

Trước khi bắt đầu nhập draft và ngay trước thao tác gửi:
1. Xác minh đúng hội thoại bằng định danh chính xác.
2. Đọc phần tin gần nhất của hội thoại hiện tại.
3. Đối soát các outgoing mới với ledger.
4. Áp dụng human/review hold khi cần.
5. Kiểm tra lại quyền trong DB bằng version/epoch.
6. Chỉ gửi nếu mọi điều kiện vẫn hợp lệ.

Có thể đặt `preSendObservationMaxAgeMs = 1500` làm điểm xuất phát. Mốc này là tuổi của lần đọc DOM thành công, **không bảo đảm tin từ điện thoại đã đồng bộ tới DOM trong 1,5 giây**.

---

## 7. Chuyển quyền và hủy tác vụ phải cùng một giao dịch

Service mới đề xuất: `ConversationControlService`.

### 7.1 Luồng khi phát hiện một tin người thật mới

```text
BEGIN
  Khóa row hội thoại trong đúng channelAccountId.
  Kiểm tra dedupe sự kiện quan sát.
  Ghi outgoing vào timeline nếu chưa có.
  Tăng controlEpoch.
  Chuyển sang HUMAN_SESSION, trừ khi đã HUMAN_PINNED.
  Cập nhật mốc human activity và humanHoldUntil.
  Nâng suppressedThroughInboundVersion đến version hiện tại.
  Hủy các AI jobs/drafts/actions còn ở giai đoạn có thể hủy an toàn.
  Ghi event chuyển quyền và transactional outbox.
COMMIT

Gửi tín hiệu hủy để đánh thức các worker.
Worker đọc lại DB, dừng việc đang làm và xác nhận trạng thái thực tế.
```

`LISTEN/NOTIFY` chỉ là tín hiệu đánh thức. Quyền gửi trong DB mới là nguồn chân lý. Nếu thông báo bị mất hoặc worker restart, một action cũ vẫn phải bị chặn.

Không mở DB transaction trong suốt thời gian gọi AI, gõ hay chờ Facebook. Giao dịch khóa phải ngắn.

### 7.2 Chỉ hủy AI, không hủy nhầm người thật

Các truy vấn hủy theo version/tiếp quản phải có điều kiện `actor = AI`, trừ thao tác hủy thủ công rõ ràng của người vận hành.

Tin nhắn mới của khách không nên tự hủy một tin do nhân viên chủ động gửi chỉ vì `inboundVersion` thay đổi. Có thể cảnh báo “Khách vừa gửi thêm tin” trong composer, nhưng không đánh đồng manual intent với AI draft đã lỗi thời.

Các gate an toàn của kênh, định danh hội thoại và kết quả gửi chưa rõ vẫn áp dụng cho manual sender.

### 7.3 Ma trận hủy

| Giai đoạn | Khi người thật tiếp quản |
|---|---|
| Chưa chạy AI / chờ grace | Hủy việc tự động, không gọi model |
| AI đang tạo | Abort nếu có thể; bỏ kết quả muộn |
| AI xong, chưa enqueue sender | Kiểm tra epoch thất bại, không enqueue |
| Action PENDING | CANCELLED với lý do human takeover |
| Action TYPING | Dừng gõ; xác nhận composer còn thuộc bot trước khi xóa |
| SEND_INTENT / SENDING | Không bulk-cancel hoặc reset; sender xác định đã submit chưa và đối soát |
| SEND_UNCERTAIN / UNCONFIRMED | Giữ nguyên bằng chứng, không gửi lại; chặn phần còn lại |
| CONFIRMED / SENT | Giữ nguyên; ghi rằng tin đã gửi trước lúc dừng hoàn tất |

Chỉ cho phép “hủy trước submit” từ SEND_INTENT nếu có bằng chứng thực sự từ worker rằng thao tác gửi chưa được thực hiện; nếu không thì đi theo luồng đối soát.

### 7.4 Năm cổng kiểm tra bắt buộc

1. Trước lập lịch/cập nhật lịch AI.
2. Ngay trước gọi model.
3. Sau khi model trả về, trước lưu một draft có quyền gửi/enqueue action.
4. Trước nhập draft vào Messenger.
5. Ngay trước thao tác gửi, kết hợp fresh observation và CAS quyền gửi.

Kiểm tra không chỉ `manualMode` mà cả `controlMode`, `controlEpoch`, `inboundVersion`, phiên hold, suppressed watermark và trạng thái an toàn kênh.

Cổng số 3 phải transactionally gắn việc kiểm tra hiện tại với tạo outbound intent. Cổng số 5 phải có send permit gắn action + control epoch; không chỉ đọc DB rồi dùng một boolean cũ.

### 7.5 Giới hạn giữa DB và Facebook

DB không thể giao dịch nguyên tử cùng nút Enter trên Messenger.

Cần xác định rõ:
- Người thật thắng quyền trước khi cấp/commit send permit: bot không được submit.
- Bot đã submit hoặc action đã bước vào vùng không chắc: việc tiếp quản chặn các tin tiếp theo, chờ xác minh tin đang bay.
- Native Messenger trên thiết bị khác có thể gửi sau lần đọc cuối nhưng trước lúc bot submit. Không trình bày đây là trường hợp đã được bảo đảm loại trừ.

Giữ khoảng giữa kiểm tra cuối và submit nhỏ, dùng mutex phía browser cho thao tác ghi, nhưng không quảng cáo “exactly once” trên kênh browser chỉ nhờ mutex.

---

## 8. Sửa riêng action identity và manual-send

### 8.1 Action ID mới

Không tái sử dụng khóa `account:conversation:inboundVersion:responseIndex` cho cả người và AI.

Đề xuất:

```text
AI:
  hash("ai:v2", accountId, conversationId, turnId, responseIndex)

MANUAL:
  hash("manual:v2", accountId, conversationId, operatorId, clientRequestId)
```

`clientRequestId` là UUID của **ý định gửi**, được giữ nguyên khi HTTP retry và đổi khi người dùng chủ động gửi một tin mới. Server ràng buộc operatorId từ phiên đăng nhập, không tin trường người dùng tự truyền.

Hai lần gửi cùng nội dung là hai intent khác nhau khi có hai request ID khác nhau. Một HTTP retry cùng request ID chỉ tạo một action.

Nếu cùng idempotency key nhưng khác body/actor/conversation thì trả lỗi xung đột, không sửa action cũ.

### 8.2 Immutable intent

`createAction` với khóa đã tồn tại trả về bản ghi cũ sau khi xác minh intent, không reset status hay thay body. Retry gửi chưa rõ bắt buộc qua luồng duyệt riêng.

Giữ nguyên action ID legacy trong DB. Không rewrite các ref đã được queue hoặc đã dùng làm bằng chứng.

### 8.3 Manual-send tự bảo vệ ở server

`POST /manual-send` phải:
- Xác thực vai trò và scope hội thoại.
- Giành quyền người thật, tăng epoch khi cần và hủy AI an toàn trong transaction.
- Tạo manual intent/action độc lập bằng request ID.
- Đợi sender cũ quiescent hoặc action đang bay được đối soát trước khi bắt đầu ghi lên cùng browser.
- Không trả “đã gửi” khi mới xếp hàng; trả trạng thái queued/awaiting-stop phù hợp.

Không cần người dùng tự thực hiện hai request đúng thứ tự “takeover rồi send” mới được an toàn.

### 8.4 Acknowledgement thật

Thay `cancelAck: true` vô điều kiện bằng hai trạng thái:

```json
{
  "controlApplied": true,
  "stopRequestId": "uuid",
  "controlEpoch": "42",
  "senderState": "STOPPING"
}
```

SSE/poll chi tiết cập nhật một trong:
- `STOPPED`: không còn thao tác AI có thể submit.
- `VERIFYING_IN_FLIGHT`: đang xác minh tin đã bắt đầu gửi.
- `NEEDS_REVIEW`: chưa rõ kết quả.
- `STOP_TIMEOUT`: chưa nhận xác nhận dừng; không giả ACK.

Nếu kiểm tra bền vững chứng minh không có action/worker còn quyền gửi thì có thể trả STOPPED ngay. Nếu không, request được chấp nhận không đồng nghĩa việc dừng hoàn tất.

---

## 9. Khoảng chờ: không cộng dồn vô ích và không chiếm worker

### 9.1 Lịch xử lý đề xuất

Dùng timestamp trong hàng đợi, không giữ một worker `sleep(8000)`.

```text
quietDeadline = min(
    lastInboundAt + debounceMs,
    burstStartedAt + maxAggregateWaitMs
)

replyNotBefore = max(
    burstStartedAt + ownerFirstGraceMs,
    quietDeadline
)
```

Mặc định đề xuất:
- `ownerFirstGraceMs = 8000`
- `debounceMs = 2000`
- `maxAggregateWaitMs = 12000`

Tin đơn thường đủ điều kiện sau 8 giây từ lúc hệ thống ghi nhận. Không cộng thêm 8 + 2 + debounce cũ rồi mới AI.

Mốc khởi đầu đo từ lúc hệ thống ingest tin có đủ bằng chứng, không tự coi đó là đúng thời điểm khách bấm gửi.

### 9.2 Khi khách nhắn dồn

Cụm hiện tại có giới hạn gom. Nếu tiếp tục có tin trong lúc model chạy, hủy/bỏ draft lỗi thời và gom lại các tin chưa xử lý; không lập một lời gọi AI cho từng message.

Nếu liên tục bị supersede, giới hạn số lần tái sinh và chuyển cảnh báo cho người vận hành. Không gửi trả lời cũ chỉ để đạt SLA, cũng không làm vòng lặp gọi model không giới hạn.

Có thể bắt đầu với tối đa 2 lần tái sinh do tin mới trong một cửa sổ 60 giây, rồi tạm nhường người kiểm tra. Đây là giới hạn vận hành đề xuất, cần điều chỉnh theo tải.

### 9.3 Người thật đang sẵn sàng và chế độ vắng mặt

Không suy ra người thật sẵn sàng chỉ vì dashboard đang mở.

Có thể bổ sung lựa chọn rõ ràng:
- **Ưu tiên tôi:** grace 15 giây; hợp với lúc bạn đang trực.
- **Tự động hỗ trợ:** grace 8 giây mặc định.
- **Chỉ tạo nháp:** bot không tự gửi.

Mọi chế độ đều phải tôn trọng human hold và quyền tiếp quản. Đổi chế độ vắng mặt không được xóa một hội thoại đang do bạn hỗ trợ.

AI chưa được gọi trong khoảng grace, trừ chức năng tạo nháp mà người vận hành chủ động yêu cầu. Điều này tránh dùng token cho câu hỏi bạn sắp trả lời.

---

## 10. Hết thời gian nhường: không được gửi bù

### 10.1 Gia hạn đúng hoạt động

Trong HUMAN_SESSION, chỉ các sự kiện mới được dedupe thành công sau đây gia hạn:
- Tin người thật gửi.
- Tin khách mới trong hội thoại đó.
- Hoạt động nhập liệu có xác thực, khi thiết kế muốn giữ phiên người thật đang soạn.

Không gia hạn bằng:
- SSE heartbeat.
- Polling đọc lại cùng tin.
- Mở trang workflow.
- Tin bot echo.
- Trạng thái seen/delivered.
- Sự kiện DOM cũ xuất hiện lại.

Chọn gia hạn bởi cả tin khách vì tình huống cần tránh là bạn đã trả lời rồi khách tiếp tục hỏi; không nên đến phút 30 bot tự nhảy vào giữa cuộc nói chuyện.

Đổi lại, khách nhắn nhiều trong lúc bạn bận có thể giữ bot im lâu. Giải pháp là cảnh báo nội bộ có tin đang chờ, không lặng lẽ giành lại quyền gửi.

### 10.2 Watermark tách khỏi “đã giải quyết”

Mọi inbound trong HUMAN_SESSION/HUMAN_PINNED vẫn được lưu để xem và làm context sau này, nhưng được đánh dấu **không tự phản hồi trong phiên này**.

`suppressedThroughInboundVersion` chỉ chặn tạo automatic intent. Không đồng nghĩa khách đã được trả lời hay đã giải quyết xong. Dashboard vẫn phải cho thấy tin đang chờ người xử lý.

### 10.3 Cuộc đua giữa hết hạn và tin mới

Khi inbound mới tới, trong cùng row lock:
1. Xét phiên hold cũ có hết hạn hay chưa **trước khi** cập nhật hoạt động từ inbound mới.
2. Nếu đã hết hạn, chốt watermark đến version cũ, tăng epoch và chuyển AUTO.
3. Sau đó thêm inbound mới, tạo version mới và xét quyền cho chính tin mới.
4. Nếu chưa hết hạn, lưu inbound trong phiên người thật, nâng watermark và gia hạn.

Timer nền cũng dùng CAS/row lock với epoch và deadline hiện hành. Timer cũ không được gỡ hold vừa được gia hạn.

### 10.4 Tiếp quản chưa gửi gì là một trường hợp khác

HUMAN_DRAFT hết lease do người dùng ngừng nhập nhưng chưa gửi không giống kết thúc HUMAN_SESSION.

Nếu không có tin người thật thực sự, không có pinned hold và quan sát vẫn hợp lệ, có thể tạo **lượt mới** cho câu hỏi còn chờ sau grace. Không phục hồi trực tiếp draft/action trước epoch vừa hết hạn.

Cách này tránh mất câu hỏi chỉ vì bạn gõ thử rồi bỏ dở. Giao diện cần thể hiện rõ draft lease đang tạm giữ bot.

---

## 11. Giảm số lần bot trả lời

### 11.1 Một tin mặc định

Đặt `aiMaxResponseCount = 1` cho rollout tính năng. Tổng ký tự có thể giữ 480 ban đầu để tránh phá khả năng trả lời đủ ý.

Trong persona:
- Khi maxResponseCount là 1, không còn chỉ dẫn tách “tin nhắn 2”.
- Không tự thêm câu chào hoặc câu gợi mở sau khi đã trả lời đủ.
- Chỉ hỏi làm rõ khi thông tin đó thật sự cần để giải quyết yêu cầu.
- Không quyết định quyền tiếp quản dựa vào prompt; quyền gửi đã được gate trước khi model chạy.

Guard, settings, persona và sender phải dùng cùng cấu hình. Không để prompt yêu cầu 2 tin rồi guard từ chối, làm gọi AI lại.

### 11.2 Không tự follow-up

Không có inbound mới hoặc thao tác yêu cầu rõ ràng của nhân viên thì không được tạo thêm automatic turn.

Một lượt trả lời là phản hồi cho một cụm inbound, không phải mỗi tin một câu. Human hold luôn thắng mọi tính năng welcome/default reply/follow-up/FAQ có thể bổ sung sau này.

### 11.3 Hỗ trợ kết thúc tự nhiên

Thiết kế output tương lai có thể phân biệt:

```text
REPLY        -> có câu trả lời hữu ích
NO_REPLY     -> lượt chỉ là acknowledgement/kết thúc, không cần thêm lời
HANDOFF      -> cần nhân viên, không tự gửi lời hứa chưa có người nhận
```

Trạng thái NO_REPLY là kết quả nghiệp vụ hợp lệ, không phải lỗi guard cần retry. Không áp dụng regex “cảm ơn/ok” để bỏ mọi tin: “ok, nhưng đổi size giúp mình” vẫn chứa yêu cầu.

Tính năng này làm sau khi cơ chế quyền trả lời ổn định; nó không thay thế human takeover.

### 11.4 Lịch sử phải có cả câu trả lời của người thật

Ghi tin người thật đã quan sát vào timeline để bot lần sau không hỏi lại thông tin đã chốt. Giữ provenance và actor ở DB; nội dung người thật vẫn là lịch sử hội thoại, không được nâng lên thành system instruction.

---

## 12. Cấu hình kỹ thuật đề xuất

**Đây là cấu hình mục tiêu sau khi bổ sung schema/code. Nhóm `humanPriority` chưa có trong settings của snapshot đã kiểm tra. Không dán nguyên mẫu vào production và kỳ vọng đã hoạt động.**

```json
{
  "debounceMs": 2000,
  "aiMaxResponseCount": 1,
  "aiTotalMaxChars": 480,
  "humanPriority": {
    "enabled": true,
    "mode": "HUMAN_FIRST",
    "ownerFirstGraceMs": 8000,
    "maxAggregateWaitMs": 12000,
    "autoDetectExternalOutbound": true,
    "humanSessionIdleMs": 1800000,
    "extendSessionOnCustomerMessage": true,
    "resumePolicy": "NEW_INBOUND_ONLY",
    "explicitTakeoverRequiresRelease": true,
    "draftLeaseTtlMs": 60000,
    "draftHeartbeatMs": 10000,
    "preSendObservationMaxAgeMs": 1500,
    "unknownOutboundPolicy": "HOLD_AND_RECONCILE",
    "followUpWithoutNewInbound": false,
    "maxRegenerationsPerMinute": 2
  }
}
```

Validation cần kiểm tra:
- Các trường thời gian có min/max và quan hệ giữa heartbeat/TTL.
- Không cho grace/maxAggregateWait âm hoặc không hữu hạn.
- Partial update không reset các cài đặt không liên quan.
- Không cho các switch mới vượt channel safety gate.
- Cấu hình nguy hiểm không được tự mặc định thành “cho gửi”.
- API trả danh sách capability: tính năng nào đã được code thực thi, tránh nút UI không có tác dụng.

`aiMaxOutputTokens` hiện đã có trong settings nhưng không phải giải pháp cho quyền chen lời. Việc nối cap token tới từng provider nên được kiểm tra trong luồng tối ưu AI riêng; không dùng nó thay cho giới hạn số outbound message.

---

## 13. API và quyền truy cập

| API/chức năng | Hành vi mục tiêu |
|---|---|
| `POST /api/inbox/:id/takeover` | Giành quyền và trả trạng thái dừng thật, không ACK giả |
| `POST /api/inbox/:id/release` | Giao lại theo NEW_INBOUND_ONLY, không xóa safety hold |
| `POST /api/inbox/:id/manual-send` | Tự giành quyền, idempotent theo manual request ID |
| `POST /api/inbox/:id/operator-activity` — mới | Chỉ hoạt động soạn thảo có xác thực, có rate limit |
| `GET /api/inbox/:id/control` — mới hoặc gộp detail | Trả mode, lý do, deadline, epoch và tình trạng sender |
| `POST /api/inbox/:id/draft-pending-reply` — tùy chọn | Chủ động tạo nháp cho tin đang chờ, không tự gửi |

Mỗi route kiểm tra `channelAccountId` + `conversationId` và vai trò. Không chỉ tra hội thoại bằng UUID rồi dùng channel mặc định để ghi dữ liệu.

Không nhận `actor = HUMAN` trực tiếp từ API công khai hoặc từ text khách. External observations chỉ đi từ browser-agent nội bộ đã xác thực/DB service account phù hợp.

Mọi thay đổi manual/hold ở admin, đóng incident, session recovered và GET overview cần rà lại: không đường nào được tự bỏ quyền người thật vì “hệ thống đã khỏe”.

Stop request và control epoch phải có scope khách cụ thể; một khách được bạn trả lời không làm dừng các khách khác.

---

## 14. Hiển thị trong hộp thư và workflow

Không cần tạo một canvas graph nặng mới. Thêm nhánh quyền trả lời vào màn hình theo từng hội thoại/lượt đã thiết kế.

### Trạng thái dễ hiểu

| Tình huống | Nhãn chính |
|---|---|
| Đang trong grace | “Đang chờ bạn trả lời trước” |
| Dashboard đang nhập | “Bạn đang soạn tin — bot tạm dừng” |
| Phát hiện external outbound | “Đã thấy tin gửi ngoài hệ thống — bot đang nhường” |
| Biết rõ operator | “Bạn đang hỗ trợ khách này” |
| Đã hủy AI đang chờ | “Đã hủy câu trả lời tự động để tránh gửi chen” |
| Hết hold | “Bot sẵn sàng cho tin nhắn mới” |
| Có tin chưa rõ đã gửi | “Đang kiểm tra một tin có thể đã gửi” |
| Unknown outgoing | “Chưa xác định được nguồn tin đi — tạm dừng để kiểm tra” |

Không hiển thị AI cancellation do human takeover như lỗi dịch vụ AI. Đây là hành vi đúng.

### Điều khiển

“Tôi đang hỗ trợ” giữ quyền đến khi giao lại. “Giao lại cho bot” ghi chú rằng chỉ áp dụng tin mới. “Tạm nhường 30 phút” cho phép chỉnh khoảng giữ. “Tạo nháp cho tin đang chờ” là hành động riêng.

Không làm nút “dừng cập nhật giao diện” trông giống nút dừng bot.

### Event và trace

Gắn chung `channelAccountId`, `conversationId`, `turnId`, `controlEpoch`, `inboundVersion`, `actionId` khi có.

Ví dụ event mới:
- `HUMAN_OUTBOUND_OBSERVED`
- `HUMAN_CONTROL_ACQUIRED`
- `HUMAN_CONTROL_EXTENDED`
- `AI_SUPPRESSED_BY_HUMAN`
- `AI_RESULT_DISCARDED_CONTROL_CHANGED`
- `SENDER_STOP_REQUESTED`
- `SENDER_QUIESCED`
- `HUMAN_CONTROL_EXPIRED`
- `BOT_READY_FOR_NEW_INBOUND`
- `OUTBOUND_ATTRIBUTION_UNCERTAIN`

Chỉ log sự thay đổi có ý nghĩa; không ghi một event cho mỗi heartbeat 10 giây. Không lặp toàn bộ nội dung chat trong từng event. UI đọc timeline có quyền thay vì sao chép PII vào log kỹ thuật.

---

## 15. Phân chia triển khai theo PR

### PR 0 — Giảm ảnh hưởng trong lúc chưa có bản vá

Đổi số tin tối đa xuống 1. Sửa chỉ dẫn tách tin thứ hai cho nhất quán nếu cần. Hạn chế rollout bot vào các hội thoại đang bạn trực tiếp xử lý; chủ động tiếp quản trước cuộc chat quan trọng.

Có thể tăng debounce hiện có lên khoảng 8 giây như biện pháp tạm, nhưng **không coi đó là tính năng tự nhường**. ACK và external-outbound hiện tại vẫn có hạn chế.

Nút tắt tự động hiện có không thu hồi được tin đã bấm gửi. Kiểm tra hàng chờ trước khi bắt đầu cuộc trò chuyện nhạy cảm.

### PR 1 — Sửa nền tảng action/manual-send

Sửa khóa action AI/manual, immutable intent và idempotency. Tách việc hủy AI khỏi manual. Giữ các trạng thái gửi chưa rõ. Không dùng version giả để hủy.

Điều kiện hoàn thành: hai manual sends khi không có inbound mới vẫn là hai intent; HTTP retry không gửi thêm; manual action không biến thành AI action và ngược lại.

### PR 2 — Service quyền trả lời và các gate

Thêm schema control mode/epoch/watermark. Implement `ConversationControlService`. Manual-send tự acquire. Takeover có ACK thật. Gắn epoch vào jobs/runs/actions và kiểm tra tại năm cổng.

Điều kiện hoàn thành: quyền người thật được DB ghi nhận trước send permit thì bot không thể submit; kết quả AI muộn không resurrect job/action.

### PR 3 — Phát hiện chat người thật trên Messenger

Bổ sung quan sát outgoing, ledger attribution, REVIEW_HOLD, xử lý toàn snapshot và startup recovery. Không để sendLock chặn toàn bộ đọc. Kiểm tra fresh observation trước gửi.

Điều kiện hoàn thành: chat trực tiếp trên Messenger tạo human hold đúng hội thoại; bot echo không tự gây hold; sự kiện mơ hồ không được cho gửi.

### PR 4 — Grace, lease và resume không replay

Implement due time trong hàng đợi, rolling hold, draft lease, pinned mode, watermark và cảnh báo tin chờ.

Điều kiện hoàn thành: hết 30 phút không tạo request AI/action; tin mới sau expiry được xét đúng; timer cũ không gỡ phiên vừa gia hạn.

### PR 5 — UI/workflow và canary

Thêm control banner, lý do nhường, tình trạng ACK, filter người thật đang hỗ trợ và nút tạo nháp cho tin chờ.

Điều kiện hoàn thành: UI không báo “bot đã dừng” khi còn action đang xác minh; đồ thị/nhật ký chỉ dùng dữ liệu của đúng khách và lượt.

Không bật “tự nhường khi chat trực tiếp” ngoài canary nếu chưa hoàn thành PR 1–4. Chỉ sửa giao diện hoặc thêm timestamp hold không đủ an toàn.

---

## 16. Các file cần chỉnh

| File/nhóm | Thay đổi |
|---|---|
| `apps/browser-agent/src/messenger-adapter.ts` | Đọc outgoing, không bỏ qua mọi self-send, observation/read-write coordination, pre-send inspection |
| `apps/browser-agent/src/index.ts` | Nối sự kiện external outbound vào service quyền trả lời |
| `apps/browser-agent/src/sender-worker.ts` | Control epoch, stop ACK thật, no-send khi mất quyền, đối soát in-flight |
| `apps/core/src/routes/inbox.ts` | Takeover/release/manual-send và kiểm tra scope/idempotency |
| `apps/core/src/jobs/handlers/ai.ts` | Abort propagation, tái kiểm tra sau AI, enqueue cùng transaction kiểm quyền |
| `apps/core/src/jobs/handlers/debounce.ts` | Lịch grace/gom tin có deadline, không worker sleep |
| `apps/core/src/jobs/handlers/reconcile.ts` | Không phục hồi công việc đã bị human takeover vô hiệu hóa |
| `packages/db/src/repository/outbound-repo.ts` | Action ID v2, immutable intent, chỉ hủy trạng thái phù hợp |
| `packages/db/src/repository/conversation-repo.ts` | Ingest/human session watermark và tách hủy manual/AI |
| `packages/db/src/service/reply-policy-service.ts` | Gate quyền người thật áp dụng cho mọi đường AI |
| `packages/db/src/service/conversation-control-service.ts` — mới | Nguồn duy nhất cho acquire/extend/release/expire |
| `packages/db/src/schema/index.ts` + migration mới | Control state, epoch, idempotency/dedupe index cần thiết |
| `packages/contracts/src/settings.ts`, `enums.ts`, contracts jobs/outbound | Cấu hình, lý do trạng thái và epoch |
| `packages/channel` interface | Capability/callback outgoing và pre-send observation |
| `packages/ai/src/client.ts`, `generator.ts` | AbortSignal thực sự đi đến request; bỏ kết quả stale |
| `packages/ai/src/persona.ts`, `guards.ts` | Một tin mặc định, không ép tin thứ hai, NO_REPLY nếu triển khai |
| `apps/dashboard/src/pages/ConversationDetailPage.tsx` | Composer lease/control banner/manual send intent ID |
| `apps/dashboard/src/pages/WorkflowPage.tsx` và model liên quan | Nhánh human control, ACK và expiry không gửi bù |
| Admin/session-recovery/retention | Không xóa control hold hoặc ledger đang cần để đối soát |

Không thay toàn bộ scheduler hoặc chuyển công nghệ queue cho phạm vi này.

---

## 17. Kiểm thử bắt buộc

Dùng unit test, fake clock, DB integration và fake channel adapter trước khi thử với tài khoản test có sự đồng ý. Không gửi hàng loạt cho khách thật để đo.

| Mã | Kịch bản | Kết quả bắt buộc |
|---|---|---|
| T01 | Khách nhắn, người thật gửi trong grace | 0 lời gọi AI nếu phát hiện kịp trước khi gọi; 0 submit bot |
| T02 | Người thật gửi trong lúc AI chạy | Request bị hủy nếu hỗ trợ; kết quả muộn không tạo action hợp lệ |
| T03 | Người thật gửi sau AI xong nhưng trước enqueue | Gate giao dịch chặn action |
| T04 | Người thật gửi khi action PENDING | Action AI bị hủy, manual không bị hủy |
| T05 | Người thật tiếp quản khi bot đang gõ | Ngừng draft thuộc bot, không submit |
| T06 | Người thật sửa composer trước lúc bot clear | Không xóa nội dung người thật |
| T07 | Action đã submit trước lúc tiếp quản | Chỉ đối soát; không gửi các phần còn lại |
| T08 | Ba phần AI cũ đang chờ, phần một đã gửi | Tiếp quản hủy phần hai/ba; phần một giữ bằng chứng |
| T09 | Khách tiếp tục chat trong human hold | Không gọi model, gia hạn hold, giữ timeline |
| T10 | Người thật chat tiếp | Gia hạn hold, không tạo duplicate outgoing |
| T11 | Human hold hết hạn | 0 lời gọi AI và 0 tin gửi do timer |
| T12 | Inbound mới đúng lúc hết hạn | Row lock/CAS quyết định nhất quán, không nuốt tin mới vào watermark cũ |
| T13 | Timer cũ chạy sau khi hold gia hạn | Không giải phóng hold mới |
| T14 | Explicit pinned takeover | Không hết hạn tự động |
| T15 | Restart core/browser trong hold | Hold/epoch vẫn tồn tại, không phát lại draft |
| T16 | Mất thông báo hủy qua NOTIFY | Sender vẫn bị gate DB chặn trước submit |
| T17 | Observer cũ/recovered nhận lại bot echo | Không tạo human hold giả |
| T18 | Hai outgoing cùng text, một bot một người | Không phân loại chỉ bằng textHash |
| T19 | Tin đi chưa phân loại lúc SEND_INTENT | REVIEW_HOLD, không cấp send mới |
| T20 | Callback/DB ingest lỗi rồi nhận lại event | Retry được, không bỏ mất human event |
| T21 | Snapshot có cả khách nhắn và chủ shop trả lời | Áp quyền trước quyết định enqueue AI |
| T22 | Khách A được tiếp quản, khách B đang AUTO | A im lặng, B vẫn xử lý đúng |
| T23 | Tắt nhóm/participant chưa xác minh | Không auto-bypass để “phát hiện human” |
| T24 | Hai manual sends cùng inboundVersion | Hai action khác nhau đúng actor |
| T25 | Manual-send retry cùng request ID | Một action, một lần submit tối đa theo bảo vệ sender |
| T26 | Cùng request ID khác body | 409, không ghi đè intent cũ |
| T27 | Manual-send không gọi takeover trước | Server vẫn acquire và chặn AI |
| T28 | Khách nhắn thêm khi manual queued | Không hủy manual như stale AI một cách âm thầm |
| T29 | Gửi lại createAction với SEND_UNCERTAIN | Không reset PENDING |
| T30 | AI sinh hai/ba messages khi cap=1 | Guard/policy không cho fan-out; không vòng retry vô hạn |
| T31 | NO_REPLY acknowledgement khi bật tính năng | Không sender job và không guard error giả |
| T32 | Tin “ok, nhưng đổi size…” | Không bị rule kết thúc hội thoại loại bỏ |
| T33 | Dashboard mở nhưng không gõ | Không takeover/gia hạn human session tự động |
| T34 | Draft lease bỏ dở, chưa gửi human | Lượt mới được xét theo policy, không sống lại action cũ |
| T35 | Đóng incident/session recovered/overview GET | Không tự gỡ pinned/human hold |
| T36 | Ledger/checkpoint mất sau retention | Không đoán bot echo; chặn và yêu cầu đối soát |
| T37 | Observer pause trong lúc typing | Test phải chứng minh đọc cần thiết vẫn hoạt động |
| T38 | Account/scope giả ở control API | 403/404, không đổi quyền hội thoại khác |
| T39 | Khách liên tục gửi làm AI stale | Giới hạn regenerate, không spam AI requests |
| T40 | Người thật thắng CAS trước permit | Không có thao tác browser submit |
| T41 | Native app gửi sau final observation | Ghi nhận giới hạn race; dừng các tin sau, không tuyên bố đã ngăn tuyệt đối |

**Thuộc tính cốt lõi:** mọi lần submit AI cần có bằng chứng action còn được quyền theo epoch hiện hành tại điểm cấp phép, cùng kiểm tra browser cuối. Không được diễn giải thuộc tính DB này thành bảo đảm quan sát tức thì mọi thiết bị ngoài hệ thống.

---

## 18. Triển khai, rollback và tiêu chí nghiệm thu

### Trình tự an toàn

1. Tạm dừng auto-reply trong cửa sổ rollout bằng cơ chế thực sự chặn sender.
2. Xác minh và drain action đang chạy; giữ nguyên SEND_UNCERTAIN để đối soát.
3. Backup DB và apply migration bổ sung.
4. Backfill hội thoại `manualMode=true` thành HUMAN_PINNED; không reset ý định người vận hành.
5. Giữ nguyên action legacy; job thiếu control epoch không được tự chạy theo mặc định dễ dãi.
6. Deploy core và browser-agent tương thích cùng hợp đồng quyền gửi; không để sender cũ bỏ qua epoch mới.
7. Khôi phục checkpoint, đối soát hội thoại đang có việc trước khi mở auto.
8. Chạy shadow detection, rồi canary trên hội thoại test được chọn.
9. Chỉ mở rộng khi đạt các bài race/restart/idempotency và không thấy false resume.

### Chỉ số theo dõi

- Số AI submit sau khi hệ thống đã ghi nhận human control thắng quyền: mục tiêu bằng 0 trong các trường hợp kiểm soát được.
- Số lần bot gửi nhiều hơn cap mỗi lượt.
- Human-detection latency từ lúc DOM có bằng chứng đến lúc control commit.
- Số kết quả AI bị loại do người thật tiếp quản.
- Số outgoing chưa xác định nguồn và thời gian chờ đối soát.
- Số lần bot echo bị nhận nhầm là người thật.
- Số request AI trong human hold: mục tiêu 0, trừ tạo nháp chủ động.
- Số tin khách đang chờ người xử lý, kể cả đã bị chặn auto bằng watermark.
- Độ trễ phản hồi khi không có người thật tham gia, tách discovery/grace/AI/sender.

Không coi timestamp quan sát DOM là thời điểm thật người dùng gửi. Không dùng tỷ lệ overlap từ log đơn phương để tuyên bố bảo đảm tuyệt đối trên native Messenger.

### Rollback

Nếu phát hiện lỗi: tắt auto-reply, giữ đọc/nhật ký và quyền người thật; không rollback bằng cách xóa các cột human hold/epoch hoặc reset toàn bộ actions về PENDING.

Không khởi động sender phiên bản cũ với hàng đợi mới chưa được kiểm tra. Nếu cần rollback code, đưa các hội thoại/action có control v2 về trạng thái chờ người vận hành, giữ migration dữ liệu cộng thêm.

### Nghiệm thu sản phẩm

Đạt khi người vận hành thử được các tình huống:
- Bạn trả lời, bot không nối thêm khi đã quan sát và giành quyền kịp.
- Khách nhắn tiếp trong phiên bạn đang hỗ trợ, bot vẫn im.
- Bot không tự nhảy vào sau khi hết timer.
- Tắt/mở server không làm mất quyền tiếp quản.
- Một khách đang bạn hỗ trợ không làm ngừng các khách khác.
- Màn hình phân biệt rõ “yêu cầu dừng”, “đã dừng” và “đang xác minh tin đã bắt đầu gửi”.
- Có cách chủ động khóa bot trước khi bạn gõ trên thiết bị ngoài hệ thống.

---

## 19. Chỉ dẫn giao cho người triển khai

> Triển khai Human Priority theo hội thoại, không chỉ tăng debounce. Làm action identity/idempotency trước, tiếp đến control state + epoch + manual-send transaction + stop ACK thật, rồi outgoing observation trên Messenger. Áp quyền ở intake, trước/sau AI và trước submit. Không reset hành động chưa rõ đã gửi, không hủy nhầm manual action, không xóa draft người thật. Human hold mặc định 30 phút không hoạt động của cuộc trò chuyện; hết hold không gửi bù, chỉ nhận lượt mới. Default một tin bot mỗi lượt và không follow-up khi khách chưa nhắn thêm. Giữ PostgreSQL, không thêm Redis, không thay sender thành nhiều luồng. Viết kiểm thử cho race, restart, missed NOTIFY, bot echo, trùng nội dung và manual action collision trước khi bật production.

---

## 20. Nguồn tham chiếu

Các liên kết source bên dưới được cố định theo commit, để việc triển khai không bị lẫn với thay đổi ở `main` sau thời điểm rà soát.

[R01]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/tree/86418efdc049638a70a6058bf10dbb1b3e8aa7d4
[R02]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/apps/browser-agent/src/messenger-adapter.ts#L680-L958
[R03]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/apps/browser-agent/src/index.ts#L163-L230
[R04]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/apps/browser-agent/src/sender-worker.ts#L180-L490
[R05]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/apps/core/src/routes/inbox.ts#L320-L505
[R06]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/apps/core/src/jobs/handlers/ai.ts#L130-L380
[R07]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/packages/db/src/repository/outbound-repo.ts#L30-L143
[R08]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/apps/browser-agent/src/messenger-adapter.ts#L529-L558
[R09]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/packages/db/src/service/reply-policy-service.ts#L365-L455
[R10]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/packages/contracts/src/settings.ts#L25-L97
[R11]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/packages/ai/src/persona.ts#L20-L52
[R12]: https://github.com/TheDemonTuan/facebook-messenger-ai-rep/blob/86418efdc049638a70a6058bf10dbb1b3e8aa7d4/packages/db/src/repository/conversation-repo.ts#L430-L560
[E01]: https://www.intercom.com/help/en/articles/7860256-view-fin-ai-agent-s-conversations-from-the-inbox
[E02]: https://help.manychat.com/hc/en-us/articles/19957883687708-How-to-pause-all-automations

Nguồn bên ngoài được dùng cho nguyên tắc sản phẩm, không phải để khẳng định code hiện tại có các khả năng của Intercom hoặc Manychat.
