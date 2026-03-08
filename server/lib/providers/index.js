import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider }    from './openai.js';
import { PerplexityProvider } from './perplexity.js';
import { MistralProvider }   from './mistral.js';

export { cLLM } from './base.js';
export { AnthropicProvider, OpenAIProvider, PerplexityProvider, MistralProvider };

/** Known providers with their default model and key prefix hint */
export const PROVIDER_META = {
  anthropic:  { defaultModel: 'claude-sonnet-4-20250514', keyPrefix: 'sk-ant-', envVar: 'ANTHROPIC_API_KEY' },
  openai:     { defaultModel: 'gpt-4o',                   keyPrefix: 'sk-',     envVar: 'OPENAI_API_KEY'     },
  perplexity: { defaultModel: 'sonar-pro',                keyPrefix: 'pplx-',   envVar: 'PERPLEXITY_API_KEY' },
  mistral:    { defaultModel: 'mistral-large-latest',     keyPrefix: null,      envVar: 'MISTRAL_API_KEY'    },
};

/**
 * Factory: instantiate the right cLLM subclass.
 * @param {string} name  - provider name (anthropic | openai | perplexity | mistral)
 * @param {string} apiKey
 * @returns {import('./base.js').cLLM}
 */
export function createProvider(name, apiKey) {
  switch (name) {
    case 'anthropic':  return new AnthropicProvider(apiKey);
    case 'openai':     return new OpenAIProvider(apiKey);
    case 'perplexity': return new PerplexityProvider(apiKey);
    case 'mistral':    return new MistralProvider(apiKey);
    default: throw new Error(`Unknown LLM provider: "${name}". Supported: anthropic, openai, perplexity, mistral`);
  }
}
