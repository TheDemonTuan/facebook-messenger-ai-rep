import { describe, it, expect, vi } from "vitest";
import { SystemSettingsSchema } from "../packages/contracts/src/settings.js";
import { getAiClient, resetAiClientCache } from "../packages/ai/src/client.js";
import { EnvSchema } from "../packages/config/src/index.js";
import Fastify from "fastify";
import { createAdminRoutes } from "../apps/core/src/routes/admin.js";

describe("Settings API & Server-Side xAI Configuration", () => {
  it("SystemSettingsSchema does not store aiApiKey or aiBaseUrl and sets safe defaults", () => {
    const defaultSettings = SystemSettingsSchema.parse({});
    expect((defaultSettings as any).aiBaseUrl).toBeUndefined();
    expect((defaultSettings as any).aiApiKey).toBeUndefined();
    expect(defaultSettings.aiModel).toBe("grok-4.5");

    const customSettings = SystemSettingsSchema.parse({
      aiModel: "grok-beta",
    });

    expect((customSettings as any).aiBaseUrl).toBeUndefined();
    expect((customSettings as any).aiApiKey).toBeUndefined();
    expect(customSettings.aiModel).toBe("grok-beta");
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

  it("getAiClient uses server-side xAI env and caches client", () => {
    resetAiClientCache();
    const clientA = getAiClient();
    expect(clientA.baseURL).toBe("https://api.x.ai/v1");

    const clientB = getAiClient();
    expect(clientB).toBe(clientA);

    resetAiClientCache();
    const clientC = getAiClient();
    expect(clientC).not.toBe(clientA);
  });

  it("admin routes correctly update settings without storing API keys or URLs", async () => {
    let storedSettings = SystemSettingsSchema.parse({
      aiModel: "grok-4.5",
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
    expect((getData.settings as any).aiBaseUrl).toBeUndefined();
    expect((getData.settings as any).aiApiKey).toBeUndefined();
    expect(getData.settings.aiModel).toBe("grok-4.5");

    // 2. PUT /api/settings
    const putRes = await fastify.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        aiModel: "grok-beta",
        reason: "Updated AI model from web UI",
      },
    });
    expect(putRes.statusCode).toBe(200);
    const putData = JSON.parse(putRes.body);
    expect((putData.settings as any).aiBaseUrl).toBeUndefined();
    expect((putData.settings as any).aiApiKey).toBeUndefined();
    expect(putData.settings.aiModel).toBe("grok-beta");
    expect(putData.revision).toBe(2);
    expect(mockBroadcaster.broadcast).toHaveBeenCalledWith("settings:updated", { revision: 2 });

    // 3. POST /api/settings/test-ai (smoke tests connection handler)
    const testRes = await fastify.inject({
      method: "POST",
      url: "/api/settings/test-ai",
      payload: {
        model: "test-model",
      },
    });
    expect(testRes.statusCode).toBe(200);
    const testData = JSON.parse(testRes.body);
    expect(typeof testData.ok).toBe("boolean");
    expect(typeof testData.message).toBe("string");
  });
});
