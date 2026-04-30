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

  // Convert normalized messages to OpenAI API format.
  _toOpenAIMessages(system, messages) {
    const out = [];
    if (system) out.push({ role: 'system', content: system });

    for (const msg of messages) {
      if (msg.role === 'user') {
        out.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        out.push({ role: 'assistant', content: msg.content });
      } else if (msg.role === 'assistant_tool_calls') {
        out.push({
          role: 'assistant',
          content: null,
          tool_calls: msg.calls.map(c => ({
            id: c.id,
            type: 'function',
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          })),
        });
      } else if (msg.role === 'tool_result') {
        out.push({ role: 'tool', tool_call_id: msg.call_id, content: msg.content });
      }
    }

    return out;
  }

  // Convert normalized tool definitions to OpenAI format.
  _toOpenAITools(tools) {
    return tools.map(t => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.inputSchema || { type: 'object', properties: {} },
      },
    }));
  }

  async callWithTools({ model, system, messages, tools, temperature = 0, maxTokens = 2048 }) {
    const response = await this._client.chat.completions.create({
      model: model || this._defaultModel,
      temperature,
      tools: this._toOpenAITools(tools),
      tool_choice: 'auto',
      messages: this._toOpenAIMessages(system, messages),
    });

    const choice = response.choices?.[0];
    const toolCalls = choice?.message?.tool_calls;

    if (toolCalls?.length > 0) {
      return {
        type: 'tool_calls',
        calls: toolCalls.map(tc => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments || '{}'),
        })),
      };
    }

    return { type: 'text', text: choice?.message?.content || '' };
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
      // max_tokens: maxTokens,
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
