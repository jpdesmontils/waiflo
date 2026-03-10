import OpenAI from 'openai';
import { cLLM } from './base.js';

export class OpenAIProvider extends cLLM {
  /**
   * @param {string} apiKey
   * @param {object} [opts]
   * @param {string} [opts.baseURL]  - Override API base URL (used by Perplexity, Mistral compat)
   * @param {string} [opts.defaultModel]
   * @param {boolean} [opts.supportsImages] - Whether provider accepts OpenAI-style image_url content blocks
   */
  constructor(apiKey, { baseURL, defaultModel, supportsImages = true } = {}) {
    super(apiKey);
    this._client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
    this._defaultModel = defaultModel || 'gpt-4o';
    this._supportsImages = supportsImages;
  }

  async *stream({ model, system, userPrompt, imageUrls = [], temperature = 0, maxTokens = 2048 }) {
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });

    const effectiveImageUrls = this._supportsImages ? (imageUrls || []) : [];
    const userContent = [{ type: 'text', text: userPrompt }];
    for (const url of effectiveImageUrls) {
      userContent.push({ type: 'image_url', image_url: { url } });
    }

    messages.push({
      role: 'user',
      content: effectiveImageUrls.length ? userContent : userPrompt
    });

    const streamObj = await this._client.chat.completions.create({
      model: model || this._defaultModel,
      max_tokens: maxTokens,
      temperature,
      messages,
      stream: true,
    });

    let fullText = '';
    for await (const chunk of streamObj) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        fullText += delta;
        yield { text: delta };
      }
    }
    this._lastFullText = fullText;
  }
}
