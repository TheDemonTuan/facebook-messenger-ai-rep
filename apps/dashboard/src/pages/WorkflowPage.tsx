import React, { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import "./WorkflowPage.css";
import {
  useWorkflowData,
} from "../features/workflow/useWorkflowData";
import {
  stateLabels,
  eventLabel,
  formatTime,
  shortStatus,
  itemNeedsAttention,
  itemIsActive,
  type WorkflowStageId,
  type WorkflowStage,
} from "../features/workflow/model";
import {
  RefreshCw,
  Pause,
  Play,
  Inbox,
  Activity,
  AlertTriangle,
  ShieldCheck,
  Layers,
  Sparkles,
  Keyboard,
  Send,
  HelpCircle,
  Search,
  ExternalLink,
  Copy,
  Check,
  AlertCircle,
} from "lucide-react";

function getStageIcon(stageId: WorkflowStageId, size = 16) {
  switch (stageId) {
    case "inbound":
      return <Inbox size={size} />;
    case "policy":
      return <ShieldCheck size={size} />;
    case "debounce":
      return <Layers size={size} />;
    case "ai":
      return <Sparkles size={size} />;
    case "typing":
      return <Keyboard size={size} />;
    case "delivery":
      return <Send size={size} />;
    default:
      return <Activity size={size} />;
  }
}

function getInitials(name: string): string {
  const clean = name.trim();
  if (!clean) return "KH";
  const parts = clean.split(/\s+/);
  if (parts.length === 1) return Array.from(parts[0])[0]?.toUpperCase() || "KH";
  const first = Array.from(parts[parts.length - 2])[0] || "";
  const second = Array.from(parts[parts.length - 1])[0] || "";
  return (first + second).toUpperCase();
}

export const WorkflowPage: React.FC = () => {
  const {
    conversations,
    selectedConversationId,
    setSelectedConversationId,
    selectedStageId,
    setSelectedStageId,
    selectedVersion,
    setSelectedVersion,
    viewData,
    listLoading,
    detailLoading,
    error,
    query,
    setQuery,
    filter,
    setFilter,
    tab,
    setTab,
    isPaused,
    togglePause,
    refresh,
    notice,
    setNotice,
  } = useWorkflowData();

  const [copied, setCopied] = useState(false);

  // Filter conversations based on query and filter tab
  const filteredConversations = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("vi");
    return conversations.filter((item) => {
      const name = (item.customer?.name || item.conversation?.title || "").toLocaleLowerCase("vi");
      const lastText = (item.latestInboundMessage?.text || "").toLocaleLowerCase("vi");
      const matchQuery = !q || name.includes(q) || lastText.includes(q);
      if (!matchQuery) return false;

      if (filter === "active") return itemIsActive(item);
      if (filter === "attention") return itemNeedsAttention(item);
      return true;
    });
  }, [conversations, query, filter]);

  const activeCount = useMemo(
    () => conversations.filter(itemIsActive).length,
    [conversations]
  );

  const attentionCount = useMemo(
    () => conversations.filter(itemNeedsAttention).length,
    [conversations]
  );

  const currentStage: WorkflowStage | undefined = useMemo(() => {
    if (!viewData) return undefined;
    return (
      viewData.stages.find((s) => s.id === selectedStageId) ||
      viewData.stages[0]
    );
  }, [viewData, selectedStageId]);

  const handleCopyCorrelationKey = async () => {
    if (!viewData?.correlationKey) return;
    try {
      await navigator.clipboard.writeText(viewData.correlationKey);
      setCopied(true);
      setNotice("Đã sao chép mã lượt.");
      setTimeout(() => {
        setCopied(false);
        setNotice(null);
      }, 2500);
    } catch {
      setNotice("Mã lượt: " + viewData.correlationKey);
    }
  };

  return (
    <div className="wf">
      {/* Header */}
      <header className="wf-heading">
        <div>
          <div className="wf-eyebrow">Giám sát thời gian thực</div>
          <h1>Theo dõi trả lời</h1>
          <p>
            Tiến trình một khách · đúng lượt · từ lúc nhận đến khi xác nhận gửi trên Messenger
          </p>
        </div>
        <div className="wf-toolbar">
          <button
            className="wf-button"
            onClick={refresh}
            disabled={listLoading || detailLoading}
            title="Tải lại danh sách và lượt hiện tại"
          >
            <RefreshCw size={14} className={listLoading ? "animate-spin" : ""} />
            Làm mới
          </button>
          <button
            className={`wf-button ${isPaused ? "primary" : ""}`}
            onClick={togglePause}
            title={isPaused ? "Bấm để tiếp tục cập nhật màn hình" : "Bấm để dừng cập nhật màn hình (không dừng bot)"}
          >
            {isPaused ? <Play size={14} /> : <Pause size={14} />}
            {isPaused ? "Tiếp tục cập nhật" : "Dừng cập nhật"}
          </button>
        </div>
      </header>

      {/* Notice Banner */}
      {notice && (
        <div className="wf-notice" role="alert">
          <span>{notice}</span>
          <button
            className="wf-filter"
            style={{ padding: "2px 6px" }}
            onClick={() => setNotice(null)}
          >
            Đóng
          </button>
        </div>
      )}

      {/* Error Alert */}
      {error && (
        <div className="wf-warning wf-error" role="alert">
          <AlertCircle size={16} />
          <div>{error}</div>
        </div>
      )}

      {/* Stats Cards */}
      <section className="wf-stats" aria-label="Thống kê hội thoại">
        <div className="wf-stat">
          <div>
            <strong>{conversations.length}</strong>
            <span>Hội thoại đã tải</span>
          </div>
          <div className="wf-stat-icon">
            <Inbox size={20} />
          </div>
        </div>
        <div className="wf-stat">
          <div>
            <strong>{activeCount}</strong>
            <span>Đang trong luồng</span>
          </div>
          <div className="wf-stat-icon">
            <Activity size={20} />
          </div>
        </div>
        <div className="wf-stat">
          <div>
            <strong>{attentionCount}</strong>
            <span>Cần kiểm tra</span>
          </div>
          <div className="wf-stat-icon">
            <AlertTriangle size={20} />
          </div>
        </div>
      </section>

      {/* 3-Column Workspace */}
      <div className="wf-workspace">
        {/* Left Column: Conversation List */}
        <aside className="wf-sidebar" aria-label="Danh sách hội thoại">
          <div className="wf-panel-head">
            <h3>Hội thoại</h3>
            <span className="wf-muted">
              {filteredConversations.length}/{conversations.length}
            </span>
          </div>

          <div className="wf-search">
            <Search size={14} />
            <input
              type="text"
              placeholder="Tìm theo tên hoặc nội dung tin..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Tìm theo tên hoặc nội dung tin"
            />
          </div>

          <div className="wf-filters" role="group" aria-label="Bộ lọc hội thoại">
            <button
              className="wf-filter"
              aria-pressed={filter === "all"}
              onClick={() => setFilter("all")}
            >
              Tất cả ({conversations.length})
            </button>
            <button
              className="wf-filter"
              aria-pressed={filter === "active"}
              onClick={() => setFilter("active")}
            >
              Đang chạy ({activeCount})
            </button>
            <button
              className="wf-filter"
              aria-pressed={filter === "attention"}
              onClick={() => setFilter("attention")}
            >
              Cần xem ({attentionCount})
            </button>
          </div>

          <div className="wf-list">
            {listLoading && conversations.length === 0 ? (
              <div className="wf-empty">Đang tải danh sách...</div>
            ) : filteredConversations.length === 0 ? (
              <div className="wf-empty">Không có hội thoại phù hợp.</div>
            ) : (
              filteredConversations.map((item) => {
                const id = item.conversation.id;
                const name = item.customer?.name || item.conversation?.title || "Khách hàng Messenger";
                const isSelected = selectedConversationId === id;
                const needsAtt = itemNeedsAttention(item);
                const isActive = itemIsActive(item);
                const previewText = item.latestInboundMessage?.text || "Chưa có tin nhắn mới";

                return (
                  <button
                    key={id}
                    className="wf-person"
                    aria-pressed={isSelected}
                    onClick={() => setSelectedConversationId(id)}
                  >
                    <div className="wf-person-line">
                      <span className="wf-avatar">{getInitials(name)}</span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div className="wf-person-name">{name}</div>
                        <div className="wf-person-sub">
                          {shortStatus(item.conversation.status, item.conversation.manualMode)}
                        </div>
                      </div>
                      <span
                        className={`wf-dot ${
                          needsAtt ? "warning" : isActive ? "active" : ""
                        }`}
                        title={
                          needsAtt
                            ? "Hội thoại có lỗi hoặc bị chặn"
                            : isActive
                            ? "Đang trong luồng xử lý"
                            : "Bình thường"
                        }
                      />
                    </div>
                    <div className="wf-person-preview">{previewText}</div>
                  </button>
                );
              })
            )}
          </div>
        </aside>

        {/* Center Column: Workflow Timeline & Details */}
        <main className="wf-main">
          {detailLoading && !viewData ? (
            <div className="wf-skeleton" />
          ) : !viewData ? (
            <section className="wf-panel wf-current">
              <div className="wf-empty">
                Chọn một hội thoại bên trái để xem tiến trình xử lý.
              </div>
            </section>
          ) : (
            <>
              {/* Current Conversation Banner */}
              <section className="wf-panel wf-current">
                <div className="wf-current-top">
                  <div className="wf-person-line">
                    <span className="wf-avatar">{getInitials(viewData.name)}</span>
                    <div>
                      <h2>{viewData.name}</h2>
                      <div className="wf-muted">
                        Messenger · Lượt #{viewData.version}{" "}
                        {!viewData.current && "(Lượt lịch sử)"}
                      </div>
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {viewData.versions.length > 1 ? (
                      <select
                        className="wf-version-select"
                        value={viewData.version}
                        onChange={(e) => setSelectedVersion(Number(e.target.value))}
                        aria-label="Chọn lượt xử lý"
                      >
                        {viewData.versions.map((v) => (
                          <option key={v} value={v}>
                            Lượt #{v} {v === viewData.versions[0] ? "(Mới nhất)" : ""}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="wf-version">Lượt mới nhất</span>
                    )}
                  </div>
                </div>

                <span className={`wf-chip ${viewData.tone}`}>
                  {stateLabels[viewData.tone]}
                </span>

                <h2 className="wf-current-title">{viewData.title}</h2>

                <p className="wf-current-description">
                  {viewData.hasUncertain
                    ? "Chưa chắc tin đã gửi. Cần kiểm tra đối soát trước khi thử lại."
                    : viewData.allExpectedConfirmed
                    ? "Đã có bằng chứng gửi xuất hiện trên Messenger. Không đồng nghĩa khách đã đọc."
                    : "Chọn một bước để xem nội dung, trạng thái và lý do đang chờ."}
                </p>

                <div className="wf-current-bottom">
                  <span className="wf-muted">
                    {viewData.current ? "Đang theo dõi lượt hiện tại" : `Đang xem lại lượt #${viewData.version}`}
                  </span>
                  <Link
                    to={`/inbox/${encodeURIComponent(viewData.conversationId)}`}
                    className="wf-button"
                  >
                    <ExternalLink size={13} />
                    Mở hội thoại
                  </Link>
                </div>
              </section>

              {/* Step-by-Step Flow */}
              <section className="wf-panel">
                <div className="wf-panel-head">
                  <h3>Hành trình trả lời</h3>
                  <span className="wf-muted">Đúng khách · đúng lượt</span>
                </div>

                <div className="wf-flow-wrap">
                  <div className="wf-flow">
                    {viewData.stages.map((stage) => {
                      const isSelected = currentStage?.id === stage.id;
                      return (
                        <button
                          key={stage.id}
                          className={`wf-stage ${stage.state}`}
                          aria-pressed={isSelected}
                          onClick={() => setSelectedStageId(stage.id)}
                        >
                          <span className="wf-stage-icon">
                            {getStageIcon(stage.id, 16)}
                          </span>
                          <strong>{stage.label}</strong>
                          <span>{stateLabels[stage.state]}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="wf-flow-note">
                  <HelpCircle size={12} />
                  Màu xám: chưa có bằng chứng, không phải đã hoàn tất.
                </div>
              </section>

              {/* Tabs: Messages & Responses vs Event Timeline */}
              <section className="wf-panel">
                <div className="wf-tabs" role="tablist">
                  <button
                    className="wf-tab"
                    role="tab"
                    aria-pressed={tab === "messages"}
                    onClick={() => setTab("messages")}
                  >
                    Tin nhắn & câu trả lời
                  </button>
                  <button
                    className="wf-tab"
                    role="tab"
                    aria-pressed={tab === "events"}
                    onClick={() => setTab("events")}
                  >
                    Nhật ký theo thời gian ({viewData.events.length})
                  </button>
                </div>

                {tab === "events" ? (
                  <ol className="wf-timeline">
                    {viewData.events.length === 0 ? (
                      <div className="wf-empty">Chưa có sự kiện nào cho lượt này.</div>
                    ) : (
                      viewData.events.map((e) => (
                        <li key={e.id}>
                          <time>{formatTime(e.createdAt)}</time>
                          <div>{eventLabel(e.type)}</div>
                        </li>
                      ))
                    )}
                  </ol>
                ) : (
                  <div className="wf-messages">
                    {viewData.messages.length === 0 ? (
                      <div className="wf-empty">Chưa có tin nhắn nào trong lượt này.</div>
                    ) : (
                      viewData.messages.map((m) => (
                        <article key={m.id} className="wf-message">
                          <div className="wf-message-meta">
                            <span>{viewData.name}</span>
                            <time>{formatTime(m.timestamp)}</time>
                          </div>
                          <div className="wf-bubble">{m.text}</div>
                          {m.skipReason && !m.skipReason.eligible && (
                            <div className="wf-output-note" style={{ textAlign: "left", color: "#a96b20" }}>
                              Kiểm tra: {m.skipReason.humanReadableReason}
                            </div>
                          )}
                        </article>
                      ))
                    )}

                    {viewData.actions.length > 0 ? (
                      viewData.actions.map((a, idx) => {
                        const isSent = ["CONFIRMED", "SENT"].includes(String(a.status));
                        const isUncertain = ["SEND_UNCERTAIN", "UNCONFIRMED"].includes(String(a.status));
                        const statusText = isSent
                          ? "Đã xác nhận gửi"
                          : isUncertain
                          ? "Chưa rõ kết quả gửi"
                          : a.status === "TYPING"
                          ? "Đang soạn tin"
                          : "Chưa gửi";

                        return (
                          <article key={a.id || a.actionId} className="wf-message outbound">
                            <div className="wf-message-meta">
                              <span>Trợ lý · Tin {idx + 1}</span>
                              <span
                                style={{
                                  color: isSent ? "#267656" : isUncertain ? "#9b6112" : "inherit",
                                  fontWeight: isSent || isUncertain ? 600 : "normal",
                                }}
                              >
                                {statusText}
                              </span>
                            </div>
                            <div className="wf-bubble">{a.text}</div>
                          </article>
                        );
                      })
                    ) : (
                      <div className="wf-empty">
                        {viewData.tone === "active"
                          ? "Đang chuẩn bị câu trả lời từ AI…"
                          : "Chưa có câu trả lời của lượt này."}
                      </div>
                    )}
                  </div>
                )}
              </section>
            </>
          )}
        </main>

        {/* Right Column: Step Inspector */}
        <aside className="wf-inspector" aria-label="Chi tiết bước xử lý">
          <div className="wf-eyebrow">Chi tiết bước</div>
          {currentStage ? (
            <>
              <div className="wf-inspector-symbol">
                {getStageIcon(currentStage.id, 22)}
              </div>
              <h2>{currentStage.label}</h2>
              <p>{currentStage.description}</p>
              <div className={`wf-chip ${currentStage.state}`}>
                {stateLabels[currentStage.state]}
              </div>

              <div className="wf-evidence">{currentStage.evidence}</div>

              <div className="wf-rule" />

              <h3>Thông tin của lượt này</h3>
              <dl className="wf-keyvalues">
                <div>
                  <dt>Khách hàng</dt>
                  <dd>{viewData?.name || "Chưa có"}</dd>
                </div>
                <div>
                  <dt>Lượt xử lý</dt>
                  <dd>
                    #{viewData?.version}{" "}
                    {viewData?.current ? "(Mới nhất)" : ""}
                  </dd>
                </div>
                <div>
                  <dt>Mô hình AI</dt>
                  <dd>{viewData?.run?.model || "Chưa có"}</dd>
                </div>
                <div>
                  <dt>Token đầu vào</dt>
                  <dd>{viewData?.run?.promptTokens ?? "Chưa có"}</dd>
                </div>
                <div>
                  <dt>Token đầu ra</dt>
                  <dd>{viewData?.run?.completionTokens ?? "Chưa có"}</dd>
                </div>
                <div>
                  <dt>Độ trễ AI</dt>
                  <dd>
                    {viewData?.run?.latencyMs
                      ? `${viewData.run.latencyMs} ms`
                      : "Chưa có"}
                  </dd>
                </div>
                <div>
                  <dt>Xác nhận gửi</dt>
                  <dd>
                    {viewData
                      ? `${viewData.confirmedCount}/${viewData.expectedCount ?? "?"}`
                      : "0"}
                  </dd>
                </div>
              </dl>

              <div className="wf-rule" />

              {viewData && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <Link
                    to={`/inbox/${encodeURIComponent(viewData.conversationId)}`}
                    className="wf-button"
                    style={{ width: "100%" }}
                  >
                    <ExternalLink size={13} />
                    Mở hội thoại đầy đủ
                  </Link>

                  <button
                    className="wf-button"
                    style={{ width: "100%" }}
                    onClick={handleCopyCorrelationKey}
                  >
                    {copied ? <Check size={13} /> : <Copy size={13} />}
                    {copied ? "Đã sao chép" : "Sao chép mã lượt"}
                  </button>
                </div>
              )}

              <div className="wf-rule" />

              <details>
                <summary>Chi tiết kỹ thuật (JSON)</summary>
                <div className="wf-code">
                  {JSON.stringify(
                    {
                      correlationKey: viewData?.correlationKey,
                      runStatus: viewData?.run?.status,
                      manifest: viewData?.manifest,
                      skipReason: viewData?.policy,
                      actionsCount: viewData?.actions.length,
                    },
                    null,
                    2
                  )}
                </div>
              </details>

              <div className="wf-footer">
                <span>
                  Phạm vi: API giới hạn 10 AI runs / 10 actions / 30 events.
                </span>
              </div>
            </>
          ) : (
            <div className="wf-empty">Chọn một bước để xem chi tiết.</div>
          )}
        </aside>
      </div>
    </div>
  );
};
