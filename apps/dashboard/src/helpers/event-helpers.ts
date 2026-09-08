export const eventLabels: Record<string, string> = {
  INBOUND_RECEIVED: "Đã nhận tin nhắn của khách",
  INBOUND_MESSAGE: "Khách gửi tin nhắn",
  DEBOUNCE_STARTED: "Bắt đầu chờ khách nhắn thêm",
  DEBOUNCE_RESET: "Có tin mới, cập nhật lượt gom tin",
  CONVERSATION_QUEUED: "Đã xếp lượt hỗ trợ",
  CONVERSATION_CLAIMED: "Bắt đầu xử lý hội thoại",
  AI_STARTED: "AI bắt đầu chuẩn bị câu trả lời",
  AI_COMPLETED: "AI đã tạo câu trả lời",
  AI_RUN: "AI xử lý lượt hỗ trợ",
  AI_CANCELLED_STALE: "Dừng lượt cũ do có tin nhắn mới",
  DRAFT_CREATED: "Bản thảo câu trả lời đã sẵn sàng",
  TYPING_STARTED: "Đang soạn tin trên Messenger",
  TYPING_ABORTED: "Đã dừng soạn tin",
  SEND_STARTED: "Bắt đầu gửi tin",
  SEND_INTENT: "Đã bắt đầu thao tác gửi tin",
  SEND_CONFIRMED: "Đã xác nhận tin gửi thành công",
  SEND_UNCERTAIN: "Chưa xác định được kết quả gửi",
  SEND_UNCONFIRMED: "Chưa xác định được kết quả gửi",
  ACTION_RECONCILED: "Đã đối soát và xác nhận gửi",
  OUTBOUND_MESSAGE: "Gửi tin phản hồi",
  CONVERSATION_RELEASED: "Đã kết thúc lượt xử lý",
  ERROR: "Có lỗi cần kiểm tra",
  INCIDENT_CREATED: "Phát sinh sự cố",
  INCIDENT_RESOLVED: "Đã xử lý sự cố",
  SESSION_SUSPENDED: "Kênh đã tạm dừng để kiểm tra",
  SESSION_RESUMED: "Kênh được cho phép hoạt động trở lại",
  TAKEOVER_STARTED: "Nhân viên bắt đầu hỗ trợ",
  TAKEOVER_RELEASED: "Chuyển lại cho trợ lý AI",
  TAKEOVER_CANCEL_ACK: "Đã xác nhận dừng AI",
  MANUAL_TAKEOVER: "Nhân viên bắt đầu hỗ trợ",
  MANUAL_RELEASED: "Nhân viên chuyển lại cho trợ lý AI",
  AI_RESUMED_AFTER_HUMAN: "Trợ lý AI tiếp tục sau thời gian chờ nhân viên",
  MEDIA_ENRICHED: "Đã cập nhật dữ liệu đính kèm",
  SETTING_CHANGED: "Đã cập nhật cài đặt",
};

export function eventLabel(type: string): string {
  if (!type) return "Cập nhật hệ thống";
  const normalized = type.toUpperCase().replace(/[\s-]+/g, "_");
  if (eventLabels[normalized]) return eventLabels[normalized];
  if (eventLabels[type]) return eventLabels[type];
  // Convert snake_case or kebab-case to readable format
  return type.replace(/[_-]/g, " ");
}
