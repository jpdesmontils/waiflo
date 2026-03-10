/**
 * cLLM — Abstract base class for all LLM providers.
 *
 * Each provider subclass must implement stream().
 * complete() is provided here as a generic collector over stream().
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
