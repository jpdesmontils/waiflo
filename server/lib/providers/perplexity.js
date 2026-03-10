/**
 * PerplexityProvider — Perplexity AI
 *
 * Perplexity exposes an OpenAI-compatible chat completions API.
 * We reuse OpenAIProvider with a custom baseURL.
 *
 * Default model: sonar-pro
 * Docs: https://docs.perplexity.ai/reference/post_chat_completions
 */
import { OpenAIProvider } from './openai.js';

export class PerplexityProvider extends OpenAIProvider {
  constructor(apiKey) {
    super(apiKey, {
      baseURL: 'https://api.perplexity.ai',
      defaultModel: 'sonar-pro',
      supportsImages: false,
    });
  }
}
