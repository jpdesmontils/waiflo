import BaseMCPAdapter from './base_adapter.js';

const TOOL_NAME_MAP = {
  'geocoding.forward': 'maps.search_places',
  'geocoding.reverse': 'maps.reverse_geocode'
};

const INVERSE_TOOL_NAME_MAP = Object.fromEntries(
  Object.entries(TOOL_NAME_MAP).map(([source, target]) => [target, source])
);

export class MapboxAdapter extends BaseMCPAdapter {
  normalizeToolDefinition(tool) {
    return {
      ...tool,
      name: TOOL_NAME_MAP[tool?.name] || tool?.name,
      description: tool?.description || 'Mapbox MCP tool'
    };
  }

  denormalizeToolName(toolName) {
    return INVERSE_TOOL_NAME_MAP[toolName] || toolName;
  }
}

export default MapboxAdapter;
