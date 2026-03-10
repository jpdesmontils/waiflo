import Anthropic from '@anthropic-ai/sdk';
import { cLLM } from './base.js';

function guessMediaType(url, fallback = 'image/jpeg') {
  const clean = (url || '').split('?')[0].toLowerCase();
  if (clean.endsWith('.png')) return 'image/png';
  if (clean.endsWith('.gif')) return 'image/gif';
  if (clean.endsWith('.webp')) return 'image/webp';
  if (clean.endsWith('.jpg') || clean.endsWith('.jpeg')) return 'image/jpeg';
  return fallback;
}

async function downloadImageAsBase64(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch image (${resp.status}) for ${url}`);
  const mediaType = (resp.headers.get('content-type') || '').split(';')[0] || guessMediaType(url);
  const bytes = new Uint8Array(await resp.arrayBuffer());

  return {
    media_type: mediaType,
    data: Buffer.from(bytes).toString('base64')
  };
}

export class AnthropicProvider extends cLLM {
  constructor(apiKey) {
    super(apiKey);
    this._client = new Anthropic({ apiKey });
  }

  async *stream({ model, system, userPrompt, imageUrls = [], temperature = 0, maxTokens = 2048 }) {
    const content = [{ type: 'text', text: userPrompt }];

    for (const url of (imageUrls || [])) {
      const source = await downloadImageAsBase64(url);
      content.push({ type: 'image', source: { type: 'base64', ...source } });
    }

    const streamObj = this._client.messages.stream({
      model,
      max_tokens: maxTokens,
      temperature,
      system: system || '',
      messages: [{ role: 'user', content }],
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
