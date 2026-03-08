/**
 * MistralProvider — Mistral AI
 *
 * Mistral exposes an OpenAI-compatible API at api.mistral.ai/v1.
 * We reuse OpenAIProvider with a custom baseURL.
 *
 * Default model: mistral-large-latest
 * Docs: https://docs.mistral.ai/api/
 */
import { OpenAIProvider } from './openai.js';

export class MistralProvider extends OpenAIProvider {
  constructor(apiKey) {
    super(apiKey, {
      baseURL: 'https://api.mistral.ai/v1',
      defaultModel: 'mistral-large-latest',
    });
  }
}
