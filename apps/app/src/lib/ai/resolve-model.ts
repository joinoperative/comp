import { createAnthropic } from '@ai-sdk/anthropic';
import { createGatewayProvider } from '@ai-sdk/gateway';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';

/**
 * Operative (self-hosting): resolve a gateway-style model id ("provider/model")
 * to a LanguageModel.
 *
 * Upstream routes every call through Vercel's AI Gateway, which needs
 * AI_GATEWAY_API_KEY (or Vercel OIDC). A self-hosted deployment typically has
 * only an OpenAI key, so:
 *   - AI_GATEWAY_API_KEY set  → the gateway, exactly as upstream (any provider)
 *   - "openai/<m>"            → @ai-sdk/openai (OPENAI_API_KEY)
 *   - "anthropic/<m>"         → @ai-sdk/anthropic when ANTHROPIC_API_KEY is set
 *   - anything else (google/…, or anthropic without a key)
 *                              → the OpenAI fallback model, AI_FALLBACK_MODEL
 *                                (default gpt-4.1-mini)
 */
export function isAiGatewayConfigured(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY);
}

export function fallbackModelId(): string {
  return process.env.AI_FALLBACK_MODEL || 'gpt-4.1-mini';
}

export function resolveModel(modelId: string): LanguageModelV3 {
  if (isAiGatewayConfigured()) {
    return createGatewayProvider({ baseURL: process.env.AI_GATEWAY_BASE_URL })(modelId);
  }
  const slash = modelId.indexOf('/');
  const provider = slash === -1 ? '' : modelId.slice(0, slash);
  const name = slash === -1 ? modelId : modelId.slice(slash + 1);
  if (provider === 'openai') {
    return createOpenAI()(name);
  }
  if (provider === 'anthropic' && process.env.ANTHROPIC_API_KEY) {
    return createAnthropic()(name);
  }
  return createOpenAI()(fallbackModelId());
}
