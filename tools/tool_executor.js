export class ToolExecutor {
  constructor({ runtime } = {}) {
    this.runtime = runtime;
  }

  async executeTool({ server, tool, input }) {
    return this.runtime.executeTool({ server, tool, input });
  }

  async listToolsForLLM(server, { openAIFormat = true } = {}) {
    return this.runtime.discoverTools(server, { openAIFormat });
  }
}

export default ToolExecutor;
