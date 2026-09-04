export interface TypingProfile {
  targetWpmMin: number;
  targetWpmMax: number;
  punctuationPauseMs: number;
}

export const DEFAULT_TYPING_PROFILE: TypingProfile = {
  targetWpmMin: 55,
  targetWpmMax: 65,
  punctuationPauseMs: 250,
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
    for (let i = 0; i < text.length; i++) {
      if (signal?.aborted) {
        return { completed: false, aborted: true };
      }

      const char = text[i]!;
      await sink(char);

      const delayMs = this.calculateCharDelay(char);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }

    return { completed: true };
  }
}
