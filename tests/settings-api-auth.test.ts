import { describe, it, expect, vi } from "vitest";
import { SystemSettingsSchema } from "../packages/contracts/src/settings.js";
import { getAiClient } from "../packages/ai/src/client.js";
import { EnvSchema } from "../packages/config/src/index.js";
import Fastify from "fastify";
import { createAdminRoutes } from "../apps/core/src/routes/admin.js";

describe("Settings API & Server-Side xAI Configuration", () => {
  it("SystemSettingsSchema does not store aiApiKey and sets safe defaults", () => {
    const defaultSettings = SystemSettingsSchema.parse({});
    expect(defaultSettings.aiBaseUrl).toBe("https://api.x.ai/v1");
    expect(defaultSettings.aiModel).toBe("grok-2-latest");
    // aiApiKey must NOT exist on settings
    expect((defaultSettings as any).aiApiKey).toBeUndefined();

    const customSettings = SystemSettingsSchema.parse({
      aiBaseUrl: "https://api.x.ai/v1",
      aiModel: "grok-beta",
    });

    expect(customSettings.aiBaseUrl).toBe("https://api.x.ai/v1");
    expect(customSettings.aiModel).toBe("grok-beta");
    expect((customSettings as any).aiApiKey).toBeUndefined();
  });

  it("fails fast in production when XAI_API_KEY is missing", () => {
    const prodWithoutKey = EnvSchema.safeParse({
      NODE_ENV: "production",
      XAI_API_KEY: "",
    });
    expect(prodWithoutKey.success).toBe(false);
    if (!prodWithoutKey.success) {
      const errorMsg = prodWithoutKey.error.issues[0]?.message;
      expect(errorMsg).toContain("XAI_API_KEY is required");
    }

    const prodWithKey = EnvSchema.safeParse({
      NODE_ENV: "production",
      XAI_API_KEY: "xai-test-secret-key-12345",
      CLOUDFLARE_ACCESS_TEAM_NAME: "test-team",
      CLOUDFLARE_ACCESS_AUD: "test-aud-12345",
      SESSION_SECRET: "super-secret-session-key-must-be-at-least-32-chars-long!",
      INTERNAL_HMAC_SECRET: "internal-hmac-secret-must-be-at-least-32-chars-long!",
    });
    expect(prodWithKey.success).toBe(true);
  });

  it("getAiClient dynamically switches baseURL and apiKey based on config", () => {
    const clientA = getAiClient({
      baseURL: "https://api.x.ai/v1",
      apiKey: "key-a",
    });
    expect(clientA.baseURL).toBe("https://api.x.ai/v1");
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

  it("admin routes correctly update settings without storing API keys", async () => {
    let storedSettings = SystemSettingsSchema.parse({
      aiBaseUrl: "https://api.x.ai/v1",
      aiModel: "grok-2-latest",
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
    expect(getData.settings.aiBaseUrl).toBe("https://api.x.ai/v1");
    expect(getData.settings.aiApiKey).toBeUndefined();

    // 2. PUT /api/settings updating model & prompt
    const putRes = await fastify.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        aiBaseUrl: "https://api.x.ai/v1",
        aiModel: "grok-beta",
        reason: "Updated AI model from web UI",
      },
    });
    expect(putRes.statusCode).toBe(200);
    const putData = JSON.parse(putRes.body);
    expect(putData.settings.aiBaseUrl).toBe("https://api.x.ai/v1");
    expect(putData.settings.aiModel).toBe("grok-beta");
    expect(putData.settings.aiApiKey).toBeUndefined();
    expect(putData.revision).toBe(2);
    expect(mockBroadcaster.broadcast).toHaveBeenCalledWith("settings:updated", { revision: 2 });

    // 3. POST /api/settings/test-ai (smoke tests connection handler)
    const testRes = await fastify.inject({
      method: "POST",
      url: "/api/settings/test-ai",
      payload: {
        aiBaseUrl: "http://127.0.0.1:9999/v1",
        aiModel: "test-model",
      },
    });
    expect(testRes.statusCode).toBe(200);
    const testData = JSON.parse(testRes.body);
    expect(typeof testData.ok).toBe("boolean");
    expect(typeof testData.message).toBe("string");
  });
});
