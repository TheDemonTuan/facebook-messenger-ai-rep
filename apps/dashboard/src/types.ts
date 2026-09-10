export type UserRole = "OWNER" | "OPERATOR" | "VIEWER";

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface SessionUser {
  id: string;
  email: string;
  role: UserRole;
  name?: string | null;
}

export interface ChannelOverview {
  channelStatus: "RUNNING" | "PAUSED" | "SUSPENDED" | "DEGRADED" | "ERROR";
  channelStatusReason?: string | null;
  channelIsSuspended: boolean;
  channelIsPaused: boolean;
  channelLastHealthCheckAt?: string | null;
  channelLastSeenActiveAt?: string | null;
  activeConversation: {
    id: string;
    status: string;
    externalThreadId: string;
    inboundVersion?: number;
    claimedAt: string | null;
  } | null;
  queueLength: number;
  oldestWaitSeconds: number;
  estimatedWaitSeconds: number;
  todayConversationsCount: number;
  todayMessagesCount: number;
  openIncidentsCount: number;
  businessTimeZone?: string;
}

export interface ConversationItem {
  conversation: {
    id: string;
    externalThreadId?: string;
    status: string;
    threadKind?: string;
    inboundVersion: number;
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
    unreadCount: number;
    isBlocked: boolean;
    manualMode: boolean;
    replyControlMode?: string | null;
    controlReason?: string | null;
    humanHoldUntil?: string | null;
    title?: string | null;
    claimedAt?: string | null;
    claimToken?: string | null;
  };
  customer: {
    id: string;
    name: string | null;
    avatarUrl: string | null;
    externalCustomerId?: string | null;
  };
  latestInboundMessage?: {
    id?: string;
    text: string;
    timestamp: string;
    parts?: MessagePart[];
    contentStatus?: ContentStatus;
    contentRevision?: number;
    eventKind?: string;
    timestampProvenance?: string;
    timestampPrecision?: string;
    skipReason?: SkipReasonInfo | null;
    replyDecision?: ReplyDecisionInfo | null;
  } | null;
}

export type ContentStatus =
  | "PENDING"
  | "READY"
  | "PARTIAL"
  | "UNAVAILABLE"
  | "UNSUPPORTED"
  | "QUARANTINED";

export type MediaRole = "ATTACHMENT" | "SHARE_PREVIEW" | "VIDEO_POSTER";

export interface MediaRef {
  mediaId: string;
  role?: MediaRole;
  mimeType?: string;
  byteSize?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  status?: ContentStatus;
  sourceUrl?: string;
  storagePath?: string;
  thumbnailRef?: string;
  fileName?: string;
}

export interface TextPart {
  type: "TEXT";
  text: string;
}

export interface ImagePart {
  type: "IMAGE";
  media: MediaRef;
  altText?: string;
}

export interface VoicePart {
  type: "VOICE";
  media: MediaRef;
  transcriptRef?: string;
  durationMs?: number;
}

export interface AudioPart {
  type: "AUDIO";
  media: MediaRef;
  transcriptRef?: string;
  durationMs?: number;
}

export interface VideoPart {
  type: "VIDEO";
  media: MediaRef;
  posterRef?: string;
  analysisRef?: string;
  durationMs?: number;
}

export interface StickerPart {
  type: "STICKER";
  label?: string;
  media?: MediaRef;
}

export interface GifPart {
  type: "GIF";
  media: MediaRef;
}

export interface SharePart {
  type: "SHARE";
  origin?: "FACEBOOK_GROUP" | "FACEBOOK_POST" | "REEL" | "EXTERNAL" | "UNKNOWN";
  url?: string;
  title?: string;
  previewText?: string;
  previewMedia?: MediaRef;
  access?: "PREVIEW_ONLY" | "READABLE" | "UNAVAILABLE" | "UNKNOWN";
}

export interface FilePart {
  type: "FILE";
  media: MediaRef;
  fileName?: string;
  byteSize?: number;
}

export interface LocationPart {
  type: "LOCATION";
  label?: string;
  latitude?: number;
  longitude?: number;
}

export interface ContactPart {
  type: "CONTACT";
  displayName?: string;
  normalizedFields?: Record<string, string>;
}

export interface UnknownPart {
  type: "UNKNOWN";
  observedLabel?: string;
}

export type MessagePart =
  | TextPart
  | ImagePart
  | VoicePart
  | AudioPart
  | VideoPart
  | StickerPart
  | GifPart
  | SharePart
  | FilePart
  | LocationPart
  | ContactPart
  | UnknownPart;

export interface MessageTimeDetail {
  eventAt?: string | null;
  observedAt?: string | null;
  displayAt?: string | null;
  source?: "FACEBOOK_EVENT" | "OBSERVED" | "SYSTEM" | "UNKNOWN";
  precision?: "MILLISECOND" | "SECOND" | "MINUTE" | "APPROXIMATE" | "UNKNOWN" | string;
  rawLabel?: string;
}

export interface ReplyDecisionInfo {
  action: "SKIP" | "DEFER" | "GENERATE" | "CLARIFY" | "HANDOFF";
  reasonCode: string;
  displayLabel: string;
}

export interface NormalizationInfo {
  parserVersion?: string;
  identityQuality?: "VERIFIED" | "UNVERIFIED";
  directionQuality?: "VERIFIED" | "UNVERIFIED";
  parseQuality?: "VERIFIED" | "PARTIAL" | "UNVERIFIED";
  warnings?: string[];
}

export interface SkipReasonInfo {
  decision: "ELIGIBLE" | "INELIGIBLE";
  eligible: boolean;
  reasonCode: string;
  reason: string;
  humanReadableReason: string;
  precedenceStep: string;
  evaluationMode?: "LIVE" | "SHADOW";
}

export interface MessageItem {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  actor: "AI" | "MANUAL_OWNER" | "SYSTEM";
  text: string;
  inboundVersion: number;
  responseIndex: number;
  timestamp: string;
  senderName?: string | null;
  avatarUrl?: string | null;
  senderKind?: string;
  isVerified?: boolean;
  skipReason?: SkipReasonInfo | null;
  // PR-03/PR-04 rich content fields
  parts?: MessagePart[];
  contentStatus?: ContentStatus;
  contentRevision?: number;
  eventKind?: string;
  time?: MessageTimeDetail;
  replyDecision?: ReplyDecisionInfo | null;
  normalization?: NormalizationInfo;
  eventTimestamp?: string | Date | null;
  observedTimestamp?: string | Date | null;
  timestampProvenance?: string;
  timestampPrecision?: string;
}

export type OutboundActionStatus =
  | "PENDING"
  | "TYPING"
  | "SEND_INTENT"
  | "CONFIRMED"
  | "RETRY_APPROVED"
  | "SENDING"
  | "SENT"
  | "ABORTED"
  | "UNCONFIRMED"
  | "SEND_UNCERTAIN"
  | "FAILED";

export interface OutboundActionItem {
  id: string;
  actionId: string;
  inboundVersion: number;
  responseIndex: number;
  text: string;
  actor: string;
  status: OutboundActionStatus;
  unconfirmedReason: string | null;
  errorMessage: string | null;
  createdAt: string;
  sourceAiRunId?: string | null;
  startedSendingAt?: string | null;
  confirmedAt?: string | null;
}

export interface ConversationEventItem {
  id: string;
  type: string;
  inboundVersion?: number | null;
  actor?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt: string;
}

export interface TurnTraceData {
  conversationId: string;
  inboundVersion: number;
  turn?: Record<string, unknown> | null;
  inboundMessages?: MessageItem[];
  aiRuns?: AiRunItem[];
  drafts?: Array<{
    id: string;
    inboundVersion: number;
    aiRunId: string;
    messages: string[];
    createdAt: string;
  }>;
  outboundActions?: OutboundActionItem[];
  events?: ConversationEventItem[];
  completeness: {
    messages: "AVAILABLE" | "PARTIAL" | "EXPIRED" | "NOT_CAPTURED";
    aiRuns: "AVAILABLE" | "PARTIAL" | "EXPIRED" | "NOT_CAPTURED";
    snapshots: "AVAILABLE" | "PARTIAL" | "EXPIRED" | "NOT_CAPTURED";
    delivery: "AVAILABLE" | "PARTIAL" | "EXPIRED" | "NOT_CAPTURED";
  };
}

export interface QueueItem {
  queueId: string;
  conversationId: string;
  customerName: string | null;
  queuedAt: string;
  readyAt: string;
  inboundVersion: number;
  attempt: number;
  isSticky: boolean;
  stickyTurns: number;
  yieldRequired: boolean;
  position: number;
  estimatedWaitSeconds: number;
}

export type JobStatus =
  | "READY"
  | "RUNNING"
  | "RETRY_WAIT"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export interface JobItem {
  id: string;
  channelAccountId: string;
  queue: string;
  jobType: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  priority: number;
  attempts: number;
  maxAttempts: number;
  availableAt: string;
  lockedUntil: string | null;
  ownerToken: string | null;
  fencingEpoch: number;
  idempotencyKey: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IncidentItem {
  id: string;
  type: string; // SEND_UNCERTAIN | CHECKPOINT | DOM_CHANGED | DOM_DEGRADED | UNCONFIRMED_SEND | ...
  status: "OPEN" | "ACKNOWLEDGED" | "RESOLVED";
  title: string;
  description: string;
  metadata?: {
    actionId?: string;
    outboundActionId?: string;
    textHash?: string;
    inboundVersion?: number;
    responseIndex?: number;
    reason?: string;
    error?: string;
    promptHash?: string | null;
    responseHash?: string | null;
    model?: string;
    [key: string]: unknown;
  } | null;
  conversationId?: string | null;
  outboundActionId?: string | null;
  resolutionNote?: string | null;
  resolvedBy?: string | null;
  resolvedAt?: string | null;
  createdAt: string;
}

export interface AiRunItem {
  id: string;
  channelAccountId: string;
  conversationId: string;
  conversationTitle?: string | null;
  customerName?: string | null;
  customerAvatarUrl?: string | null;
  inboundVersion: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  status: "SUCCESS" | "GUARD_REJECTED" | "ERROR" | "STALE_ABORTED";
  promptHash?: string | null;
  responseHash?: string | null;
  requestSnapshot?: {
    apiFormat?: "OPENAI_COMPATIBLE" | "ANTHROPIC_COMPATIBLE";
    endpoint?: string;
    method?: string;
    model?: string;
    payload?: unknown;
    [key: string]: unknown;
  } | null;
  responseSnapshot?: {
    status?: number;
    raw?: unknown;
    content?: string | null;
    error?: string;
    [key: string]: unknown;
  } | null;
  usedResult?: {
    messages?: string[];
    needsClarification?: boolean;
    [key: string]: unknown;
  } | null;
  parsedOutput: {
    messages?: string[];
    needsClarification?: boolean;
    messageCount?: number;
    [key: string]: unknown;
  } | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface AiProviderSettings {
  apiFormat: "OPENAI_COMPATIBLE" | "ANTHROPIC_COMPATIBLE";
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
}

export interface PolicyMemberItem {
  id: string;
  personId?: string;
  displayName: string;
  name?: string;
  avatarUrl: string | null;
  senderKind?: string;
  type?: string;
  policyMode: "EXCLUDE" | "INCLUDE";
  notes?: string | null;
  conversationContext?: string;
}

export interface SafePersonItem {
  id: string;
  personId: string;
  name: string;
  rawName?: string;
  avatarUrl: string | null;
  type: string;
  isVerified: boolean;
  conversationContext: string;
  duplicateContext?: string;
  policyMode?: "EXCLUDE" | "INCLUDE" | null;
}

export interface NonSecretSettings {
  debounceMs: number;
  stickyWindowMs: number;
  stickyMaxTurns: number;
  stickyMaxDurationMs: number;
  aiModel: string;
  aiTimeoutMs: number;
  aiMaxResponseCount: number;
  aiTotalMaxChars: number;
  aiSystemPersona: string;
  businessProfile: string;
  typingTargetWpmMin: number;
  typingTargetWpmMax: number;
  busyMode: boolean;
  autoReplyEnabled: boolean;
  pauseIntakeProcessing: boolean;
  businessTimeZone?: string;
  replyMode?: "EVERYONE_EXCEPT" | "ONLY_SELECTED";
  directRepliesEnabled?: boolean;
  groupRepliesEnabled?: boolean;
  pageRepliesEnabled?: boolean;
  nonPersonRepliesEnabled?: boolean;
  requireGroupMention?: boolean;
  selectedParticipantIds?: string[];
  excludedParticipantIds?: string[];
  humanHandoffEnabled?: boolean;
  humanOutboundGraceMs?: number;
  humanInboundResponseWaitMs?: number;
  humanDraftLeaseMs?: number;
  humanSessionMaxMs?: number;
  autoResumeAfterHuman?: boolean;
  persistenceMode?: "ELIGIBLE_ONLY" | "ALL_OBSERVED";
  persistExcludedInbound?: boolean;
  persistDropTelemetry?: boolean;
}

export interface SettingItem {
  settings: NonSecretSettings & Record<string, unknown>;
  aiProvider: AiProviderSettings;
  revision: number;
  policyMembers?: PolicyMemberItem[];
}

export interface SettingsUpdateResult {
  settings: NonSecretSettings & Record<string, unknown>;
  revision: number;
}

export interface PaginatedInboxResponse {
  conversations: ConversationItem[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface ConversationDetailData {
  conversation: {
    id: string;
    channelAccountId: string;
    customerId?: string | null;
    externalThreadId?: string;
    externalThreadRef?: string;
    inboundVersion: number;
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
    status: string;
    threadKind?: string;
    title?: string | null;
    isBlocked: boolean;
    manualMode: boolean;
    replyControlMode?: string | null;
    controlReason?: string | null;
    humanHoldUntil?: string | null;
    unreadCount: number;
    summary?: string | null;
    summaryVersion?: number;
    claimedAt?: string | null;
    claimToken?: string | null;
  };
  customer: {
    id: string;
    externalId?: string;
    name: string | null;
    avatarUrl: string | null;
  };
  messages: MessageItem[];
  nextMessageCursor?: string | null;
  hasMoreMessages?: boolean;
  aiRuns: AiRunItem[];
  outboundActions: OutboundActionItem[];
  events: Array<{
    id: string;
    type: string;
    inboundVersion: number | null;
    actor: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }>;
}

export interface WorkflowNodeMetric {
  label: string;
  value: string;
}

export interface WorkflowNode {
  id: string;
  step: number;
  name: string;
  subtitle: string;
  category: "intake" | "queue" | "safety" | "ai" | "sender" | "delivery";
  status: "idle" | "active" | "waiting" | "completed" | "error";
  activity: string;
  metrics: WorkflowNodeMetric[];
  details: Record<string, unknown>;
}

export interface WorkflowLiveData {
  channel: {
    status: string;
    isSuspended: boolean;
    isPaused: boolean;
    statusReason: string | null;
  };
  activeStage: "IDLE" | "INBOUND" | "DEBOUNCE" | "POLICY" | "AI_THINKING" | "GUARDS" | "TYPING" | "VERIFYING_SEND" | "ERROR" | "PAUSED";
  waitingReason: string;
  activeConversation: {
    id: string;
    title: string;
  } | null;
  openIncidents: Array<{
    id: string;
    title: string;
    type: string;
  }>;
  nodes: WorkflowNode[];
  latestTrace: {
    inboundText: string | null;
    inboundTime: string | null;
    aiModel: string | null;
    aiLatencyMs: number | null;
    outboundText: string | null;
    outboundStatus: string | null;
    confirmedAt: string | null;
  };
}
