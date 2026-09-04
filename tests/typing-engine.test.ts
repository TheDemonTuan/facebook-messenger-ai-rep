import { describe, it, expect } from "vitest";
import { TypingEngine } from "../packages/channel/src/typing-engine.js";

describe("TypingEngine Pacing & Cancellation", () => {
  it("calculates baseline delay according to target WPM bounds", () => {
    // 60 WPM = 300 chars/min -> 60000 / 300 = 200ms per char
    const engine = new TypingEngine({ targetWpmMin: 60, targetWpmMax: 60, punctuationPauseMs: 250 });
    const normalDelay = engine.calculateCharDelay("a");
    expect(normalDelay).toBe(200);

    // Punctuation should add punctuationPauseMs
    const punctDelay = engine.calculateCharDelay(".");
    expect(punctDelay).toBe(450);
  });

  it("aborts typing immediately when AbortSignal triggers", async () => {
    const engine = new TypingEngine({ targetWpmMin: 150, targetWpmMax: 150, punctuationPauseMs: 10 });
    const abortController = new AbortController();

    let typed = "";
    const text = "Xin chào bạn, tôi là nhân viên CSKH!";

    // Abort after 5 characters
    const promise = engine.typeWithPacing(
      text,
      async (char) => {
        typed += char;
        if (typed.length >= 5) {
          abortController.abort();
        }
      },
      abortController.signal
    );

    const result = await promise;
    expect(result.completed).toBe(false);
    expect(result.aborted).toBe(true);
    expect(typed.length).toBe(5);
    expect(typed).toBe(text.slice(0, 5));
  });

  it("completes full text when not aborted", async () => {
    const engine = new TypingEngine({ targetWpmMin: 300, targetWpmMax: 300, punctuationPauseMs: 0 });
    let typed = "";
    const text = "Chào bạn!";

    const result = await engine.typeWithPacing(text, async (char) => {
      typed += char;
    });

    expect(result.completed).toBe(true);
    expect(typed).toBe(text);
  });
});
