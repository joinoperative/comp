import { createGatewayProvider } from '@ai-sdk/gateway';
import type { OpenAIResponsesProviderOptions } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { JSONValue } from 'ai';
import { fallbackModelId, isAiGatewayConfigured, resolveModel } from '@/lib/ai/resolve-model';

export async function getAvailableModels() {
  if (!isAiGatewayConfigured()) {
    // Operative: no Vercel AI Gateway — offer the OpenAI fallback model only.
    const id = `openai/${fallbackModelId()}`;
    return [{ id, name: id }];
  }
  const gateway = gatewayInstance();
  const response = await gateway.getAvailableModels();
  return response.models.map((model) => ({ id: model.id, name: model.name }));
}

export interface ModelOptions {
  model: LanguageModelV3;
  providerOptions?: Record<string, Record<string, JSONValue>>;
  headers?: Record<string, string>;
}

export function getModelOptions(
  modelId: string,
  options?: { reasoningEffort?: 'minimal' | 'low' | 'medium' },
): ModelOptions {
  if (!isAiGatewayConfigured()) {
    // Operative: direct provider; the Responses-API reasoning options below
    // assume the gateway's OpenAI reasoning models, so they are not applied.
    return { model: resolveModel(modelId) };
  }
  const gateway = gatewayInstance();

  return {
    model: gateway(modelId),
    providerOptions: {
      openai: {
        include: ['reasoning.encrypted_content'],
        reasoningEffort: options?.reasoningEffort ?? 'low',
        reasoningSummary: 'auto',
        serviceTier: 'priority',
      } satisfies OpenAIResponsesProviderOptions,
    },
  };
}

function gatewayInstance() {
  return createGatewayProvider({
    baseURL: process.env.AI_GATEWAY_BASE_URL,
  });
}
