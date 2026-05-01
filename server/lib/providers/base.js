/**
 * cLLM — Abstract base class for all LLM providers.
 *
 * Each provider subclass must implement stream() and callWithTools().
 * complete() is provided here as a generic collector over stream().
 *
 * --- Normalized message format used by callWithTools() ---
 *
 * Input messages array:
 *   { role: "user",               content: string }
 *   { role: "assistant",          content: string }
 *   { role: "assistant_tool_calls", calls: [{ id, name, arguments: object }] }
 *   { role: "tool_result",        call_id: string, content: string }
 *
 * Normalized tool definition (MCP inputSchema shape):
 *   { name: string, description: string, inputSchema: { type, properties, required } }
 *
 * Return value:
 *   { type: "tool_calls", calls: [{ id, name, arguments: object }] }
 *   { type: "text",       text: string }
 */
export class cLLM {
  /** @param {string} apiKey */
  constructor(apiKey) {
    if (new.target === cLLM) throw new Error('cLLM is abstract — instantiate a subclass');
    this.apiKey = apiKey;
  }

  /**
   * Stream a completion as an async generator of token chunks.
   *
   * @param {object} params
   * @param {string} params.model
   * @param {string} [params.system]      - system prompt
   * @param {string} params.userPrompt    - user message
   * @param {number} [params.temperature]
   * @param {number} [params.maxTokens]
   * @yields {{ text: string }}
   */
  async *stream({ model, system, userPrompt, temperature, maxTokens, imageUrls }) { // eslint-disable-line
    throw new Error(`${this.constructor.name}.stream() not implemented`);
  }

  /**
   * Single non-streaming LLM turn with native tool-use.
   * Returns either a tool_calls decision or a text response.
   *
   * @param {object}   params
   * @param {string}   params.model
   * @param {string}   [params.system]
   * @param {object[]} params.messages    - normalized conversation history
   * @param {object[]} params.tools       - normalized tool definitions
   * @param {number}   [params.temperature]
   * @param {number}   [params.maxTokens]
   * @returns {Promise<{ type: "tool_calls"|"text", calls?: object[], text?: string }>}
   */
  async callWithTools({ model, system, messages, tools, temperature, maxTokens }) { // eslint-disable-line
    throw new Error(`${this.constructor.name}.callWithTools() not implemented`);
  }

  /**
   * Collect the full stream into a single string.
   * @param {object} params - same as stream()
   * @returns {Promise<{ fullText: string }>}
   */
  async complete(params) {
    let fullText = '';
    for await (const chunk of this.stream(params)) {
      fullText += chunk.text;
    }
    return { fullText };
  }
}
