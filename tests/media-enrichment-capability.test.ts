import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveProviderCapabilities,
  resetCapabilityRules,
  buildChatMessages,
  type ConversationContext,
} from "../packages/ai/src/index.js";
import { SystemSettingsDefaults } from "../packages/contracts/src/index.js";

describe("PR-06 Provider Capability Registry & Vision/ASR Truth", () => {
  beforeEach(() => {
    resetCapabilityRules();
  });

  describe("1. Capability Registry Resolution", () => {
    it("resolves xAI Grok vision models with imageInput: true", () => {
      const caps = resolveProviderCapabilities({
        apiFormat: "OPENAI_COMPATIBLE",
        baseUrl: "https://api.x.ai/v1",
        model: "grok-2-vision-1212",
      });

      expect(caps.text).toBe(true);
      expect(caps.imageInput).toBe(true);
      expect(caps.audioInput).toBe(false);
      expect(caps.audioTranscription).toBe(false);
      expect(caps.structuredOutput).toBe(true);
    });

    it("resolves xAI text models (grok-beta, grok-2, grok-4.5) with imageInput: false", () => {
      const caps = resolveProviderCapabilities({
        apiFormat: "OPENAI_COMPATIBLE",
        baseUrl: "https://api.x.ai/v1",
        model: "grok-4.5",
      });

      expect(caps.text).toBe(true);
      expect(caps.imageInput).toBe(false);
      expect(caps.audioInput).toBe(false);
    });

    it("does NOT infer vision from health check text or model names alone", () => {
      // Unverified custom proxy or unknown model containing "vision" in name
      const caps = resolveProviderCapabilities({
        apiFormat: "OPENAI_COMPATIBLE",
        baseUrl: "https://custom-unverified-proxy.example.com/v1",
        model: "some-unverified-vision-model-v1",
      });

      // By default, unknown endpoints have imageInput: false unless explicitly verified or configured
      expect(caps.imageInput).toBe(false);
    });

    it("resolves OpenAI verified models correctly", () => {
      const gpt4o = resolveProviderCapabilities({
        apiFormat: "OPENAI_COMPATIBLE",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o",
      });
      expect(gpt4o.imageInput).toBe(true);

      const gpt35 = resolveProviderCapabilities({
        apiFormat: "OPENAI_COMPATIBLE",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-3.5-turbo",
      });
      expect(gpt35.imageInput).toBe(false);

      const whisper = resolveProviderCapabilities({
        apiFormat: "OPENAI_COMPATIBLE",
        baseUrl: "https://api.openai.com/v1",
        model: "whisper-1",
      });
      expect(whisper.audioTranscription).toBe(true);
      expect(whisper.text).toBe(false);
    });

    it("resolves Anthropic Claude 3 models with imageInput: true", () => {
      const claude = resolveProviderCapabilities({
        apiFormat: "ANTHROPIC_COMPATIBLE",
        baseUrl: "https://api.anthropic.com/v1",
        model: "claude-3-5-sonnet-20241022",
      });
      expect(claude.imageInput).toBe(true);
    });

    it("allows explicit settings to override registry rules", () => {
      // Shop owner explicitly verified and enabled imageInput for their custom proxy
      const caps = resolveProviderCapabilities({
        apiFormat: "OPENAI_COMPATIBLE",
        baseUrl: "https://custom-gateway.shop.com/v1",
        model: "custom-chat",
        explicitCapabilities: {
          imageInput: true,
        },
      });

      expect(caps.imageInput).toBe(true);
    });
  });

  describe("2. AI Context Builder with and without Vision Capabilities", () => {
    it("safely instructs model when imageInput is false without sending raw image blocks", () => {
      const context: ConversationContext = {
        settings: {
          ...SystemSettingsDefaults,
          aiModel: "grok-4.5",
        },
        recentMessages: [
          {
            direction: "INBOUND",
            text: "Shop ơi mẫu này còn không?",
            parts: [
              {
                type: "IMAGE",
                media: {
                  mediaId: "mref_sample_01",
                  role: "ATTACHMENT",
                  status: "READY",
                  sourceUrl: "https://scontent.xx.fbcdn.net/sample.jpg",
                },
              },
            ],
          },
        ],
      };

      // When vision capability is false (e.g. standard text model)
      const chatMessages = buildChatMessages(context, {
        capabilities: {
          text: true,
          imageInput: false,
          audioInput: false,
          audioTranscription: false,
          videoInput: false,
          structuredOutput: true,
        },
      });

      const userMessage = chatMessages.find((m) => m.role === "user");
      expect(userMessage).toBeDefined();
      expect(typeof userMessage?.content).toBe("string");

      const userText = userMessage?.content as string;
      expect(userText).toContain("Shop ơi mẫu này còn không?");
      // Factual warning included, model instructed not to pretend to see image
      expect(userText).toContain("Kênh AI hiện tại chưa kích hoạt phân tích hình ảnh");
      expect(userText).toContain("Không giả vờ đã thấy ảnh");
    });
  });
});
