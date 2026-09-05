import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  isValidTimeZone,
  resolveBusinessTimeZone,
  getTimezoneOffsetMs,
  getZonedDateParts,
  getUtcDateFromZonedParts,
  getBusinessDayRange,
  formatCustomerFriendlyTimeZone,
  DEFAULT_BUSINESS_TIMEZONE,
  SystemSettingsSchema,
} from "../packages/contracts/src/index.js";
import { parseMessengerBubblesFromHtml, MockChannelAdapter } from "../packages/channel/src/index.js";
import { PlaywrightMessengerAdapter } from "../apps/browser-agent/src/messenger-adapter.js";
import {
  formatDateTime,
  formatTime,
  formatDate,
  formatFriendlyTimeZone as dashFormatFriendly,
  setGlobalBusinessTimeZone,
} from "../apps/dashboard/src/helpers/date-helpers.js";

describe("PR 4: Centralized Business Timezone Architecture", () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    process.env.TZ = originalTz;
    setGlobalBusinessTimeZone(DEFAULT_BUSINESS_TIMEZONE);
  });

  describe("1. Timezone Validation & Server-side Settings", () => {
    it("validates standard IANA timezones and defaults to Asia/Ho_Chi_Minh", () => {
      expect(DEFAULT_BUSINESS_TIMEZONE).toBe("Asia/Ho_Chi_Minh");
      expect(isValidTimeZone("Asia/Ho_Chi_Minh")).toBe(true);
      expect(isValidTimeZone("America/New_York")).toBe(true);
      expect(isValidTimeZone("Europe/London")).toBe(true);
      expect(isValidTimeZone("UTC")).toBe(true);
      expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
    });

    it("rejects invalid timezones", () => {
      expect(isValidTimeZone("")).toBe(false);
      expect(isValidTimeZone("   ")).toBe(false);
      expect(isValidTimeZone("Invalid/Timezone")).toBe(false);
      expect(isValidTimeZone("GMT+99")).toBe(false);
      expect(isValidTimeZone("Mars/Phobos")).toBe(false);
      expect(isValidTimeZone(null as unknown as string)).toBe(false);
      expect(isValidTimeZone(undefined as unknown as string)).toBe(false);
      expect(isValidTimeZone(123 as unknown as string)).toBe(false);
    });

    it("resolveBusinessTimeZone normalizes valid zones and falls back to Asia/Ho_Chi_Minh for invalid", () => {
      expect(resolveBusinessTimeZone("Asia/Ho_Chi_Minh")).toBe("Asia/Ho_Chi_Minh");
      expect(resolveBusinessTimeZone("  America/New_York  ")).toBe("America/New_York");
      expect(resolveBusinessTimeZone("Invalid/Zone")).toBe("Asia/Ho_Chi_Minh");
      expect(resolveBusinessTimeZone(null)).toBe("Asia/Ho_Chi_Minh");
      expect(resolveBusinessTimeZone(undefined)).toBe("Asia/Ho_Chi_Minh");
    });

    it("SystemSettingsSchema validates and rejects invalid timezones on server-side parse", () => {
      const valid = SystemSettingsSchema.safeParse({ businessTimeZone: "America/New_York" });
      expect(valid.success).toBe(true);
      if (valid.success) {
        expect(valid.data.businessTimeZone).toBe("America/New_York");
      }

      const invalid = SystemSettingsSchema.safeParse({ businessTimeZone: "Bogus/Zone" });
      expect(invalid.success).toBe(false);
      if (!invalid.success) {
        expect(invalid.error.issues[0]?.message).toContain("Invalid IANA time zone identifier");
      }
    });
  });

  describe("2. Pure Timezone Arithmetic & Process TZ Independence", () => {
    const testZones = ["UTC", "Pacific/Honolulu", "Europe/London", "Asia/Tokyo", "America/Chicago"];

    it("computes identical Asia/Ho_Chi_Minh start and end of business day across different process timezones", () => {
      const fixedRef = new Date("2026-09-05T09:00:00.000Z"); // 16:00 on Sep 5 in Asia/Ho_Chi_Minh

      for (const envTz of testZones) {
        process.env.TZ = envTz;
        const range = getBusinessDayRange(fixedRef, "Asia/Ho_Chi_Minh");

        // Midnight in Asia/Ho_Chi_Minh on Sep 5 is 2026-09-04 17:00:00 UTC
        expect(range.startOfDay.toISOString()).toBe("2026-09-04T17:00:00.000Z");
        // Midnight of next day in Asia/Ho_Chi_Minh is 2026-09-05 17:00:00 UTC
        expect(range.endOfDay.toISOString()).toBe("2026-09-05T17:00:00.000Z");

        // Duration must be exactly 24 hours
        expect(range.endOfDay.getTime() - range.startOfDay.getTime()).toBe(24 * 3600 * 1000);
      }
    });

    it("computes identical America/New_York start and end of business day across different process timezones", () => {
      const fixedRef = new Date("2026-07-04T16:00:00.000Z"); // Mid-summer (EDT, UTC-4)

      for (const envTz of testZones) {
        process.env.TZ = envTz;
        const range = getBusinessDayRange(fixedRef, "America/New_York");

        // Midnight in NY on July 4 is 2026-07-04 04:00:00 UTC
        expect(range.startOfDay.toISOString()).toBe("2026-07-04T04:00:00.000Z");
        // Midnight of July 5 in NY is 2026-07-05 04:00:00 UTC
        expect(range.endOfDay.toISOString()).toBe("2026-07-05T04:00:00.000Z");
        expect(range.endOfDay.getTime() - range.startOfDay.getTime()).toBe(24 * 3600 * 1000);
      }
    });
  });

  describe("3. America/New_York DST Transition Boundaries", () => {
    it("handles Spring Forward (DST gap) correctly with 23-hour business day", () => {
      // March 8, 2026: clocks jump from 01:59:59 EST (UTC-5) to 03:00:00 EDT (UTC-4)
      const noonDuringSpringForward = new Date("2026-03-08T16:00:00.000Z"); // 12:00 EDT in NY
      const range = getBusinessDayRange(noonDuringSpringForward, "America/New_York");

      // Midnight on March 8 was still in EST (UTC-5): 05:00:00 UTC
      expect(range.startOfDay.toISOString()).toBe("2026-03-08T05:00:00.000Z");
      // Midnight on March 9 is in EDT (UTC-4): 04:00:00 UTC
      expect(range.endOfDay.toISOString()).toBe("2026-03-09T04:00:00.000Z");

      // Exactly 23 hours in the business day!
      const hours = (range.endOfDay.getTime() - range.startOfDay.getTime()) / (3600 * 1000);
      expect(hours).toBe(23);

      // Verify that instants right after jump and at end of day fall cleanly in range
      const justAfterJump = new Date("2026-03-08T07:05:00.000Z"); // 03:05 EDT
      expect(justAfterJump >= range.startOfDay && justAfterJump < range.endOfDay).toBe(true);

      const beforeDayStart = new Date("2026-03-08T04:59:59.999Z");
      expect(beforeDayStart >= range.startOfDay).toBe(false);

      const afterDayEnd = new Date("2026-03-09T04:00:00.000Z");
      expect(afterDayEnd < range.endOfDay).toBe(false);
    });

    it("handles Fall Back (DST overlap) correctly with 25-hour business day", () => {
      // November 1, 2026: clocks fall back from 01:59:59 EDT (UTC-4) to 01:00:00 EST (UTC-5)
      const noonDuringFallBack = new Date("2026-11-01T17:00:00.000Z"); // 12:00 EST in NY
      const range = getBusinessDayRange(noonDuringFallBack, "America/New_York");

      // Midnight on Nov 1 was in EDT (UTC-4): 04:00:00 UTC
      expect(range.startOfDay.toISOString()).toBe("2026-11-01T04:00:00.000Z");
      // Midnight on Nov 2 is in EST (UTC-5): 05:00:00 UTC
      expect(range.endOfDay.toISOString()).toBe("2026-11-02T05:00:00.000Z");

      // Exactly 25 hours in the business day!
      const hours = (range.endOfDay.getTime() - range.startOfDay.getTime()) / (3600 * 1000);
      expect(hours).toBe(25);

      // 01:30 during first pass (EDT, 05:30 UTC) and second pass (EST, 06:30 UTC) both fall in range
      const first130 = new Date("2026-11-01T05:30:00.000Z");
      const second130 = new Date("2026-11-01T06:30:00.000Z");
      expect(first130 >= range.startOfDay && first130 < range.endOfDay).toBe(true);
      expect(second130 >= range.startOfDay && second130 < range.endOfDay).toBe(true);
    });
  });

  describe("Subsecond Precision Regression: getTimezoneOffsetMs and getUtcDateFromZonedParts", () => {
    it("eliminates subsecond distortion in getTimezoneOffsetMs for arbitrary milliseconds", () => {
      // Instants with fractional milliseconds (.000, .001, .123, .456, .789, .999)
      const msOffsets = [0, 1, 123, 456, 789, 999];

      for (const ms of msOffsets) {
        const dHcm = new Date(`2026-06-01T12:00:00.${ms.toString().padStart(3, "0")}Z`);
        const offsetHcm = getTimezoneOffsetMs(dHcm, "Asia/Ho_Chi_Minh");
        // UTC+7 is exactly 25,200,000 ms; must not have subsecond jitter like 25,199,544
        expect(offsetHcm).toBe(7 * 3600 * 1000);
        expect(offsetHcm % 1000).toBe(0);

        const dNyWinter = new Date(`2026-01-15T00:00:00.${ms.toString().padStart(3, "0")}Z`);
        const offsetNyWinter = getTimezoneOffsetMs(dNyWinter, "America/New_York");
        // EST (UTC-5) is exactly -18,000,000 ms
        expect(offsetNyWinter).toBe(-5 * 3600 * 1000);
        expect(Math.abs(offsetNyWinter % 1000)).toBe(0);

        const dNySummer = new Date(`2026-07-15T00:00:00.${ms.toString().padStart(3, "0")}Z`);
        const offsetNySummer = getTimezoneOffsetMs(dNySummer, "America/New_York");
        // EDT (UTC-4) is exactly -14,400,000 ms
        expect(offsetNySummer).toBe(-4 * 3600 * 1000);
        expect(Math.abs(offsetNySummer % 1000)).toBe(0);
      }
    });

    it("getZonedDateParts and getUtcDateFromZonedParts preserve subsecond precision without distortion", () => {
      const original = new Date("2026-06-01T12:00:00.789Z");
      const parts = getZonedDateParts(original, "Asia/Ho_Chi_Minh");

      expect(parts.year).toBe(2026);
      expect(parts.month).toBe(6);
      expect(parts.day).toBe(1);
      expect(parts.hour).toBe(19);
      expect(parts.minute).toBe(0);
      expect(parts.second).toBe(0);
      expect(parts.millisecond).toBe(789);

      const roundTrip = getUtcDateFromZonedParts(parts, "Asia/Ho_Chi_Minh");
      expect(roundTrip.getTime()).toBe(original.getTime());
      expect(roundTrip.toISOString()).toBe("2026-06-01T12:00:00.789Z");
    });
  });

  describe("4. Dynamic Timezone Reaching DOM Parser & Adapter", () => {
    const timestampsHtml = fs.readFileSync(
      path.resolve(__dirname, "fixtures/messenger-dom-timestamps.html"),
      "utf-8"
    );

    it("parses localized message bubbles differently depending on business timezone", () => {
      // Fixed observation: 2026-09-05 09:00:00 UTC (16:00 in Asia/Ho_Chi_Minh)
      const observedAt = new Date("2026-09-05T09:00:00.000Z");

      // 1. Parsed in Asia/Ho_Chi_Minh: 14:30 on Sep 5 in UTC+7 is 07:30 UTC
      const resHcm = parseMessengerBubblesFromHtml(timestampsHtml, {
        observedAt,
        timeZone: "Asia/Ho_Chi_Minh",
      });
      expect(resHcm.ok).toBe(true);
      const bHcm = resHcm.bubbles[2]!;
      expect(bHcm.facebookEventTimestamp?.toISOString()).toBe("2026-09-05T07:30:00.000Z");

      // 2. Parsed in America/New_York (EDT, UTC-4): 14:30 on Sep 5 is 18:30 UTC
      const resNy = parseMessengerBubblesFromHtml(timestampsHtml, {
        observedAt,
        timeZone: "America/New_York",
      });
      expect(resNy.ok).toBe(true);
      const bNy = resNy.bubbles[2]!;
      expect(bNy.facebookEventTimestamp?.toISOString()).toBe("2026-09-05T18:30:00.000Z");

      // The timestamps differ by exactly 11 hours (UTC+7 vs UTC-4)
      const diffMs =
        bNy.facebookEventTimestamp!.getTime() -
        bHcm.facebookEventTimestamp!.getTime();
      expect(diffMs).toBe(11 * 3600 * 1000);
    });

    it("PlaywrightMessengerAdapter setTimeZone returns whether context recreation is required", () => {
      const adapter = new PlaywrightMessengerAdapter({
        profileDir: "./test-profile",
        timeZone: "America/New_York",
      });

      expect(adapter.timeZone).toBe("America/New_York");
      expect(adapter.getActiveContextTimeZone()).toBe("America/New_York");

      // Before context is initialized, setTimeZone updates activeContextTimeZone and returns false
      const req1 = adapter.setTimeZone("Asia/Ho_Chi_Minh");
      expect(req1).toBe(false);
      expect(adapter.timeZone).toBe("Asia/Ho_Chi_Minh");
      expect(adapter.getActiveContextTimeZone()).toBe("Asia/Ho_Chi_Minh");

      // Rejects invalid timezone without crashing
      const reqInvalid = adapter.setTimeZone("Invalid/Zone");
      expect(reqInvalid).toBe(false);
      expect(adapter.timeZone).toBe("Asia/Ho_Chi_Minh");

      // Simulate running context
      const mockContext = { close: vi.fn().mockResolvedValue(undefined) };
      (adapter as unknown as { context: unknown }).context = mockContext;

      // Calling setTimeZone with same timezone returns false (no recreation required)
      expect(adapter.setTimeZone("Asia/Ho_Chi_Minh")).toBe(false);

      // Calling setTimeZone with different timezone returns true (context recreation required)
      const reqRecreate = adapter.setTimeZone("America/New_York");
      expect(reqRecreate).toBe(true);
      expect(adapter.timeZone).toBe("America/New_York");
      // But activeContextTimeZone remains the old one until context recreation runs!
      expect(adapter.getActiveContextTimeZone()).toBe("Asia/Ho_Chi_Minh");
    });

    it("PlaywrightMessengerAdapter controlled reinitializeContext aligns context and parsing timezone safely", async () => {
      const adapter = new PlaywrightMessengerAdapter({
        profileDir: "./test-profile",
        timeZone: "Asia/Ho_Chi_Minh",
      });

      const mockClosePage = vi.fn().mockResolvedValue(undefined);
      const mockCloseContext = vi.fn().mockResolvedValue(undefined);
      const mockInit = vi.fn().mockResolvedValue(undefined);

      (adapter as unknown as { senderPage: unknown }).senderPage = { close: mockClosePage };
      (adapter as unknown as { observerPage: unknown }).observerPage = { close: mockClosePage };
      (adapter as unknown as { context: unknown }).context = { close: mockCloseContext };
      adapter.init = mockInit;

      expect(adapter.getActiveContextTimeZone()).toBe("Asia/Ho_Chi_Minh");
      expect(adapter.setTimeZone("America/New_York")).toBe(true);
      expect(adapter.getActiveContextTimeZone()).toBe("Asia/Ho_Chi_Minh");

      // Trigger controlled context reinitialization
      await adapter.reinitializeContext();

      // Verified senderPage, observerPage and context were safely closed
      expect(mockClosePage).toHaveBeenCalledTimes(2);
      expect(mockCloseContext).toHaveBeenCalledTimes(1);
      expect(mockInit).toHaveBeenCalledTimes(1);

      // Now activeContextTimeZone is aligned with target timezone
      expect(adapter.getActiveContextTimeZone()).toBe("America/New_York");
      expect(adapter.timeZone).toBe("America/New_York");
    });

    it("MockChannelAdapter tracks setTimeZone recreation requirement and reinitializeContext", async () => {
      const adapter = new MockChannelAdapter();
      expect(adapter.timeZone).toBe("Asia/Ho_Chi_Minh");
      expect(adapter.activeContextTimeZone).toBe("Asia/Ho_Chi_Minh");

      // Same zone -> returns false
      expect(adapter.setTimeZone("Asia/Ho_Chi_Minh")).toBe(false);

      // Different zone -> returns true
      expect(adapter.setTimeZone("America/New_York")).toBe(true);
      expect(adapter.timeZone).toBe("America/New_York");
      expect(adapter.activeContextTimeZone).toBe("Asia/Ho_Chi_Minh");

      // Reinitialize aligns active context
      await adapter.reinitializeContext();
      expect(adapter.activeContextTimeZone).toBe("America/New_York");
      expect(adapter.contextRecreationCount).toBe(1);
    });

    it("SenderWorkerService realigns browser context timezone before opening conversation", async () => {
      const { SenderWorkerService } = await import("../apps/browser-agent/src/sender-worker.js");
      const mockAdapter = new MockChannelAdapter();
      mockAdapter.activeContextTimeZone = "Asia/Ho_Chi_Minh";
      mockAdapter.timeZone = "Asia/Ho_Chi_Minh";

      let timezoneDuringOpen = "";
      mockAdapter.openConversation = vi.fn(async () => {
        timezoneDuringOpen = mockAdapter.activeContextTimeZone;
        return true;
      });
      mockAdapter.capturePreSendMarker = vi.fn(async () => ({
        threadRef: "thread-1",
        lastMessageId: "msg-0",
        messageCount: 1,
        markerTimestamp: new Date(),
      }));
      mockAdapter.typeDraft = vi.fn(async () => ({ completed: true, aborted: false }));
      mockAdapter.sendDraft = vi.fn(async () => ({ sent: true }));
      mockAdapter.verifySent = vi.fn(async () => ({ verified: true, messageRef: "msg-deliv" }));

      const mockSettingsRepo = {
        getSettings: vi.fn().mockResolvedValue({
          settings: {
            businessTimeZone: "America/New_York",
            typingTargetWpmMin: 100,
            typingTargetWpmMax: 150,
          },
          revision: 1,
        }),
      };

      const mockDb = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "personal-messenger",
                  status: "RUNNING",
                  isSuspended: false,
                  isPaused: false,
                },
              ]),
            })),
          })),
        })),
      };

      const mockConvRepo = {
        getConversationById: vi.fn().mockResolvedValue({
          conversation: { id: "conv-1", externalThreadId: "thread-1", status: "QUEUED", manualMode: false, inboundVersion: 1 },
          customer: { id: "cust-1", name: "Customer" },
        }),
        updateStatus: vi.fn().mockResolvedValue(undefined),
      };

      const mockOutboundRepo = {
        transitionStatus: vi.fn().mockResolvedValue({ id: "act-1", status: "TYPING" }),
        updateStatus: vi.fn().mockResolvedValue({ id: "act-1", status: "SENT" }),
        confirmSent: vi.fn().mockResolvedValue({ id: "act-1", status: "CONFIRMED" }),
      };

      const mockEventRepo = {
        recordEvent: vi.fn().mockResolvedValue({ id: "ev-1" }),
      };

      const worker = new SenderWorkerService(
        mockDb as never,
        null,
        mockAdapter,
        null,
        mockConvRepo as never,
        null,
        mockOutboundRepo as never,
        mockEventRepo as never,
        mockSettingsRepo as never,
        {} as never,
        {} as never,
        null as never,
        {
          recheckEligibility: vi.fn().mockResolvedValue({ eligible: true, decision: "ELIGIBLE", reasonCode: "ELIGIBLE" }),
        } as unknown as ReplyPolicyService
      );

      await worker.processAction({
        actionId: "act-1",
        conversationId: "conv-1",
        channelAccountId: "personal-messenger",
        responseIndex: 1,
        inboundVersion: 1,
        text: "Hello!",
        textHash: "hash-1",
        ownerToken: "token-1",
        fencingEpoch: 1,
        externalThreadRef: "https://www.facebook.com/messages/t/thread-1",
        actor: "AI",
      });

      // Verify that when openConversation was called, the timezone was ALREADY aligned to America/New_York
      expect(timezoneDuringOpen).toBe("America/New_York");
      expect(mockAdapter.contextRecreationCount).toBe(1);
    });
  });

  describe("5. Customer-Friendly Active Timezone Indicator & Formatters", () => {
    it("formats customer-friendly timezone indicator without raw internals", () => {
      const refWinter = new Date("2026-01-15T12:00:00.000Z");
      const refSummer = new Date("2026-07-15T12:00:00.000Z");

      // Asia/Ho_Chi_Minh is always GMT+7
      expect(formatCustomerFriendlyTimeZone("Asia/Ho_Chi_Minh", refWinter)).toBe("Ho Chi Minh (GMT+7)");
      expect(formatCustomerFriendlyTimeZone("Asia/Ho_Chi_Minh", refSummer)).toBe("Ho Chi Minh (GMT+7)");

      // America/New_York changes with DST
      expect(formatCustomerFriendlyTimeZone("America/New_York", refWinter)).toBe("New York (GMT-5)");
      expect(formatCustomerFriendlyTimeZone("America/New_York", refSummer)).toBe("New York (GMT-4)");

      // Europe/London changes with BST
      expect(formatCustomerFriendlyTimeZone("Europe/London", refWinter)).toBe("London (GMT+0)");
      expect(formatCustomerFriendlyTimeZone("Europe/London", refSummer)).toBe("London (GMT+1)");

      // Dashboard helper matches contracts output
      expect(dashFormatFriendly("Asia/Ho_Chi_Minh", refWinter)).toBe("Ho Chi Minh (GMT+7)");
    });

    it("central dashboard date and time formatters strictly honor the configured business timezone", () => {
      const utcInstant = new Date("2026-09-05T07:30:00.000Z");

      // In Asia/Ho_Chi_Minh (UTC+7), it is 14:30:00
      setGlobalBusinessTimeZone("Asia/Ho_Chi_Minh");
      expect(formatTime(utcInstant)).toBe("14:30:00");
      expect(formatDateTime(utcInstant)).toContain("14:30:00");

      // In America/New_York (EDT, UTC-4), it is 03:30:00
      setGlobalBusinessTimeZone("America/New_York");
      expect(formatTime(utcInstant)).toBe("03:30:00");
      expect(formatDateTime(utcInstant)).toContain("03:30:00");

      // Explicit override parameter
      expect(formatTime(utcInstant, "Europe/London")).toBe("08:30:00"); // BST (UTC+1)
    });

    it("safe fallback on null, undefined, or invalid inputs", () => {
      expect(formatDateTime(null)).toBe("—");
      expect(formatDateTime(undefined)).toBe("—");
      expect(formatDateTime("invalid-date")).toBe("—");
      expect(formatTime(null)).toBe("—");
      expect(formatDate(null)).toBe("—");
    });
  });

  describe("6. Calendar and Leap Year Boundaries", () => {
    it("handles Year End boundary (Dec 31 -> Jan 1) in Asia/Ho_Chi_Minh correctly", () => {
      // 2026-12-31 20:00:00 UTC is 2027-01-01 03:00:00 in Asia/Ho_Chi_Minh
      const newYearRef = new Date("2026-12-31T20:00:00.000Z");
      const range = getBusinessDayRange(newYearRef, "Asia/Ho_Chi_Minh");

      // Business day is Jan 1, 2027 (00:00:00 GMT+7 is 2026-12-31 17:00:00 UTC)
      expect(range.startOfDay.toISOString()).toBe("2026-12-31T17:00:00.000Z");
      expect(range.endOfDay.toISOString()).toBe("2027-01-01T17:00:00.000Z");
      expect(range.endOfDay.getTime() - range.startOfDay.getTime()).toBe(24 * 3600 * 1000);
    });

    it("handles Leap Year boundaries (Feb 28/29 -> Mar 1) in America/New_York correctly", () => {
      // Leap year 2024: Feb 28 in America/New_York (EST, UTC-5)
      const feb28 = new Date("2024-02-28T18:00:00.000Z"); // 13:00 EST
      const range28 = getBusinessDayRange(feb28, "America/New_York");
      expect(range28.startOfDay.toISOString()).toBe("2024-02-28T05:00:00.000Z");
      expect(range28.endOfDay.toISOString()).toBe("2024-02-29T05:00:00.000Z");

      // Leap year 2024: Feb 29 in America/New_York (EST, UTC-5)
      const feb29 = new Date("2024-02-29T18:00:00.000Z"); // 13:00 EST
      const range29 = getBusinessDayRange(feb29, "America/New_York");
      expect(range29.startOfDay.toISOString()).toBe("2024-02-29T05:00:00.000Z");
      expect(range29.endOfDay.toISOString()).toBe("2024-03-01T05:00:00.000Z");
    });
  });

  describe("7. Core API Overview & Settings Validation", () => {
    it("GET /api/overview exposes businessTimeZone and defaults safely", async () => {
      const { buildCoreServer } = await import("../apps/core/src/index.js");

      const userRecord = {
        id: "user-owner",
        email: "owner@example.com",
        role: "OWNER",
        name: "Channel Owner",
        lastSeenAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const createChain = () => {
        const chain: Record<string, unknown> = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.innerJoin = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.limit = vi.fn(() => Promise.resolve([]));
        chain.orderBy = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.then = (resolve: (v: unknown) => unknown) => resolve([]);
        return chain;
      };

      const mockDb = {
        execute: vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] }),
        select: vi.fn(() => createChain()),
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            onConflictDoUpdate: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([userRecord]),
            })),
            returning: vi.fn().mockResolvedValue([userRecord]),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([userRecord]),
          })),
        })),
        transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(mockDb)),
      };

      const serverContext = await buildCoreServer({ db: mockDb as never });

      const resGet = await serverContext.fastify.inject({
        method: "GET",
        url: "/api/overview",
        headers: {
          "cf-access-authenticated-user-email": "owner@example.com",
        },
      });

      expect(resGet.statusCode).toBe(200);
      const json = JSON.parse(resGet.payload);
      expect(json.businessTimeZone).toBe("Asia/Ho_Chi_Minh");
      expect(typeof json.todayConversationsCount).toBe("number");
      expect(typeof json.todayMessagesCount).toBe("number");

      serverContext.rateLimiter.destroy();
      serverContext.broadcaster.stop();
    });

    it("PUT /api/settings rejects invalid businessTimeZone with 400 Bad Request", async () => {
      const { buildCoreServer } = await import("../apps/core/src/index.js");

      const userRecord = {
        id: "user-owner",
        email: "owner@example.com",
        role: "OWNER",
        name: "Channel Owner",
        lastSeenAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const createChain = () => {
        const chain: Record<string, unknown> = {};
        chain.from = vi.fn(() => chain);
        chain.where = vi.fn(() => chain);
        chain.innerJoin = vi.fn(() => chain);
        chain.leftJoin = vi.fn(() => chain);
        chain.limit = vi.fn(() => Promise.resolve([]));
        chain.orderBy = vi.fn(() => chain);
        chain.offset = vi.fn(() => chain);
        chain.then = (resolve: (v: unknown) => unknown) => resolve([]);
        return chain;
      };

      const mockDb = {
        execute: vi.fn().mockResolvedValue({ rows: [{ "?column?": 1 }] }),
        select: vi.fn(() => createChain()),
        insert: vi.fn(() => ({
          values: vi.fn(() => ({
            onConflictDoUpdate: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([userRecord]),
            })),
            returning: vi.fn().mockResolvedValue([userRecord]),
          })),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([userRecord]),
          })),
        })),
        transaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb(mockDb)),
      };

      const serverContext = await buildCoreServer({ db: mockDb as never });

      const resPut = await serverContext.fastify.inject({
        method: "PUT",
        url: "/api/settings",
        headers: {
          "cf-access-authenticated-user-email": "owner@example.com",
          host: "localhost:3000",
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        payload: JSON.stringify({
          businessTimeZone: "Invalid/Zone_123",
        }),
      });

      expect(resPut.statusCode).toBe(400);
      const json = JSON.parse(resPut.payload);
      expect(json.error).toBe("Invalid settings format");
      expect(json.details[0]?.message).toContain("Invalid IANA time zone identifier");

      serverContext.rateLimiter.destroy();
      serverContext.broadcaster.stop();
    });
  });
});
