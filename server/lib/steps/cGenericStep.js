export class cGenericStep {
  constructor(stepDefinition = {}, runtimeContext = {}) {
    this.stepDefinition = stepDefinition;
    this.runtimeContext = runtimeContext;
  }

  // Public API
  async execute(inputs = {}) {
    this.#validateInputEnvelope(inputs);
    await this.beforeExecute(inputs);
    const output = await this.run(inputs);
    await this.afterExecute(output, inputs);
    return this.buildSuccessResult(output);
  }

  async beforeExecute(_inputs) {}

  async run(_inputs) {
    throw new Error(`${this.constructor.name}.run(inputs) must be implemented by custom step class`);
  }

  async afterExecute(_output, _inputs) {}

  buildSuccessResult(output, meta = {}) {
    return {
      ok: true,
      step: this.stepDefinition?.ws_name || this.constructor.name,
      type: this.stepDefinition?.ws_type || 'custom',
      result: output,
      meta
    };
  }

  buildErrorResult(error, meta = {}) {
    return {
      ok: false,
      step: this.stepDefinition?.ws_name || this.constructor.name,
      type: this.stepDefinition?.ws_type || 'custom',
      error: {
        name: error?.name || 'Error',
        message: error?.message || String(error)
      },
      meta
    };
  }

  // Private helpers
  #validateInputEnvelope(inputs) {
    if (inputs == null || typeof inputs !== 'object' || Array.isArray(inputs)) {
      throw new Error('Custom step inputs must be an object');
    }
  }
}

export default cGenericStep;
