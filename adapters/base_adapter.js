export class BaseMCPAdapter {
  normalizeToolDefinition(tool) {
    return { ...tool };
  }

  normalizeInput(_toolName, input) {
    return input ?? {};
  }

  normalizeOutput(_toolName, output) {
    return output;
  }

  /**
   * Map a normalized tool name back to the server tool name.
   * Default is passthrough.
   */
  denormalizeToolName(toolName) {
    return toolName;
  }
}

export default BaseMCPAdapter;
