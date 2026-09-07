import type { DerivedTranscript } from "@messenger/contracts";
import { getEnv, getEffectiveAiConfig } from "@messenger/config";

export interface TranscribeOptions {
  audioBuffer: Buffer | Uint8Array;
  mimeType?: string;
  fileName?: string;
  language?: string;
  sourceMessageRef?: string;
  durationMs?: number;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export type CustomTranscriberFn = (options: TranscribeOptions) => Promise<DerivedTranscript | null>;

let customTranscriber: CustomTranscriberFn | null = null;

export function setCustomTranscriber(fn: CustomTranscriberFn | null): void {
  customTranscriber = fn;
}

/**
 * Transcribes an audio buffer into a structured DerivedTranscript with provenance 'ASR'.
 */
export async function transcribeAudio(options: TranscribeOptions): Promise<DerivedTranscript> {
  const language = options.language || "vi";

  // Check custom/mock transcriber first
  if (customTranscriber) {
    const customResult = await customTranscriber(options);
    if (customResult) return customResult;
  }

  // Resolve connection parameters
  const env = getEnv();
  const effectiveConfig = getEffectiveAiConfig(env);
  const apiKey = options.apiKey || effectiveConfig.apiKey;
  const baseUrl = (options.baseUrl || effectiveConfig.baseURL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = options.model || "whisper-1";

  if (!apiKey || apiKey === "dummy-dev-key") {
    // If no real API key is configured, produce a deterministic placeholder transcript in dev/test
    return {
      text: "[Nội dung giọng nói chưa được chuyển thành văn bản do chưa cấu hình dịch vụ ASR]",
      language,
      confidence: null,
      provenance: "ASR",
      sourceMessageRef: options.sourceMessageRef,
      durationMs: options.durationMs,
    };
  }

  const endpoint = `${baseUrl}/audio/transcriptions`;
  const mimeType = options.mimeType || "audio/mpeg";
  const fileName = options.fileName || "audio.mp3";

  const formData = new FormData();
  const rawBytes = new Uint8Array(options.audioBuffer);
  const blob = new Blob([rawBytes.buffer as ArrayBuffer], { type: mimeType });
  formData.append("file", blob, fileName);
  formData.append("model", model);
  formData.append("language", language);
  formData.append("response_format", "json");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: formData,
    signal: AbortSignal.timeout(25000), // 25s deadline as required by PR-06 spec
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ASR request failed (HTTP ${response.status}): ${errText.slice(0, 300)}`);
  }

  const data = (await response.json()) as { text?: string; language?: string; confidence?: number };
  const transcribedText = (data.text || "").trim();

  return {
    text: transcribedText,
    language: data.language || language,
    confidence: typeof data.confidence === "number" ? data.confidence : null,
    provenance: "ASR",
    sourceMessageRef: options.sourceMessageRef,
    durationMs: options.durationMs,
  };
}
