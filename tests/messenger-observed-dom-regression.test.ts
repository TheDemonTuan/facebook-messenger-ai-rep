import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseMessengerBubblesFromHtml } from "../packages/channel/src/dom-parser.js";

const observedTextAvatarDom = readFileSync(
  new URL("./fixtures/messenger-dom-text-avatar-live-2026-09.html", import.meta.url),
  "utf8"
);

describe("observed Messenger DOM regressions", () => {
  it("keeps a text-only message text-only when its row includes sender avatar and reaction images", () => {
    const parsed = parseMessengerBubblesFromHtml(observedTextAvatarDom, {
      threadKindHint: "DIRECT",
      threadReliabilityHint: "VERIFIED",
    });

    expect(parsed.bubbles).toHaveLength(1);
    expect(parsed.bubbles[0]).toMatchObject({
      id: "mid.$observed-text-001",
      text: "Observed customer text",
      isOutgoing: false,
      hasMedia: undefined,
      parts: [{ type: "TEXT", text: "Observed customer text" }],
    });
  });

});
