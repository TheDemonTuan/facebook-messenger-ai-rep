export interface TypingProfile {
  targetWpmMin: number;
  targetWpmMax: number;
  punctuationPauseMs: number;
  maxTotalDelayMs?: number;
}

export const DEFAULT_TYPING_PROFILE: TypingProfile = {
  targetWpmMin: 55,
  targetWpmMax: 65,
  punctuationPauseMs: 250,
  maxTotalDelayMs: 2500,
};

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

export class TypingEngine {
  private profile: TypingProfile;

  constructor(profile: Partial<TypingProfile> = {}) {
    this.profile = { ...DEFAULT_TYPING_PROFILE, ...profile };
  }

  /**
   * Calculates the delay in milliseconds for a specific character based on target WPM
   * and natural pauses after punctuation (, . ! ? : ;).
   */
  calculateCharDelay(char: string): number {
    const avgWpm = (this.profile.targetWpmMin + this.profile.targetWpmMax) / 2;
    // Standard formula: 1 word = 5 characters.
    // Characters per minute = avgWpm * 5.
    // Delay per character in ms = (60,000 ms) / (avgWpm * 5)
    const baseCharDelayMs = 60000 / (avgWpm * 5);

    if (/[.,!?:;\n]/.test(char)) {
      return baseCharDelayMs + this.profile.punctuationPauseMs;
    }
    return baseCharDelayMs;
  }

  /**
   * Types text into a custom sink (e.g. Playwright page keyboard or mock callback),
   * respecting character delays and cancellation via AbortSignal.
   */
  async typeWithPacing(
    text: string,
    sink: (char: string) => Promise<void>,
    signal?: AbortSignal
  ): Promise<{ completed: boolean; aborted?: boolean }> {
    // Use Intl.Segmenter or Array.from to correctly handle UTF-16 surrogate pairs and compound emojis
    const characters: string[] = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
      ? Array.from(new Intl.Segmenter("vi", { granularity: "grapheme" }).segment(text)).map((s) => s.segment)
      : Array.from(text);

    const totalExpectedDelayMs = characters.reduce((sum, char) => sum + this.calculateCharDelay(char), 0);
    const maxTotalDelayMs = this.profile.maxTotalDelayMs ?? 2500;
    const compressionFactor = totalExpectedDelayMs > maxTotalDelayMs && maxTotalDelayMs > 0
      ? maxTotalDelayMs / totalExpectedDelayMs
      : 1;

    let accumulatedDelayMs = 0;
    for (let i = 0; i < characters.length; i++) {
      if (signal?.aborted) {
        return { completed: false, aborted: true };
      }

      const char = characters[i]!;
      await sink(char);

      accumulatedDelayMs += this.calculateCharDelay(char) * compressionFactor;
      if (accumulatedDelayMs >= 15) {
        const sleepMs = Math.round(accumulatedDelayMs);
        accumulatedDelayMs = 0;
        await sleep(sleepMs);
      }
    }

    return { completed: true };
  }
}
