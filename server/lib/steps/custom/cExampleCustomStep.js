import cGenericStep from '../cGenericStep.js';

export class cExampleCustomStep extends cGenericStep {
  // Public API
  async run(inputs = {}) {
    const message = this.#buildMessage(inputs);
    return {
      greeting: message,
      params: this.stepDefinition?.ws_params || {}
    };
  }

  // Private helpers
  #buildMessage(inputs) {
    const name = typeof inputs.name === 'string' && inputs.name.trim() ? inputs.name.trim() : 'world';
    return `Hello ${name}`;
  }
}

export default cExampleCustomStep;
