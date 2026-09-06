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

  it("compresses character delay so total typing time stays under maxTotalDelayMs", async () => {
    // 30 WPM with long text would normally take > 10,000ms
    // With maxTotalDelayMs: 100ms, it should compress delays to finish under 200ms
    const engine = new TypingEngine({
      targetWpmMin: 30,
      targetWpmMax: 30,
      punctuationPauseMs: 50,
      maxTotalDelayMs: 100,
    });
    const longText = "Đây là câu trả lời thử nghiệm dài để đảm bảo tốc độ phản hồi không bị kéo dài quá mức!";

    const start = Date.now();
    let typed = "";
    const result = await engine.typeWithPacing(longText, async (char) => {
      typed += char;
    });
    const elapsed = Date.now() - start;

    expect(result.completed).toBe(true);
    expect(typed).toBe(longText);
    expect(elapsed).toBeLessThan(350);
  });

  it("handles multi-byte and surrogate pair emojis as atomic characters without corrupting them into ", async () => {
    const engine = new TypingEngine({ maxTotalDelayMs: 50 });
    const emojiText = "Chào bạn! 🐐 😔 😄 👨‍👩‍👧‍👦 Chúc một ngày tốt lành!";

    const typedCharacters: string[] = [];
    let typed = "";
    const result = await engine.typeWithPacing(emojiText, async (char) => {
      typedCharacters.push(char);
      typed += char;
    });

    expect(result.completed).toBe(true);
    expect(typed).toBe(emojiText);
    // Multi-byte emojis should not be split into half surrogates
    expect(typedCharacters).toContain("🐐");
    expect(typedCharacters).toContain("😔");
    expect(typedCharacters).toContain("😄");
    for (const ch of typedCharacters) {
      const code = ch.charCodeAt(0);
      // UTF-16 high surrogate: 0xD800 to 0xDBFF; low surrogate: 0xDC00 to 0xDFFF
      // A solitary surrogate character in typedCharacters indicates corruption
      if (ch.length === 1) {
        expect(code < 0xd800 || code > 0xdfff).toBe(true);
      }
    }
  });
});
