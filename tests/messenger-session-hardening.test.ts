import { describe, expect, it } from "vitest";
import { extractMessengerThreadId } from "../apps/browser-agent/src/messenger-adapter.js";
import { getIncidentSafetyPolicy, isCheckpoint } from "../apps/dashboard/src/helpers/incident-helpers.js";
import type { IncidentItem } from "../apps/dashboard/src/types.js";

describe("Messenger session hardening", () => {
  it.each([
    ["https://www.facebook.com/messages/t/123456", "123456"],
    ["https://www.facebook.com/messages/e2ee/t/987654/", "987654"],
    ["/messages/t/thread-name?ref=bookmarks", "thread-name"],
  ])("extracts thread identity from supported Messenger routes", (url, expected) => {
    expect(extractMessengerThreadId(url)).toBe(expected);
  });

  it("does not treat unrelated tabs as Messenger threads", () => {
    expect(extractMessengerThreadId("https://www.facebook.com/")).toBeNull();
    expect(extractMessengerThreadId("about:blank")).toBeNull();
  });

  it("treats login-required incidents as session recovery incidents", () => {
    const incident = {
      id: "11111111-1111-4111-8111-111111111111",
      type: "SESSION_EXPIRED",
      title: "Phiên Facebook đã hết hạn",
      description: "Đăng nhập lại",
      status: "OPEN",
      metadata: { kind: "LOGIN_REQUIRED" },
      createdAt: new Date().toISOString(),
    } as IncidentItem;

    expect(isCheckpoint(incident)).toBe(true);
    expect(getIncidentSafetyPolicy(incident).allowedActions).toContain("OPEN_CONSOLE");
  });
});
