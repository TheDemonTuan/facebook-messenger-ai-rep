# PLAN — Thiết kế lại Human Handoff + Eligibility-First Persistence

Repo áp dụng: `TheDemonTuan/facebook-messenger-ai-rep`

Mục tiêu tài liệu này:

1. Sửa triệt để lỗi khi người thật trả lời thì hội thoại bị kẹt ở `MANUAL`.
2. Bỏ thiết kế hard-code human hold 30 phút.
3. Cho phép cấu hình thời gian ưu tiên người thật từ Dashboard/Settings.
4. Phân biệt rõ:
   - người thật chỉ vừa can thiệp tạm thời;
   - người vận hành chủ động takeover lâu dài;
   - safety/review hold.
5. Khi người thật rời cuộc nói chuyện, bot phải tự tiếp quản lại hợp lý.
6. Không để bot chen ngang khi nhân viên đang chat với khách.
7. Thiết kế lại inbound pipeline theo nguyên tắc **eligibility-first**.
8. Không persist full conversation/message/customer cho những người/thread không nằm trong phạm vi bot được phép xử lý.
9. Giảm database write, storage, index bloat, retention workload và chi phí VPS.
10. Giữ đủ telemetry tối thiểu để debug mà không lưu full nội dung ngoài phạm vi.

---

# 1. Tóm tắt vấn đề hiện tại

## 1.1 Human handoff hiện tại bị deadlock

Flow hiện tại:

```text
Khách gửi
   ↓
AI bắt đầu xử lý
   ↓
Người thật trả lời bằng Messenger
   ↓
Browser Agent phát hiện external outbound
   ↓
acquireSession()
   ↓
replyControlMode = HUMAN_SESSION
manualMode = true
humanHoldUntil = now + 30 phút
   ↓
AI bị cancel
```

Phần cancel AI là đúng.

Vấn đề xảy ra sau đó:

```text
Khách gửi tin nhắn mới
   ↓
ConversationRepository thấy manualMode = true
   ↓
không enqueue debounce
   ↓
DebounceHandler không chạy
   ↓
expireSessionIfDue() không được gọi
   ↓
conversation tiếp tục MANUAL
```

Kết quả thực tế:

```text
HUMAN_SESSION
      ↓
manualMode = true
      ↓
không có debounce
      ↓
không có nơi expire HUMAN_SESSION
      ↓
MANUAL vĩnh viễn
```

Người vận hành buộc phải vào Dashboard bấm release/bật lại AI.

Đây là thiết kế sai vì **temporary human activity đang bị biến thành persistent manual takeover**.

---

# 2. Nguyên tắc thiết kế mới

Không dùng `manualMode` như source of truth nữa.

Source of truth duy nhất:

```text
replyControlMode
controlEpoch
humanHoldUntil
humanSessionLastActivityAt
```

Các mode:

```text
AUTO
HUMAN_DRAFT
HUMAN_SESSION
HUMAN_PINNED
REVIEW_HOLD
```

Ý nghĩa:

| Mode | Ý nghĩa | Tự hết hạn |
|---|---|---:|
| `AUTO` | AI được quyền xử lý | N/A |
| `HUMAN_DRAFT` | nhân viên đang gõ/draft | Có |
| `HUMAN_SESSION` | vừa có human outbound | Có |
| `HUMAN_PINNED` | người vận hành takeover chủ động | Không |
| `REVIEW_HOLD` | safety/uncertain state | Không tự release nếu chưa reconcile |

`manualMode` chỉ còn là **derived compatibility field** trong giai đoạn migration.

Không được dùng:

```ts
if (conversation.manualMode) ...
```

làm quyết định chính ở nhiều nơi.

Phải dùng:

```ts
control.mode
control.holdUntil
control.epoch
```

---

# 3. Behavior mục tiêu

## 3.1 Người thật trả lời Messenger

Ví dụ:

```text
19:00:00 khách: "shop còn size M?"
19:00:03 nhân viên: "còn nha bạn"
```

Bot phải:

```text
- cancel AI đang generate/type
- HUMAN_SESSION
- không chen ngang
- ghi lastHumanOutboundAt
- bắt đầu grace period
```

Không được:

```text
manual forever
```

---

## 3.2 Khách hỏi tiếp trong lúc người thật vẫn đang nói chuyện

Ví dụ:

```text
19:00:03 nhân viên trả lời
19:00:15 khách hỏi tiếp
```

Không nên AI trả lời ngay.

Bot phải:

```text
nhận biết inbound mới
        ↓
human session còn active
        ↓
ghi nhận "pending customer turn"
        ↓
đợi human response grace
```

Nếu nhân viên trả lời:

```text
19:00:40 nhân viên trả lời
```

thì:

```text
gia hạn HUMAN_SESSION
pending AI fallback bị invalidate
```

Nếu nhân viên không trả lời:

```text
grace hết
↓
AUTO
↓
AI xử lý inbound mới nhất
```

---

# 4. Không dùng fixed 30 phút nữa

30 phút không phù hợp với shop realtime.

Đề xuất thiết kế 3 timeout riêng.

## 4.1 Config mới

Thêm vào `SystemSettingsBaseShape`:

```ts
humanHandoffEnabled: z.boolean(),

humanOutboundGraceMs:
  z.number().int().min(5000).max(30 * 60 * 1000),

humanInboundResponseWaitMs:
  z.number().int().min(5000).max(10 * 60 * 1000),

humanDraftLeaseMs:
  z.number().int().min(5000).max(5 * 60 * 1000),

humanSessionMaxMs:
  z.number().int().min(30000).max(60 * 60 * 1000),

autoResumeAfterHuman: z.boolean(),
```

Recommended defaults:

```ts
humanHandoffEnabled: true,

humanOutboundGraceMs: 120_000,
humanInboundResponseWaitMs: 60_000,
humanDraftLeaseMs: 30_000,
humanSessionMaxMs: 10 * 60_000,

autoResumeAfterHuman: true,
```

Ý nghĩa:

### `humanOutboundGraceMs`

Sau khi phát hiện nhân viên vừa gửi Messenger:

```text
AI nhường quyền tối thiểu X giây
```

Default đề xuất:

```text
120 giây
```

---

### `humanInboundResponseWaitMs`

Khách vừa hỏi tiếp trong `HUMAN_SESSION`.

Cho người thật thêm một khoảng ngắn để trả lời trước khi AI fallback.

Default:

```text
60 giây
```

---

### `humanDraftLeaseMs`

Khi nhân viên đang gõ trên Dashboard:

```text
HUMAN_DRAFT
```

Default:

```text
30 giây
```

Mỗi activity/keystroke hợp lệ có thể refresh lease có rate-limit.

---

### `humanSessionMaxMs`

Safety cap.

Dù có activity lỗi hoặc timestamp lỗi:

```text
temporary HUMAN_SESSION không được sống vô hạn
```

Default:

```text
10 phút
```

`HUMAN_PINNED` không chịu cap này.

---

# 5. State machine mới

```text
                       operator takeover
                  ┌────────────────────────┐
                  │                        ▼
             ┌──────────┐            ┌──────────────┐
             │   AUTO   │            │ HUMAN_PINNED │
             └────┬─────┘            └──────┬───────┘
                  │                         │
                  │ external human         │ manual release
                  │ outbound               │
                  ▼                         │
          ┌─────────────────┐              │
          │  HUMAN_SESSION  │◄─────────────┘
          └───────┬─────────┘
                  │
         human inactivity timeout
                  │
                  ▼
             ┌──────────┐
             │   AUTO   │
             └──────────┘
```

Draft:

```text
AUTO
 ↓ operator typing
HUMAN_DRAFT
 ↓ send
HUMAN_SESSION
 ↓ idle
AUTO
```

Abandon draft:

```text
HUMAN_DRAFT
 ↓ draftLeaseExpiresAt
AUTO
```

---

# 6. Quy tắc ưu tiên

Precedence:

```text
1. BLOCKED
2. REVIEW_HOLD
3. HUMAN_PINNED
4. HUMAN_DRAFT active
5. HUMAN_SESSION active
6. AUTO
```

Không cho một `manualMode=true` legacy override ngược lại state machine.

---

# 7. Normalize control state trước mọi inbound

Đây là thay đổi quan trọng nhất để fix deadlock.

Hiện nay expiration nằm quá muộn.

Thiết kế mới:

```ts
normalizeForInbound(conversationId, now)
```

phải chạy **ngay sau khi lock conversation và trước policy evaluation**.

Pseudo:

```ts
switch (control.mode) {
  case "HUMAN_DRAFT":
    if (draftLeaseExpired) {
      transitionToAuto("DRAFT_LEASE_EXPIRED")
    }
    break

  case "HUMAN_SESSION":
    if (sessionExpired || maxSessionExceeded) {
      transitionToAuto("HUMAN_SESSION_EXPIRED")
    }
    break

  case "HUMAN_PINNED":
  case "REVIEW_HOLD":
    // never automatic release
    break
}
```

Quan trọng:

```text
normalization phải xảy ra ngay cả khi conversation hiện đang MANUAL.
```

Không được phụ thuộc debounce job.

---

# 8. Deferred fallback cho khách nhắn trong human session

Case:

```text
human session active
+
new inbound
```

Không bỏ tin inbound.

Không generate AI ngay.

Tạo một scheduled/deferred job:

```text
human-fallback
```

Payload:

```json
{
  "conversationId": "...",
  "channelAccountId": "...",
  "inboundVersion": 15,
  "controlEpoch": 31,
  "expectedMode": "HUMAN_SESSION"
}
```

`availableAt`:

```text
now + humanInboundResponseWaitMs
```

Khi chạy:

```text
load current control state
        ↓
nếu controlEpoch thay đổi
→ stale → cancel

nếu đã có human outbound mới hơn inbound
→ cancel

nếu HUMAN_PINNED
→ cancel

nếu REVIEW_HOLD
→ cancel

nếu HUMAN_SESSION đã idle đủ
→ AUTO
→ enqueue debounce cho inboundVersion hiện tại
```

Mục tiêu:

```text
khách không cần gửi thêm lần nữa để đánh thức bot.
```

---

# 9. Refresh human session đúng cách

Mỗi external human outbound:

```text
lastHumanOutboundAt = now
humanSessionLastActivityAt = now
humanHoldUntil = now + humanOutboundGraceMs
controlEpoch++
```

Nếu đang:

```text
HUMAN_SESSION
```

thì refresh session.

Nếu đang:

```text
HUMAN_PINNED
```

không đổi xuống session.

Pseudo:

```ts
if (mode === "HUMAN_PINNED") {
  updateLastHumanActivityOnly();
} else {
  acquireOrRefreshHumanSession();
}
```

---

# 10. Không dùng `setHumanHold()` legacy nữa

Hiện source đang tồn tại song song:

```text
ConversationControlService.acquireSession()
```

và:

```text
ConversationRepository.setHumanHold()
```

Đây là nguy cơ split-brain state.

`setHumanHold()` hiện có thể thay:

```text
manualMode
humanHoldUntil
status
```

mà không đồng bộ đầy đủ:

```text
replyControlMode
controlEpoch
controlReason
```

Plan:

```text
DEPRECATE setHumanHold()
DEPRECATE clearHumanHold()
DEPRECATE setManualMode()
```

Mọi mutation control phải qua:

```text
ConversationControlService
```

---

# 11. Dashboard Settings

Thêm section:

```text
Ưu tiên người thật
```

Controls:

```text
[x] Tự nhường khi phát hiện tôi trả lời Messenger

Thời gian ưu tiên sau khi nhân viên gửi:
[ 120 ] giây

Khi khách hỏi tiếp, chờ nhân viên:
[ 60 ] giây

Draft lease trên Dashboard:
[ 30 ] giây

Session người thật tối đa:
[ 10 ] phút

[x] Tự động giao lại cho AI khi nhân viên ngưng hoạt động
```

Preset:

```text
Nhanh:
60s / 30s

Cân bằng:
120s / 60s

Ưu tiên người thật:
300s / 120s
```

Không hard-code business logic trong UI.

UI chỉ ghi settings.

---

# 12. Vấn đề database hiện tại

Pipeline hiện tại gần như:

```text
DOM observe
 ↓
resolve sender
 ↓
lock/create conversation
 ↓
create/update customer
 ↓
upsert participant
 ↓
insert inbound_messages
 ↓
insert messages
 ↓
evaluate reply policy
 ↓
nếu không eligible → không reply
```

Nhược điểm:

```text
"không reply" != "không persist"
```

Do đó những thread/người ngoài phạm vi vẫn có thể tạo:

```text
customers
conversations
participants
messages
inbound_messages
reply decisions
events
indexes
```

Nếu Messenger account nhận nhiều tin cá nhân/group/page không liên quan:

```text
DB vẫn phình liên tục.
```

---

# 13. Mục tiêu mới: Eligibility-First Persistence

Pipeline mới:

```text
Observe raw Messenger event
        ↓
Cheap normalize
        ↓
Resolve minimal sender/thread identity
        ↓
PRE-PERSIST ELIGIBILITY GATE
        ↓
┌────────────────────────────┐
│ eligible / trackable       │
│ persist full data          │
└────────────────────────────┘

┌────────────────────────────┐
│ irrelevant / excluded      │
│ DROP before DB content     │
└────────────────────────────┘
```

---

# 14. Phân biệt policy gate và AI semantic scope

Có hai loại "không liên quan".

## A. Không nằm trong phạm vi người/thread được phép xử lý

Ví dụ:

```text
replyMode = ONLY_SELECTED
sender không selected

groupRepliesEnabled = false
thread là group

pageRepliesEnabled = false
sender/page không được xử lý

excludedParticipantIds chứa sender
```

Loại này:

```text
DROP BEFORE FULL PERSISTENCE
```

---

## B. Người hợp lệ nhưng nội dung câu hỏi AI không xử lý

Ví dụ khách được phép:

```text
"ê hôm nay trời đẹp"
```

Nếu business rule không muốn AI trả lời:

```text
conversation vẫn có thể cần giữ
```

vì đây vẫn là khách thuộc phạm vi quản lý.

Không nên lẫn:

```text
identity/thread eligibility
```

với:

```text
semantic intent eligibility
```

Plan này ưu tiên giải quyết loại A trước để giảm DB.

---

# 15. Pre-Persist Eligibility API

Tạo method mới:

```ts
ReplyPolicyService.evaluatePrePersist()
```

Input không được yêu cầu:

```text
conversationId
inboundMessageId
```

vì chúng chưa tồn tại.

Input:

```ts
interface PrePersistEligibilityInput {
  channelAccountId: string;
  payload: InboundMessagePayload;

  existingConversation?: {
    id: string;
    replyControlMode: ReplyControlMode;
    humanHoldUntil: Date | null;
    isBlocked: boolean;
  } | null;
}
```

Output:

```ts
interface PrePersistEligibilityResult {
  disposition:
    | "FULL_PROCESS"
    | "TRACK_NO_REPLY"
    | "DROP";

  eligibleForReply: boolean;

  reasonCode: string;

  identity?: {
    participantId?: string;
    senderKind: SenderKind;
    reliability: ClassificationReliability;
  };
}
```

---

# 16. Disposition matrix

| Case | Full message persist | Conversation | AI |
|---|---:|---:|---:|
| selected direct person | Yes | Yes | Yes |
| allowed EVERYONE_EXCEPT | Yes | Yes | Yes |
| excluded participant | No | No new conversation | No |
| ONLY_SELECTED + not selected | No | No new conversation | No |
| group disabled | No | No new conversation | No |
| page disabled | No | No new conversation | No |
| non-person disabled | No | No new conversation | No |
| bot/self outbound echo | No inbound persist | Existing outbound reconciliation only | No |
| blocked existing customer | configurable minimal audit | Existing only | No |
| HUMAN_SESSION customer inbound | Yes | Yes | deferred | Later |
| HUMAN_PINNED customer inbound | Yes | Yes | No | No |

---

# 17. Quan trọng: existing in-scope conversation

Nếu conversation đã là một conversation hợp lệ của shop:

```text
không được DROP inbound chỉ vì bot đang HUMAN_SESSION.
```

`HUMAN_SESSION` là:

```text
reply control
```

không phải:

```text
data scope
```

Do đó:

```text
in-scope customer + human session
→ persist inbound
→ defer AI
```

---

# 18. Không tạo conversation cho người ngoài scope

Nếu:

```text
ONLY_SELECTED
+
participantId không selected
```

thì không được:

```text
INSERT customers
INSERT conversations
INSERT messages
INSERT inbound_messages
```

Browser Agent chỉ:

```text
drop event
```

---

# 19. Minimal drop telemetry

Không nên hoàn toàn mù observability.

Nhưng telemetry không được chứa full text.

Đề xuất metric in-memory/Prometheus/log:

```text
messenger_inbound_dropped_total{
  reason="PERSON_NOT_SELECTED"
}
```

Hoặc low-cardinality DB aggregate:

```text
policy_drop_counters
```

Fields:

```text
channel_account_id
date_bucket
reason_code
count
```

Không lưu:

```text
message text
participant name
avatar
full thread URL
raw payload
```

Có thể lưu hash không reversible nếu thật sự cần dedupe:

```text
HMAC(channelSecret, externalMessageId)
```

Nhưng default nên không cần DB per-message telemetry.

---

# 20. Dedupe cho dropped traffic

Một vấn đề:

Nếu không lưu message thì stable externalMessageId không tồn tại trong DB để dedupe.

Không nên vì vậy mà persist message.

Dùng cache ngắn hạn:

```text
Redis SET
```

key:

```text
drop-dedupe:{channelAccountId}:{HMAC(externalMessageId)}
```

TTL:

```text
5–30 phút
```

Value:

```text
1
```

Nếu không muốn Redis dependency:

```text
bounded in-memory LRU
```

trên browser-agent.

Ưu tiên Redis nếu production chạy nhiều replica.

---

# 21. Pre-Persist gate phải rẻ

Không gọi AI.

Không semantic classify bằng LLM.

Chỉ dựa vào:

```text
channel settings
threadKind
senderKind
verified participantId
selected/excluded sets
group/page/direct flags
self/bot identity
blocked known conversation
```

Mục tiêu latency:

```text
< 5–20ms DB/cache side
```

---

# 22. Cache policy config

Không query settings + policy members cho từng bubble nếu traffic cao.

Cache:

```text
policy:{channelAccountId}
```

Chứa:

```json
{
  "revision": 123,
  "replyMode": "ONLY_SELECTED",
  "selectedIds": ["..."],
  "excludedIds": ["..."],
  "direct": true,
  "group": false,
  "page": false,
  "nonPerson": false
}
```

Invalidate khi:

```text
SETTING_CHANGED
policy member update
```

TTL backup:

```text
30–120 giây
```

---

# 23. Pipeline ingest mới

Pseudo:

```ts
async function ingestObservedInbound(payload) {
  const minimal = await classifyMinimalIdentity(payload);

  const existingConversation =
    await findExistingConversationMinimal(
      payload.channelAccountId,
      payload.externalThreadId
    );

  if (existingConversation) {
    await controlService.normalizeForInbound(
      existingConversation.id,
      new Date()
    );
  }

  const pre = await replyPolicyService.evaluatePrePersist({
    channelAccountId: payload.channelAccountId,
    payload,
    existingConversation,
  });

  if (pre.disposition === "DROP") {
    await recordDropMetric(pre.reasonCode);
    return {
      disposition: "DROPPED",
      reasonCode: pre.reasonCode,
    };
  }

  return persistAcceptedInbound(payload, pre);
}
```

---

# 24. Tách `ingestInboundMessage()`

Method hiện tại đang làm quá nhiều thứ.

Tách thành:

```text
classifyMinimalInbound()
evaluatePrePersist()
findExistingConversation()
normalizeControl()
persistAcceptedInbound()
scheduleAcceptedInbound()
```

Không nên một transaction 500+ lines đảm nhiệm toàn bộ.

---

# 25. Transaction boundary mới

## Stage 1 — no write

```text
classify
load cached settings
evaluate identity eligibility
```

Nếu DROP:

```text
return
```

Không transaction write.

---

## Stage 2 — accepted persistence transaction

Chỉ khi:

```text
FULL_PROCESS
TRACK_NO_REPLY
```

mới:

```text
lock conversation
dedupe
upsert participant/customer
insert message
increment version
record accepted decision
```

---

# 26. Policy decision storage

Hiện `ReplyPolicyService.evaluateInbound()` luôn cố record decision.

Với dropped traffic:

```text
không record từng decision row.
```

Thay bằng:

```text
evaluatePrePersist(..., { persistDecision: false })
```

Full persisted inbound mới có:

```text
reply_eligibility_decisions
```

Nếu cần analytics cho drop:

```text
aggregate counter
```

---

# 27. Settings mới cho persistence

Thêm:

```ts
persistenceMode: z.enum([
  "ELIGIBLE_ONLY",
  "ALL_OBSERVED"
]),

persistExcludedInbound: z.boolean(),

persistDropTelemetry: z.boolean(),
```

Recommended production defaults:

```ts
persistenceMode: "ELIGIBLE_ONLY",
persistExcludedInbound: false,
persistDropTelemetry: true,
```

Thực tế có thể chỉ expose Dashboard:

```text
Lưu dữ liệu ngoài phạm vi AI
[ Không ]    ← default
```

`ALL_OBSERVED` chỉ phục vụ debug.

---

# 28. Không nên cho user vô tình phá optimization

Trong production:

```text
ELIGIBLE_ONLY
```

nên là recommended.

Nếu chọn:

```text
ALL_OBSERVED
```

Dashboard cảnh báo:

```text
"Sẽ tăng đáng kể dữ liệu lưu trữ."
```

---

# 29. Cleanup dữ liệu legacy

Sau khi deploy eligibility-first, database vẫn còn data cũ.

Tạo maintenance script:

```text
scripts/prune-out-of-scope-conversations.ts
```

Dry-run default:

```bash
bun scripts/prune-out-of-scope-conversations.ts --dry-run
```

Report:

```text
conversations scanned
out-of-scope conversations
messages affected
inbound rows
ai runs
events
estimated bytes
```

Chỉ khi explicit:

```text
--apply
```

mới delete.

---

# 30. Không delete conversation đang có giá trị business

Cleanup không nên xóa chỉ dựa vào current setting.

Ví dụ khách trước đây hợp lệ nhưng giờ bị excluded.

Các conversation có:

```text
MANUAL_OWNER outbound
AI outbound confirmed
notes
business tag/order refs
recent accepted interaction
```

nên giữ theo retention policy.

Delete candidate:

```text
never processed
never replied
no business metadata
policy denied from beginning
```

---

# 31. Schema migration human handoff

Các column hiện có gần đủ:

```text
reply_control_mode
control_epoch
human_hold_until
last_human_outbound_at
human_session_last_activity_at
draft_lease_expires_at
```

Có thể thêm:

```sql
human_session_started_at timestamptz
pending_human_fallback_version integer
```

Nhưng ưu tiên không thêm column nếu job payload + existing timestamps đủ dùng.

Nếu cần max session cap an toàn:

```text
humanSessionStartedAt
```

rõ ràng hơn.

---

# 32. Derived `manualMode`

Migration phase:

```ts
manualMode =
  replyControlMode !== "AUTO"
```

ngoại trừ nếu cần phân biệt REVIEW.

Sau khi toàn bộ source chuyển sang control mode:

```text
remove manual_mode column
```

Đây nên là phase sau, không làm cùng release đầu tiên nếu muốn giảm risk.

---

# 33. API thay đổi

## Existing

```text
POST /api/inbox/:id/takeover
POST /api/inbox/:id/release
POST /api/inbox/:id/draft-lease
POST /api/inbox/:id/manual-send
```

Giữ.

Semantics:

```text
/takeover → HUMAN_PINNED
/release → AUTO
/draft-lease → HUMAN_DRAFT
/manual-send → HUMAN_SESSION sau successful send
```

Lưu ý:

Hiện manual-send acquire session **trước khi send**.

Tốt hơn:

```text
draft lease trước
send confirmed
→ HUMAN_SESSION
```

Nếu send fail:

```text
không giữ HUMAN_SESSION dài.
```

---

# 34. External Messenger outbound

Current:

```text
detect external outbound
→ acquireSession(30 minutes)
```

Đổi:

```text
load current settings
→ humanOutboundGraceMs
→ acquireOrRefreshSession()
```

Không hard-code:

```ts
30 * 60 * 1000
```

ở bất kỳ service nào.

---

# 35. Sender worker pre-enter race

Nếu AI chuẩn bị Enter và phát hiện external human outbound:

Current legacy:

```text
setHumanHold()
```

New:

```text
controlService.acquireOrRefreshSession()
```

Sau đó:

```text
abort AI action
clear composer
increment epoch
record event
```

---

# 36. Scheduler cleanup safety net

Ngoài inbound-driven normalization, thêm periodic cleanup nhẹ:

```text
expire-human-control
```

Mỗi:

```text
30–60 giây
```

Scan bằng index:

```text
reply_control_mode IN ('HUMAN_DRAFT','HUMAN_SESSION')
AND expiry <= now()
```

Limit:

```text
100–500 rows/batch
```

Mục đích:

```text
UI/status tự trở về AUTO kể cả không có inbound mới.
```

Nhưng scheduler chỉ là safety net.

Inbound path vẫn phải tự normalize.

---

# 37. Index đề xuất

```sql
CREATE INDEX CONCURRENTLY idx_conversations_control_expiry
ON conversations (human_hold_until)
WHERE reply_control_mode = 'HUMAN_SESSION';

CREATE INDEX CONCURRENTLY idx_conversations_draft_expiry
ON conversations (draft_lease_expires_at)
WHERE reply_control_mode = 'HUMAN_DRAFT';
```

Nếu scheduler cần scan.

---

# 38. Event model

Thêm event types nếu cần:

```text
HUMAN_SESSION_STARTED
HUMAN_SESSION_REFRESHED
HUMAN_SESSION_EXPIRED
AI_RESUMED_AFTER_HUMAN
INBOUND_DROPPED_POLICY
```

`INBOUND_DROPPED_POLICY` không nhất thiết persist per event.

Có thể chỉ metric/log.

---

# 39. Tests bắt buộc — Human Handoff

## H1

```text
AUTO
customer inbound
AI queued
human outbound
```

Expected:

```text
AI cancelled
HUMAN_SESSION
```

---

## H2

```text
HUMAN_SESSION expires
customer sends
```

Expected:

```text
normalize AUTO
same inbound gets debounce
AI replies
```

Không cần customer gửi lần thứ hai.

---

## H3

```text
HUMAN_SESSION active
customer sends
human sends within wait
```

Expected:

```text
AI fallback stale/cancelled
```

---

## H4

```text
HUMAN_SESSION active
customer sends
human silent
```

Expected:

```text
fallback job
AUTO
AI handles latest inbound
```

---

## H5

```text
HUMAN_PINNED
customer sends
```

Expected:

```text
persist inbound
AI never auto-resumes
```

---

## H6

```text
HUMAN_DRAFT expires without send
```

Expected:

```text
AUTO
```

---

## H7

```text
external human sends repeatedly
```

Expected:

```text
session refresh
no duplicate state corruption
```

---

## H8

```text
AI action created epoch 10
human takeover changes epoch 11
```

Expected:

```text
old action cannot send
```

---

# 40. Tests bắt buộc — Persistence

## P1 ONLY_SELECTED

```text
replyMode = ONLY_SELECTED
sender not selected
```

Expected DB:

```text
0 new customer
0 new conversation
0 new messages
0 new inbound_messages
0 AI job
```

---

## P2 selected sender

Expected:

```text
full persist
debounce
AI
```

---

## P3 excluded sender

Expected:

```text
DROP
```

---

## P4 group disabled

Expected:

```text
no conversation/message persist
```

---

## P5 page disabled

Expected:

```text
DROP
```

---

## P6 self/bot echo

Expected:

```text
never inserted as inbound customer message
```

---

## P7 existing valid customer + HUMAN_SESSION

Expected:

```text
message persisted
AI deferred
```

---

## P8 existing valid customer + HUMAN_PINNED

Expected:

```text
message persisted
AI not scheduled
```

---

## P9 10,000 irrelevant messages

Expected:

```text
messages table growth ~= 0
inbound_messages growth ~= 0
conversations growth ~= 0
```

Only metrics/counters may change.

---

# 41. Load test

Generate synthetic traffic:

```text
10% selected valid direct
70% unselected direct
10% group
10% self/non-person
```

Compare:

```text
DB inserts/sec
WAL bytes
table growth
index growth
CPU
transaction latency
```

Target:

```text
write volume roughly proportional to accepted traffic,
không proportional với toàn bộ Messenger traffic.
```

---

# 42. Rollout phases

## Phase 0 — regression tests

Viết tests reproducing current bugs trước.

Không thay code.

---

## Phase 1 — control state normalization

Implement:

```text
normalizeForInbound()
acquireOrRefreshSession()
```

Remove debounce-only expiry dependency.

---

## Phase 2 — configurable handoff

Add settings.

Remove 30-minute constants.

Update dashboard.

---

## Phase 3 — deferred human fallback

Add:

```text
human-fallback jobs
```

Đảm bảo customer turn không bị bỏ quên.

---

## Phase 4 — pre-persist eligibility

Add:

```text
evaluatePrePersist()
```

Refactor ingestion.

---

## Phase 5 — drop irrelevant persistence

Enable:

```text
ELIGIBLE_ONLY
```

first in shadow metrics.

---

## Phase 6 — cleanup legacy state/data

Remove legacy:

```text
setHumanHold
clearHumanHold
setManualMode decision paths
```

Run storage cleanup separately.

---

# 43. Shadow rollout cho persistence

Trước khi drop thật:

```text
persistenceMode = ALL_OBSERVED
```

nhưng calculate:

```text
wouldDrop=true
```

Metrics:

```text
would_drop_total by reason
```

Chạy một khoảng quan sát.

Sau khi xác minh sender classification ổn:

```text
persistenceMode = ELIGIBLE_ONLY
```

Điều này tránh accidental data loss do classifier lỗi.

---

# 44. Fail-safe policy

Nếu identity reliability không đủ:

```text
UNKNOWN sender
UNKNOWN thread
```

Không nên mặc định full persist vô hạn.

Config:

```ts
unknownIdentityPolicy:
  "DROP"
  | "MINIMAL"
  | "PROCESS"
```

Recommended với account cá nhân nhiều chat không liên quan:

```text
MINIMAL
```

`MINIMAL`:

```text
không full message history
không AI
temporary short-lived observation/cache
```

Khi sau đó identity được verify selected:

```text
bắt đầu persist từ thời điểm đó.
```

---

# 45. Privacy/storage principle

Data lifecycle:

```text
OBSERVED
  ↓
ELIGIBILITY GATE
  ↓
ACCEPTED
  ↓
PERSISTED
```

Không:

```text
OBSERVED
  ↓
PERSIST EVERYTHING
  ↓
decide later
```

Đây là thay đổi kiến trúc quan trọng nhất cho VPS nhỏ.

---

# 46. Files dự kiến sửa

## Contracts

```text
packages/contracts/src/settings.ts
packages/contracts/src/enums.ts
packages/contracts/src/policy.ts
packages/contracts/src/jobs.ts
packages/contracts/src/events.ts
```

---

## DB

```text
packages/db/src/service/conversation-control-service.ts
packages/db/src/service/reply-policy-service.ts
packages/db/src/repository/conversation-repo.ts
packages/db/src/repository/settings-repo.ts
packages/db/src/schema/index.ts
packages/db/migrations/*
```

---

## Core

```text
apps/core/src/jobs/handlers/debounce.ts
apps/core/src/jobs/handlers/ai.ts
apps/core/src/jobs/handlers/human-fallback.ts
apps/core/src/jobs/scheduler.ts
apps/core/src/routes/inbox.ts
apps/core/src/routes/admin.ts
```

---

## Browser

```text
apps/browser-agent/src/index.ts
apps/browser-agent/src/messenger-adapter.ts
apps/browser-agent/src/sender-worker.ts
```

---

## Dashboard

```text
apps/dashboard/src/pages/SettingsPage.tsx
apps/dashboard/src/pages/ConversationDetailPage.tsx
apps/dashboard/src/types.ts
```

---

## Tests

```text
tests/human-priority-and-takeover.test.ts
tests/messenger-reply-eligibility.test.ts
tests/messenger-reply-gating.test.ts
tests/messenger-reply-persistence.test.ts
tests/dedupe-debounce.test.ts
tests/full-e2e-simulation.test.ts
```

Add:

```text
tests/eligibility-first-persistence.test.ts
tests/human-auto-resume.test.ts
```

---

# 47. Acceptance criteria

Release chỉ được coi là xong khi tất cả điều kiện sau pass.

### Human handoff

- Người thật trả lời → AI dừng ngay.
- Temporary human activity không bao giờ tạo permanent manual.
- Timeout không hard-code 30 phút.
- Timeout chỉnh được từ settings.
- Khách nhắn sau khi human idle → AI tự trả lời.
- Khách không phải nhắn lần thứ hai.
- `HUMAN_PINNED` vẫn manual cho tới explicit release.
- Old AI action không thể send sau epoch change.

### Persistence

- ONLY_SELECTED + unselected → không tạo message/conversation mới.
- Excluded → không full persist.
- Disabled group/page/non-person → không full persist.
- Existing valid customer vẫn giữ lịch sử cần thiết.
- Human handoff không khiến inbound valid bị drop.
- Không gọi LLM để quyết định pre-persist identity scope.
- Drop telemetry không chứa message text/raw payload.
- Load test chứng minh DB writes giảm theo tỷ lệ irrelevant traffic.

---

# 48. Recommended production defaults

```json
{
  "humanHandoffEnabled": true,
  "humanOutboundGraceMs": 120000,
  "humanInboundResponseWaitMs": 60000,
  "humanDraftLeaseMs": 30000,
  "humanSessionMaxMs": 600000,
  "autoResumeAfterHuman": true,

  "persistenceMode": "ELIGIBLE_ONLY",
  "persistExcludedInbound": false,
  "persistDropTelemetry": true
}
```

Nếu shop muốn bot takeover nhanh hơn:

```json
{
  "humanOutboundGraceMs": 60000,
  "humanInboundResponseWaitMs": 30000
}
```

Không khuyến nghị:

```text
30 phút fixed
```

cho external human outbound bình thường.

---

# 49. Flow cuối cùng mong muốn

```text
Messenger Bubble
      │
      ▼
Minimal Parse / Identity
      │
      ▼
Pre-Persist Policy Gate
      │
      ├── OUT OF SCOPE
      │       │
      │       └── DROP + metric
      │
      └── IN SCOPE
              │
              ▼
      Normalize Control State
              │
              ▼
       Persist Accepted Data
              │
              ▼
        Reply Control Gate
              │
      ┌───────┼──────────┐
      │       │          │
    AUTO   HUMAN      PINNED
      │    SESSION        │
      │       │           │
      │       ▼           │
      │  deferred         │
      │  fallback         │
      │       │           │
      └───────┘           │
          │               │
          ▼               │
      AI Pipeline         no AI
```

---

# 50. Kết luận kiến trúc

Hai thay đổi này nên làm cùng nhau vì chúng giải quyết cùng một vấn đề nền:

```text
system đang coi mọi Messenger activity như state/data lâu dài.
```

Thiết kế mới phải chuyển sang:

```text
temporary activity
+
explicit scope
+
bounded state
+
eligibility-first persistence
```

Human activity:

```text
temporary lease
```

không phải permanent mode.

Inbound ngoài phạm vi:

```text
observation
```

không phải business conversation.

Khi hoàn thành plan này, hệ thống sẽ:

```text
ít chen ngang người thật hơn
tự tiếp quản lại đúng lúc
không cần bật bot thủ công
giảm DB write đáng kể
giảm storage VPS
giảm index/WAL/retention overhead
giữ dữ liệu tập trung vào đúng khách mà bot cần phục vụ
```
