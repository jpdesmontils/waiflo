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

  // Convert normalized messages to Anthropic API format.
  _toAnthropicMessages(messages) {
    const out = [];
    let pendingToolResults = [];

    for (const msg of messages) {
      if (msg.role === 'user') {
        if (pendingToolResults.length) {
          out.push({ role: 'user', content: pendingToolResults });
          pendingToolResults = [];
        }
        out.push({ role: 'user', content: msg.content });
      } else if (msg.role === 'assistant') {
        out.push({ role: 'assistant', content: msg.content });
      } else if (msg.role === 'assistant_tool_calls') {
        out.push({
          role: 'assistant',
          content: msg.calls.map(c => ({
            type: 'tool_use',
            id: c.id,
            name: c.name,
            input: c.arguments,
          })),
        });
      } else if (msg.role === 'tool_result') {
        // Anthropic batches all tool results into a single user turn.
        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: msg.call_id,
          content: msg.content,
        });
      }
    }

    if (pendingToolResults.length) {
      out.push({ role: 'user', content: pendingToolResults });
    }

    return out;
  }

  // Convert normalized tool definitions to Anthropic format.
  _toAnthropicTools(tools) {
    return tools.map(t => ({
      name: t.name,
      description: t.description || '',
      input_schema: t.inputSchema || { type: 'object', properties: {} },
    }));
  }

  async callWithTools({ model, system, messages, tools, temperature = 0, maxTokens = 2048 }) {
    const anthropicTools = this._toAnthropicTools(tools);
    const anthropicMessages = this._toAnthropicMessages(messages);
    console.log(`[DEBUG][Anthropic.callWithTools] model=${model} tools=${anthropicTools.map(t => t.name).join(',')} messages=${anthropicMessages.length} maxTokens=${maxTokens}`);

    const response = await this._client.messages.create({
      model,
      max_tokens: maxTokens,
      temperature,
      system: system || '',
      tools: anthropicTools,
      messages: anthropicMessages,
    });

    console.log(`[DEBUG][Anthropic.callWithTools] stop_reason="${response.stop_reason}" content_blocks=${response.content?.length} types=${response.content?.map(b => b.type).join(',')}`);

    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    if (toolUseBlocks.length > 0) {
      console.log(`[DEBUG][Anthropic.callWithTools] => tool_calls: [${toolUseBlocks.map(b => b.name).join(', ')}]`);
      return {
        type: 'tool_calls',
        calls: toolUseBlocks.map(b => ({ id: b.id, name: b.name, arguments: b.input })),
      };
    }

    const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    console.log(`[DEBUG][Anthropic.callWithTools] => text (no tool_use). stop_reason="${response.stop_reason}" text="${text.slice(0, 200)}"`);
    return { type: 'text', text };
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
