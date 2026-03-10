import BaseMCPAdapter from './base_adapter.js';

const TOOL_NAME_MAP = {
  'places.search': 'maps.search_places'
};

const INVERSE_TOOL_NAME_MAP = Object.fromEntries(
  Object.entries(TOOL_NAME_MAP).map(([source, target]) => [target, source])
);

export class GoogleMapsAdapter extends BaseMCPAdapter {
  normalizeToolDefinition(tool) {
    const normalizedName = TOOL_NAME_MAP[tool?.name] || tool?.name;
    return {
      ...tool,
      name: normalizedName,
      description: tool?.description || 'Google Maps MCP tool'
    };
  }

  normalizeInput(toolName, input) {
    if (toolName !== 'maps.search_places') return input ?? {};

    const normalized = { ...(input || {}) };
    if (normalized.location && typeof normalized.location === 'object') {
      normalized.lat = normalized.lat ?? normalized.location.lat;
      normalized.lng = normalized.lng ?? normalized.location.lng;
      delete normalized.location;
    }

    return normalized;
  }

  normalizeOutput(toolName, output) {
    if (toolName !== 'maps.search_places') return output;

    if (!output || typeof output !== 'object') return output;

    return {
      ...output,
      items: Array.isArray(output.items)
        ? output.items
        : Array.isArray(output.results)
          ? output.results
          : []
    };
  }

  denormalizeToolName(toolName) {
    return INVERSE_TOOL_NAME_MAP[toolName] || toolName;
  }
}

export default GoogleMapsAdapter;
