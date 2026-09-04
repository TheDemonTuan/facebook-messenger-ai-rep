import { describe, it, expect, vi } from "vitest";
import { SystemSettingsSchema } from "../packages/contracts/src/settings.js";
import { getAiClient } from "../packages/ai/src/client.js";
import Fastify from "../apps/control-plane/node_modules/fastify";
import { createAdminRoutes } from "../apps/control-plane/src/routes/admin.js";

describe("Settings API Auth & Dynamic AI Client Configuration", () => {
  it("SystemSettingsSchema validates and defaults aiBaseUrl and aiApiKey", () => {
    const defaultSettings = SystemSettingsSchema.parse({});
    expect(defaultSettings.aiBaseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(defaultSettings.aiApiKey).toBe("omniroute-default-key");
    expect(defaultSettings.aiModel).toBe("gemini-3.7-flash-low");

    const customSettings = SystemSettingsSchema.parse({
      aiBaseUrl: "https://api.openai.com/v1",
      aiApiKey: "sk-custom-secret-key-12345",
      aiModel: "gpt-4o-mini",
    });

    expect(customSettings.aiBaseUrl).toBe("https://api.openai.com/v1");
    expect(customSettings.aiApiKey).toBe("sk-custom-secret-key-12345");
    expect(customSettings.aiModel).toBe("gpt-4o-mini");
  });

  it("getAiClient dynamically switches baseURL and apiKey based on settings config", () => {
    const clientA = getAiClient({
      baseURL: "http://127.0.0.1:8000/v1",
      apiKey: "key-a",
    });
    expect(clientA.baseURL).toBe("http://127.0.0.1:8000/v1");
    expect(clientA.apiKey).toBe("key-a");

    const clientB = getAiClient({
      baseURL: "https://my-custom-ai.com/v1",
      apiKey: "key-b",
    });
    expect(clientB.baseURL).toBe("https://my-custom-ai.com/v1");
    expect(clientB.apiKey).toBe("key-b");

    // Client caching works when identical
    const clientB2 = getAiClient({
      baseURL: "https://my-custom-ai.com/v1",
      apiKey: "key-b",
    });
    expect(clientB2).toBe(clientB);
  });

  it("admin routes correctly update settings and handle test-ai endpoint", async () => {
    let storedSettings = SystemSettingsSchema.parse({
      aiBaseUrl: "http://127.0.0.1:8000/v1",
      aiApiKey: "initial-key",
    });
    let revision = 1;

    const mockSettingsRepo = {
      getSettings: vi.fn(async () => ({ settings: storedSettings, revision })),
      updateSettings: vi.fn(async (_id: string, partial: any) => {
        storedSettings = SystemSettingsSchema.parse({ ...storedSettings, ...partial });
        revision += 1;
        return { settings: storedSettings, revision };
      }),
    };

    const mockEventRepo = {
      recordEvent: vi.fn(async () => {}),
    };

    const mockBroadcaster = {
      broadcast: vi.fn(),
    };

    const fastify = Fastify();
    await fastify.register(
      createAdminRoutes({
        db: {} as any,
        queueRepo: {} as any,
        settingsRepo: mockSettingsRepo as any,
        incidentRepo: {} as any,
        eventRepo: mockEventRepo as any,
        broadcaster: mockBroadcaster as any,
        requireAuth: async () => ({
          id: "u-1",
          email: "owner@example.com",
          role: "OWNER",
          sessionId: "s-1",
        }),
        channelAccountId: "personal-messenger",
      })
    );

    // 1. GET /api/settings
    const getRes = await fastify.inject({
      method: "GET",
      url: "/api/settings",
    });
    expect(getRes.statusCode).toBe(200);
    const getData = JSON.parse(getRes.body);
    expect(getData.settings.aiBaseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(getData.settings.aiApiKey).toBe("initial-key");

    // 2. PUT /api/settings updating API auth & model
    const putRes = await fastify.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        aiBaseUrl: "https://gateway.example.com/v1",
        aiApiKey: "sk-new-super-secret-key",
        aiModel: "gemini-1.5-pro",
        reason: "Updated AI API auth credentials from web UI",
      },
    });
    expect(putRes.statusCode).toBe(200);
    const putData = JSON.parse(putRes.body);
    expect(putData.settings.aiBaseUrl).toBe("https://gateway.example.com/v1");
    expect(putData.settings.aiApiKey).toBe("sk-new-super-secret-key");
    expect(putData.settings.aiModel).toBe("gemini-1.5-pro");
    expect(putData.revision).toBe(2);
    expect(mockBroadcaster.broadcast).toHaveBeenCalledWith("settings:updated", { revision: 2 });

    // 3. POST /api/settings/test-ai (smoke tests connection handler)
    const testRes = await fastify.inject({
      method: "POST",
      url: "/api/settings/test-ai",
      payload: {
        aiBaseUrl: "http://127.0.0.1:9999/v1",
        aiApiKey: "test-key",
        aiModel: "test-model",
      },
    });
    expect(testRes.statusCode).toBe(200);
    const testData = JSON.parse(testRes.body);
    expect(typeof testData.ok).toBe("boolean");
    expect(typeof testData.message).toBe("string");
  });
});
