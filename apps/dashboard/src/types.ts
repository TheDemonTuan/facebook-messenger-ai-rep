export type UserRole = "OWNER" | "OPERATOR" | "VIEWER";

export interface SessionUser {
  id: string;
  email: string;
  role: UserRole;
  name?: string | null;
}

export interface ChannelOverview {
  channelStatus: "RUNNING" | "PAUSED" | "SUSPENDED" | "DEGRADED" | "ERROR";
  channelIsSuspended: boolean;
  channelIsPaused: boolean;
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
}

export interface ConversationItem {
  conversation: {
    id: string;
    status: string;
    inboundVersion: number;
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
    unreadCount: number;
    isBlocked: boolean;
    manualMode: boolean;
    claimedAt?: string | null;
    claimToken?: string | null;
  };
  customer: {
    id: string;
    name: string | null;
    avatarUrl: string | null;
  };
}

export interface MessageItem {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  actor: "AI" | "MANUAL_OWNER" | "SYSTEM";
  text: string;
  inboundVersion: number;
  responseIndex: number;
  timestamp: string;
}

export type OutboundActionStatus =
  | "PENDING"
  | "TYPING"
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
}

export interface SettingItem {
  settings: NonSecretSettings & Record<string, unknown>;
  aiProvider: AiProviderSettings;
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
    customerId: string;
    externalThreadId: string;
    externalThreadRef: string;
    inboundVersion: number;
    lastInboundAt: string | null;
    lastOutboundAt: string | null;
    status: string;
    isBlocked: boolean;
    manualMode: boolean;
    unreadCount: number;
    summary?: string | null;
    summaryVersion?: number;
    claimedAt?: string | null;
    claimToken?: string | null;
  };
  customer: {
    id: string;
    externalId: string;
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
