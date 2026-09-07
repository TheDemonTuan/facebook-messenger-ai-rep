import type { ProviderCapabilities } from "@messenger/contracts";

export interface CapabilityRule {
  id: string;
  baseUrlPattern?: RegExp | string;
  modelPattern?: RegExp | string;
  apiFormat?: "OPENAI_COMPATIBLE" | "ANTHROPIC_COMPATIBLE";
  capabilities: Partial<ProviderCapabilities>;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  text: true,
  imageInput: false,
  audioInput: false,
  audioTranscription: false,
  videoInput: false,
  structuredOutput: true,
};

// Verified capability rules based on provider documentation and verified endpoints
const VERIFIED_RULES: CapabilityRule[] = [
  // xAI verified endpoints
  {
    id: "xai-vision-models",
    baseUrlPattern: /api\.x\.ai/i,
    modelPattern: /^(grok-2-vision|grok-vision)/i,
    capabilities: {
      text: true,
      imageInput: true,
      audioInput: false,
      audioTranscription: false,
      videoInput: false,
      structuredOutput: true,
    },
  },
  {
    id: "xai-text-models",
    baseUrlPattern: /api\.x\.ai/i,
    modelPattern: /^(grok-2|grok-3|grok-4\.5|grok-beta)/i,
    capabilities: {
      text: true,
      imageInput: false,
      audioInput: false,
      audioTranscription: false,
      videoInput: false,
      structuredOutput: true,
    },
  },
  // OpenAI verified endpoints
  {
    id: "openai-vision-models",
    baseUrlPattern: /api\.openai\.com/i,
    modelPattern: /^(gpt-4o|gpt-4-turbo|chatgpt-4o)/i,
    capabilities: {
      text: true,
      imageInput: true,
      audioInput: false,
      audioTranscription: false,
      videoInput: false,
      structuredOutput: true,
    },
  },
  {
    id: "openai-text-only-models",
    baseUrlPattern: /api\.openai\.com/i,
    modelPattern: /^(gpt-4(?!o|-turbo)|gpt-3\.5)/i,
    capabilities: {
      text: true,
      imageInput: false,
      audioInput: false,
      audioTranscription: false,
      videoInput: false,
      structuredOutput: true,
    },
  },
  {
    id: "openai-whisper",
    baseUrlPattern: /api\.openai\.com/i,
    modelPattern: /^whisper/i,
    capabilities: {
      text: false,
      imageInput: false,
      audioInput: false,
      audioTranscription: true,
      videoInput: false,
      structuredOutput: false,
    },
  },
  // Anthropic verified endpoints
  {
    id: "anthropic-claude-multimodal",
    baseUrlPattern: /api\.anthropic\.com/i,
    modelPattern: /^claude-3/i,
    capabilities: {
      text: true,
      imageInput: true,
      audioInput: false,
      audioTranscription: false,
      videoInput: false,
      structuredOutput: true,
    },
  },
];

let customRules: CapabilityRule[] = [];

export function registerCapabilityRule(rule: CapabilityRule): void {
  customRules.unshift(rule);
}

export function resetCapabilityRules(): void {
  customRules = [];
}

export interface ResolveCapabilitiesParams {
  apiFormat?: string;
  baseUrl?: string;
  model?: string;
  explicitCapabilities?: Partial<ProviderCapabilities>;
}

/**
 * Resolves verified capabilities for a provider connection and model.
 * Does NOT infer capabilities from text strings like "healthy" or unverified model naming.
 */
export function resolveProviderCapabilities(params: ResolveCapabilitiesParams): ProviderCapabilities {
  const { apiFormat, baseUrl = "", model = "", explicitCapabilities } = params;

  // 1. Start with safe defaults
  const resolved: ProviderCapabilities = { ...DEFAULT_CAPABILITIES };

  // 2. Check custom rules first, then verified rules
  const allRules = [...customRules, ...VERIFIED_RULES];
  for (const rule of allRules) {
    if (rule.apiFormat && apiFormat && rule.apiFormat !== apiFormat) {
      continue;
    }

    if (rule.baseUrlPattern) {
      if (typeof rule.baseUrlPattern === "string") {
        if (!baseUrl.toLowerCase().includes(rule.baseUrlPattern.toLowerCase())) continue;
      } else if (!rule.baseUrlPattern.test(baseUrl)) {
        continue;
      }
    }

    if (rule.modelPattern) {
      if (typeof rule.modelPattern === "string") {
        if (model.toLowerCase() !== rule.modelPattern.toLowerCase()) continue;
      } else if (!rule.modelPattern.test(model)) {
        continue;
      }
    }

    // Rule matched: merge capabilities
    Object.assign(resolved, rule.capabilities);
    break;
  }

  // 3. Explicit capabilities in configuration override any matched rules
  if (explicitCapabilities && typeof explicitCapabilities === "object") {
    for (const [key, value] of Object.entries(explicitCapabilities)) {
      if (typeof value === "boolean") {
        (resolved as unknown as Record<string, boolean>)[key] = value;
      }
    }
  }

  return resolved;
}
