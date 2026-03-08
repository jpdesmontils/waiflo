import Anthropic from '@anthropic-ai/sdk';
import { cLLM } from './base.js';

export class AnthropicProvider extends cLLM {
  constructor(apiKey) {
    super(apiKey);
    this._client = new Anthropic({ apiKey });
  }

  async *stream({ model, system, userPrompt, temperature = 0, maxTokens = 2048 }) {
    const streamObj = this._client.messages.stream({
      model,
      max_tokens: maxTokens,
      temperature,
      system: system || '',
      messages: [{ role: 'user', content: userPrompt }],
    });

    for await (const chunk of streamObj) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.type === 'text_delta') {
        yield { text: chunk.delta.text };
      }
    }

    // Expose final message metadata for usage stats
    const final = await streamObj.finalMessage();
    this._lastUsage = final.usage;
    this._lastFullText = final.content.map(b => b.text || '').join('');
  }
}
