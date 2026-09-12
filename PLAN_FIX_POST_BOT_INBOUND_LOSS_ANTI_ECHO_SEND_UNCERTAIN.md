# PLAN FIX TRIỆT ĐỂ — MẤT INBOUND SAU KHI BOT REPLY, ANTI-ECHO & SEND_UNCERTAIN

**Repository:** `TheDemonTuan/facebook-messenger-ai-rep`  
**Baseline review:** `main @ 726237d6abb1d04d7455a6aadd49eb71e3ff80e3`  
**Commit logic chính:** `a024e2983d60911c05dffc880b9af328ff38ae9b` — `fix: resolve SEND_UNCERTAIN lockout and prevent bot echo ingestion`  
**Ngày review:** 2026-09-11  
**Priority:** **P0 — có thể làm mất tin nhắn inbound hợp lệ của khách**

---

## 1. Kết luận

Case đang quan sát:

```text
Khách gửi A
→ bot nhận
→ bot trả B
→ khách gửi tiếp C
→ hệ thống không nhận C
→ inboundVersion không tăng
→ không debounce
→ AI không xử lý tiếp
```

**Chưa được fix triệt để ở HEAD hiện tại.**

Commit `a024e298...` đúng khi cố xử lý bot echo và `SEND_UNCERTAIN`, nhưng anti-echo mới có một nhánh có thể nhận nhầm **tin khách** thành **tin bot**, rồi đánh dấu bubble là đã xử lý và bỏ qua luôn.

---

## 2. Root cause P0: same-thread trong 60 giây bị coi là bot

Flow hiện tại:

```text
Messenger DOM
→ readBubblesFromPage()
→ parseMessengerBubblesFromHtml()
→ processInboundBubbles()
→ anti-echo check
→ inboundCallback()
→ ingestInboundMessage()
```

Trong `processInboundBubbles()`, anti-echo chạy **trước `inboundCallback()`**.

Nếu nó quyết định bubble là bot:

```ts
bubble.isOutgoing = true;
this.lastSeenMessageIds.add(bubble.id);
this.confirmedOutboundMessageIds.add(bubble.id);
continue;
```

Do đó message không đi xuống DB.

Trong `OutboundRepository.isBotOutbound()` hiện có fallback đại ý:

```ts
if (externalThreadId) {
  const recentThreshold = new Date(Date.now() - 60_000);

  // same channel
  // actor AI
  // same Messenger thread
  // recent AI action
  // => true
}
```

Nhánh này **không yêu cầu**:

```text
bubbleId khớp
externalMessageRef khớp
text khớp
sender khớp
```

Chỉ cần cùng thread và vừa có một AI outbound action.

### Exact reproduction

```text
00s  Customer: "Shop còn size M không?"
03s  Bot:      "Dạ còn size M nha 🥰"
08s  Customer: "vậy lấy cho mình màu trắng nha"
```

Khi message thứ ba được đọc:

```text
exact message ref không match bot
↓
same-thread 60s query vẫn tìm thấy bot action vừa CONFIRMED
↓
isBotOutbound() = true
↓
anti-echo đánh customer bubble thành outgoing
↓
mark seen
↓
continue
↓
không inboundCallback()
↓
không DB
↓
không debounce
↓
không AI
```

Đây là root cause rất phù hợp với symptom thực tế.

---

## 3. Test hiện tại còn khóa hành vi sai

Hiện có regression test theo hướng:

```text
recent AI action + exact Messenger thread
→ isBotOutbound = true
```

thậm chí không cần text.

Test này cần được **xóa/invert**, vì:

```text
same thread + recent AI
≠ proof bubble belongs to AI
```

CI xanh không loại trừ bug này nếu test đang xác nhận chính heuristic sai.

---

# 4. P0 — Thay boolean `isBotOutbound()` bằng evidence-based origin classification

Không nên dùng:

```ts
boolean
```

cho quyết định có thể làm mất inbound.

Đề xuất:

```ts
type ObservedBubbleOrigin =
  | {
      kind: "BOT_CONFIRMED";
      confidence: "STRONG";
      evidence: string[];
    }
  | {
      kind: "CUSTOMER_CONFIRMED";
      confidence: "STRONG";
      evidence: string[];
    }
  | {
      kind: "UNKNOWN";
      confidence: "WEAK";
      evidence: string[];
    };
```

API:

```ts
classifyObservedBubble({
  channelAccountId,
  threadId,
  bubbleId,
  text,
  isOutgoing,
  senderId,
  senderKind,
  senderReliability,
  observedAt,
});
```

---

## 5. Evidence precedence

### BOT_CONFIRMED

Chỉ được hard-suppress khi có evidence mạnh:

```text
1. exact externalMessageRef khớp outbound action đã gửi
2. bubble ID đã được verifySent() xác nhận locally
3. DOM xác nhận outgoing
   + exact thread
   + strict normalized full-text match
   + tight send window
```

### CUSTOMER_CONFIRMED

Nếu:

```ts
bubble.isOutgoing === false
bubble.senderKind === "PERSON"
bubble.senderReliability === "VERIFIED"
bubble.senderId !== botParticipantId
```

thì phải ưu tiên customer.

### UNKNOWN

Các tín hiệu dưới đây chỉ là weak evidence:

```text
same thread
close timestamp
substring giống
prefix giống
sender không rõ
DOM direction không chắc
```

`UNKNOWN` **không được silently drop**.

---

# 6. P0 — Xóa same-thread-only 60s heuristic

Xóa:

```text
same thread + recent AI action = BOT
```

Đổi thành một trong:

```text
exact message ref
```

hoặc:

```text
same thread
+ strong outgoing DOM evidence
+ strict normalized full text
+ time window
```

Không bao giờ nhận diện bot chỉ từ thread + thời gian.

---

# 7. Không dùng TYPING làm bằng chứng message đã gửi

`TYPING` chỉ có nghĩa:

```text
bot đang gõ
```

chưa có outbound bubble.

Không được:

```text
AI TYPING trong thread
→ bubble mới của thread là bot
```

Đây lại chính là lúc nhân viên hoặc khách có thể gửi tin mới.

Ngoài ra bỏ `CLAIMED` khỏi outbound action classification vì nó không phải canonical `OutboundActionStatus`.

---

# 8. P0 — Scope bot-send cache theo thread

Hiện cache gần dạng:

```ts
Array<{ text: string; sentAt: number }>
```

Nên đổi thành:

```ts
interface RecentBotSend {
  threadId: string;
  actionId?: string;
  text: string;
  normalizedText: string;
  sentAt: number;
  confirmedAt?: number;
  confirmedMessageRef?: string;
}

private recentBotSends =
  new Map<string, RecentBotSend[]>();
```

Mọi lookup:

```ts
recentBotSends.get(threadId)
```

Không fuzzy-match outbound của thread A với inbound của thread B.

---

# 9. P0 — TTL prune ở mọi lookup

Helper duy nhất:

```ts
private getRecentBotSends(threadId: string, now = Date.now()) {
  const ttlMs = 120_000;
  const alive = (this.recentBotSends.get(threadId) ?? [])
    .filter(item => now - item.sentAt <= ttlMs);

  this.recentBotSends.set(threadId, alive);
  return alive;
}
```

Dùng ở:

```text
anti-echo
external-human-outbound detection
verification
reconciliation
```

Không để cache cũ tồn tại chỉ vì chưa có code path khác prune nó.

---

# 10. P0 — Không remember bot sent ở đầu `typeDraft()`

Hiện cache text bot được thêm ngay khi bắt đầu gõ.

Case lỗi:

```text
typeDraft("Dạ còn hàng nha")
→ cache bot text
→ khách gửi tin mới
→ typing bị abort
→ bot chưa Enter
→ customer text giống draft
→ anti-echo có thể suppress
```

Đổi lifecycle:

```text
typeDraft()
→ không tạo confirmed-send cache

sendDraft()
→ tạo pending send marker nếu cần

verifySent() success
→ mới tạo confirmed bot-send record
```

Tách:

```ts
PendingBotSend
ConfirmedBotSend
```

Pending send **không được hard-suppress verified customer inbound**.

---

# 11. P0 — Loose fuzzy text không được làm hard suppression

Current matcher cho phép:

```text
substring
normalized substring
prefix 25 ký tự
emoji stripped
```

Matcher này hữu ích cho:

```text
outbound verification candidate
reconciliation candidate
```

nhưng không đủ an toàn để quyết định:

```text
customer message = bot echo → drop
```

Ví dụ:

```text
Bot: "Dạ sản phẩm này hiện tại còn hàng nha, mình lấy màu nào ạ?"
Customer: "còn hàng"
```

Đó là inbound thật.

Rule:

```text
fuzzy match → UNKNOWN
```

không:

```text
fuzzy match → BOT_CONFIRMED
```

Có thể tạo matcher mạnh riêng:

```ts
strongBotEchoMatch(expected, actual)
```

với exact normalized text hoặc similarity rất cao trên full message.

---

# 12. Verified sender phải thắng text heuristic

Pseudo:

```ts
if (
  !bubble.isOutgoing &&
  bubble.senderKind === "PERSON" &&
  bubble.senderReliability === "VERIFIED" &&
  bubble.senderId &&
  bubble.senderId !== botParticipantId
) {
  return {
    kind: "CUSTOMER_CONFIRMED",
    confidence: "STRONG",
    evidence: ["DOM_INCOMING", "VERIFIED_PERSON_SENDER"],
  };
}
```

Đặt trước fuzzy matching.

---

# 13. P0 — UNKNOWN không được mark seen vĩnh viễn

Không làm:

```ts
lastSeenMessageIds.add(id);
confirmedOutboundMessageIds.add(id);
```

cho UNKNOWN.

Flow:

```text
UNKNOWN
→ pending observation
→ retry 1
→ retry 2
→ retry 3
```

Sau đó:

```text
BOT_CONFIRMED
→ suppress

CUSTOMER_CONFIRMED
→ emit inbound

vẫn UNKNOWN
→ persist diagnostic observation / TRACK_NO_REPLY
→ không silently disappear
```

---

# 14. Pending unknown structure

```ts
interface PendingUnknownBubble {
  threadId: string;
  bubbleId: string;
  textHash: string;
  firstSeenAt: number;
  lastSeenAt: number;
  attempts: number;
}
```

TTL khoảng:

```text
30–60 giây
```

Nếu vẫn không xác định:

```text
MESSAGE_ORIGIN_UNCERTAIN
```

event/incident.

---

# 15. P0 thứ hai — SEND_UNCERTAIN vẫn có đường lockout

Commit mới đã cố phân biệt:

```text
REVIEW_HOLD + SEND_UNCERTAIN
```

là technical hold chứ không phải human takeover.

Đây là hướng đúng.

Nhưng caller trong `ConversationRepository.ingestInboundMessage()` hiện có:

```ts
if (
  existingConvRow &&
  options?.autoResumeAfterHuman !== false
) {
  await normalizeForInbound(...);
}
```

Nếu config:

```text
autoResumeAfterHuman=false
```

thì normalize không chạy luôn.

Kết quả technical hold có thể không được giải dù service đã có logic cho nó.

### Fix

Luôn gọi service:

```ts
if (existingConvRow) {
  await this.controlService.normalizeForInbound(
    existingConvRow.id,
    now,
    {
      autoResumeAfterHuman: options?.autoResumeAfterHuman,
    }
  );
}
```

Service tự quyết:

```text
HUMAN_PINNED
→ preserve

HUMAN_SESSION + autoResume=false
→ preserve

REVIEW_HOLD/SEND_UNCERTAIN
→ technical recovery rule
```

---

# 16. P0 — New inbound phải được persist dù old outbound uncertain

Invariant:

```text
old outbound uncertainty
≠ permission to lose new customer inbound
```

Message mới nên:

```text
persist
→ increment inbound version
→ record eligibility
```

Sau đó mới quyết định:

```text
AUTO process
human hold
technical hold
TRACK_NO_REPLY
```

Không drop ở observer.

---

# 17. P0 — Không auto-CONFIRM SEND_UNCERTAIN chỉ vì có message sau đó

Current reconciler có logic gần như:

```text
SEND_UNCERTAIN
+
có bất kỳ messages row nào sau action.createdAt
→ CONFIRMED
```

Điều này overclaim delivery.

Ví dụ:

```text
bot Enter
→ verification timeout
→ customer gửi "alo?"
```

Customer tiếp tục chat **không chứng minh** bot message trước đã đến nơi.

Tách:

```text
delivery truth
vs
operational unblock
```

Đề xuất state:

```text
RECONCILED_UNKNOWN
```

hoặc metadata:

```json
{
  "operationallyUnblocked": true,
  "reconcileEvidence": "THREAD_PROGRESS_OBSERVED"
}
```

Chỉ `CONFIRMED` khi có exact delivery evidence.

---

# 18. P0 — SEND_UNCERTAIN không suspend cả channel

Current reconcile path có thể:

```text
stale SEND_INTENT
→ SEND_UNCERTAIN
→ channel SUSPENDED
```

Một message của customer A vì vậy có thể làm:

```text
customer B/C/D đều không được bot xử lý
```

SEND_UNCERTAIN nên conversation-scoped:

```text
outbound action = SEND_UNCERTAIN
conversation = REVIEW_HOLD
incident = SEND_UNCERTAIN
channel = RUNNING
```

Chỉ suspend channel cho lỗi channel-wide:

```text
LOGIN_REQUIRED
CHECKPOINT
SESSION_INVALID
INBOX_UNAVAILABLE
global DOM break
account rate restriction
```

---

# 19. P0 — Manual reconcile không được release human takeover thật

Current condition MARK_SENT/RETRY quá rộng nếu release khi:

```text
mode === REVIEW_HOLD
OR reason === SEND_UNCERTAIN
OR reason === MANUAL_MODE_SET
```

Fix thành:

```ts
if (
  conv.mode === "REVIEW_HOLD" &&
  conv.reason === "SEND_UNCERTAIN"
) {
  releaseTechnicalReviewHold(...);
}
```

Không release:

```text
HUMAN_PINNED
HUMAN_SESSION
```

Human-first invariant:

```text
HUMAN_PINNED
→ explicit operator release only
```

---

# 20. Tách API control transition

Nên tránh một `release()` chung quá mạnh.

Tách:

```ts
releaseHumanControl(...)
releaseTechnicalReviewHold(...)
expireHumanSession(...)
```

Mỗi function có precondition/CAS riêng.

---

# 21. CAS toàn bộ control writer

Dùng:

```sql
UPDATE conversations
SET ...
WHERE
  id = $id
  AND control_epoch = $expectedEpoch
  AND reply_control_mode = $expectedMode
RETURNING *
```

Nếu zero row:

```text
reread state
→ re-evaluate
→ bounded retry
```

Áp dụng cho:

```text
acquire session
refresh session
acquire pinned
acquire draft
release
technical release
expiry
```

---

# 22. Bubble classifier đề xuất

```ts
async function classifyObservedBubble(
  bubble: ParsedBubble,
  ctx: BubbleContext
): Promise<ObservedBubbleOrigin> {
  if (
    !bubble.isOutgoing &&
    bubble.senderKind === "PERSON" &&
    bubble.senderReliability === "VERIFIED" &&
    bubble.senderId &&
    bubble.senderId !== ctx.botParticipantId
  ) {
    return customerConfirmed("VERIFIED_PERSON_SENDER");
  }

  if (
    bubble.id &&
    await outboundRepo.hasConfirmedExternalRef(
      ctx.channelAccountId,
      ctx.threadId,
      bubble.id
    )
  ) {
    return botConfirmed("EXACT_EXTERNAL_REF");
  }

  if (ctx.confirmedOutboundMessageIds.has(bubble.id)) {
    return botConfirmed("LOCAL_VERIFY_SENT");
  }

  if (
    bubble.isOutgoing &&
    await outboundRepo.matchesRecentConfirmedSendStrict({
      threadId: ctx.threadId,
      text: bubble.text,
      maxAgeMs: 120_000,
    })
  ) {
    return botConfirmed("DOM_OUTGOING_STRICT_TEXT");
  }

  return unknown("INSUFFICIENT_EVIDENCE");
}
```

---

# 23. Classifier phải read-only

Không để `isBotOutbound()`:

```text
classify
+
confirm SEND_UNCERTAIN
```

trong cùng function.

Tách:

```ts
classifyObservedBubble()       // read-only
reconcileObservedBotBubble()   // mutation
```

Giảm hidden side effects.

---

# 24. P1 — Observability theo từng stage

Mỗi message có trace:

```text
DOM_DETECTED
PARSED
ORIGIN_CLASSIFIED
INBOUND_EMITTED
INBOUND_PERSISTED
ELIGIBILITY_DECIDED
DEBOUNCE_ENQUEUED
AI_STARTED
AI_COMPLETED
OUTBOUND_CREATED
DELIVERY_CONFIRMED
```

Structured log:

```json
{
  "event": "bubble_origin_classified",
  "threadId": "thread-123",
  "bubbleId": "mid.xxx",
  "origin": "CUSTOMER_CONFIRMED",
  "confidence": "STRONG",
  "evidence": [
    "DOM_INCOMING",
    "VERIFIED_PERSON_SENDER"
  ],
  "textHash": "sha256:..."
}
```

Không cần log full customer text.

---

# 25. Metrics

```text
messenger_bubbles_observed_total
messenger_bubbles_customer_total
messenger_bubbles_bot_total
messenger_bubbles_origin_unknown_total
messenger_anti_echo_suppressed_total
messenger_inbound_emitted_total
messenger_inbound_persisted_total
messenger_inbound_dedupe_total
messenger_send_uncertain_total
messenger_send_uncertain_unblocked_total
```

---

# 26. Detect message disappear

Nếu:

```text
CUSTOMER_CONFIRMED
```

nhưng không có:

```text
INBOUND_PERSISTED
```

sau vài giây:

```text
error event
```

Nếu UNKNOWN quá lâu:

```text
warning/incident
```

Không silent.

---

# 27. Production debug checklist

Khi case xảy ra lại, kiểm tra:

```text
1. Log có "Anti-echo: Suppressed bot reply bubble" không?
2. BubbleId đó có phải tin khách thật không?
3. messages có row INBOUND mới không?
4. inbound_messages có sourceMessageId đó không?
5. conversation.inboundVersion tăng chưa?
6. eligibility decision được tạo chưa?
7. debounce job có chưa?
8. channel có SUSPENDED không?
9. replyControlMode có REVIEW_HOLD/HUMAN_* không?
10. outbound action trước đó có SEND_UNCERTAIN không?
```

Phân loại:

```text
DOM có nhưng DB không có
→ observer/anti-echo

DB có nhưng không debounce
→ policy/control

debounce có nhưng AI không chạy
→ job/claim/recheck
```

---

# 28. Mandatory regression tests

## T01 — reported case

```text
AI CONFIRMED
customer gửi text khác sau 5s
same thread
```

Expected:

```text
inbound callback exactly once
```

## T02–T05 — timing

Test customer reply sau:

```text
1s
5s
30s
59s
61s
```

Tất cả phải nhận đúng 1 lần.

## T06 — substring

```text
Bot: "Dạ shop còn hàng nha, mình muốn lấy màu nào?"
Customer: "còn hàng"
```

Expected customer.

## T07 — answer fragment

```text
Bot: "Bạn lấy màu trắng hay đen?"
Customer: "màu trắng"
```

Expected customer.

## T08 — quote bot text

Customer quote một phần reply cũ rồi viết thêm.

Expected customer.

## T09 — same exact phrase

```text
Bot: "ok"
Customer verified: "ok"
```

Expected customer vì verified identity thắng text.

## T10 — cross-thread

```text
thread A bot: "Còn hàng nha"
thread B customer: "Còn hàng nha"
```

Expected thread B customer.

## T11 — aborted draft

```text
typeDraft()
→ abort trước Enter
→ customer gửi text giống draft
```

Expected customer.

## T12 — exact bot echo

Exact confirmed message ref.

Expected suppressed.

## T13 — restart durable

Process restart, DB có exact confirmed ref.

Expected real bot echo suppressed.

## T14 — ref mismatch

DOM ref khác DB nhưng:

```text
DOM outgoing
same thread
strict full text
tight timestamp
```

Expected bot.

Nếu verified incoming PERSON thì expected customer.

## T15 — SEND_UNCERTAIN + autoResume false

```text
REVIEW_HOLD/SEND_UNCERTAIN
autoResumeAfterHuman=false
new verified customer inbound
```

Expected:

```text
persist inbound
technical hold operationally unblocked
debounce scheduled if otherwise eligible
```

## T16 — HUMAN_SESSION + autoResume false

Expected:

```text
persist inbound
no AI
human state preserved
```

## T17 — HUMAN_PINNED

Expected:

```text
persist inbound
no AI
HUMAN_PINNED preserved
```

## T18 — MARK_SENT while HUMAN_PINNED

Expected still HUMAN_PINNED.

## T19 — technical MARK_SENT

`REVIEW_HOLD/SEND_UNCERTAIN` + verified operator reconciliation.

Expected release technical hold.

## T20 — one uncertain conversation

Expected:

```text
channel remains RUNNING
other customers unaffected
```

## T21 — later customer message is not delivery proof

Expected:

```text
operational unblock may occur
old action MUST NOT become CONFIRMED solely from later inbound
```

## T22 — exact bot bubble later found

Expected CONFIRMED.

---

# 29. Browser acceptance sequence

Synthetic/Playwright DOM sequence:

```text
Snapshot 1:
customer A

Snapshot 2:
customer A
bot B

Snapshot 3:
customer A
bot B
customer C
```

Assert:

```text
A emitted once
B never emitted inbound
C emitted once
```

Run variants:

```text
C after 1s
C after 5s
C after 30s
C same phrase
C substring
C emoji
C quote
```

---

# 30. PostgreSQL acceptance

Sau customer C:

```text
✓ inbound_messages row exists
✓ messages direction=INBOUND exists
✓ conversation.inboundVersion increments
✓ eligibility decision exists
✓ debounce job exists if eligible
✓ AI turn/run eventually starts
```

Không chỉ unit-test matcher.

---

# 31. Sửa test sai hiện tại

Thay assumption:

```text
same thread + recent AI = BOT
```

bằng:

```text
same thread + recent AI + unrelated/unknown bubble
= insufficient evidence
```

Thêm explicit test:

```text
recent AI CONFIRMED 5s ago
+
new verified customer bubble in same thread
=
CUSTOMER_CONFIRMED
```

---

# 32. CI gate

Giữ Production Acceptance là mandatory gate và bổ sung suite mới:

```text
browser anti-echo regression
PostgreSQL inbound-after-outbound
SEND_UNCERTAIN isolation
human control preservation
```

Green CI chỉ có ý nghĩa khi các case này nằm trong suite.

---

# 33. Thứ tự commit đề xuất

### Commit 1

```text
fix(browser): remove same-thread-only bot echo classification
```

### Commit 2

```text
fix(browser): classify observed bubble origin by strong evidence
```

### Commit 3

```text
fix(browser): scope bot send cache by thread and verified delivery
```

### Commit 4

```text
fix(control): unblock technical send hold without releasing human control
```

### Commit 5

```text
fix(reconcile): isolate send uncertainty to conversation
```

### Commit 6

```text
fix(delivery): separate thread progress from delivery confirmation
```

### Commit 7

```text
feat(observability): trace messenger bubble lifecycle
```

### Commit 8

```text
test(browser): cover post-bot customer reply anti-echo regressions
```

### Commit 9

```text
test(postgres): cover inbound recovery after send uncertainty
```

---

# 34. Definition of Done

Chỉ đóng issue khi:

```text
✓ customer reply sau bot 1s nhận đúng 1 lần
✓ sau 5s nhận đúng 1 lần
✓ sau 30s nhận đúng 1 lần
✓ sau 59–60s nhận đúng 1 lần
✓ same phrase vẫn nhận khi sender verified customer
✓ substring/quote không bị anti-echo nuốt
✓ cache không match chéo thread
✓ aborted draft không poison cache
✓ real bot echo không ingest inbound
✓ restart vẫn suppress exact bot echo
✓ UNKNOWN không silently disappear
✓ every valid customer inbound được persisted
✓ inboundVersion tăng
✓ debounce được tạo khi eligible
✓ SEND_UNCERTAIN không suspend cả channel
✓ technical hold có recovery đúng
✓ HUMAN_PINNED không bị reconcile release
✓ HUMAN_SESSION tôn trọng autoResumeAfterHuman=false
✓ later inbound không bị dùng làm proof CONFIRMED
✓ exact delivery evidence mới set CONFIRMED
✓ browser acceptance pass
✓ PostgreSQL acceptance pass
✓ deploy gate pass
```

---

# 35. Kết luận

Không nên tiếp tục vá anti-echo bằng nhiều fuzzy rule hơn.

Nguyên tắc cần khóa lại là:

```text
NOT CERTAIN BOT
→ DO NOT DROP
```

và:

```text
VERIFIED CUSTOMER
→ PERSIST FIRST
→ POLICY LATER
```

`SEND_UNCERTAIN` cũng phải là vấn đề của đúng conversation đó, không biến thành lý do dừng toàn bộ channel.

Đây là hướng sửa triệt để nhất cho symptom:

> **bot vừa trả lời xong, khách nhắn tiếp nhưng hệ thống không nhận và AI không chạy nữa.**
