export const FIELD_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'image_url'];

export const NODE_W = 280;
export const NODE_H = 164;

export const TYPE_COLORS = {
  prompt: '#f59e0b',
  api: '#2dd4bf',
  webpage: '#22d3ee',
  transform: '#60a5fa',
  tool: '#a78bfa',
  custom: '#fb923c',
  script: '#fb923c'
};

export const DEMO_WORKFLOW = {
  lang_name: 'demo_pipeline',
  steps: [
    {
      ws_name: 'extract_entities',
      ws_type: 'prompt',
      ws_llm: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', temperature: 0 },
      ws_system_prompt: 'You are an information extraction expert. Extract named entities from text with precision.',
      ws_prompt_template: 'Extract all named entities from the following text:\n\n{{text}}\n\nGroup them by type (person, org, location, etc).',
      ws_inputs_schema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
      ws_output_schema: { type: 'object', required: ['entities'], properties: { entities: { type: 'array' }, summary: { type: 'string' } } }
    },
    {
      ws_name: 'enrich_data',
      ws_type: 'api',
      ws_api: { method: 'GET', url: 'https://api.example.com/enrich/{{entity_id}}' },
      ws_inputs_schema: { type: 'object', required: ['entity_id'], properties: { entity_id: { type: 'string' } } },
      ws_output_schema: { type: 'object', required: [], properties: { enriched: { type: 'object' }, confidence: { type: 'number' } } }
    },
    {
      ws_name: 'generate_report',
      ws_type: 'prompt',
      ws_llm: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', temperature: 0.3 },
      ws_system_prompt: 'You are a professional report writer. Generate clear, structured, actionable reports.',
      ws_prompt_template: 'Write a report based on:\n- Entities: {{entities}}\n- Enriched data: {{enriched}}\n\nOutput format: {{ws_output_schema}}',
      ws_inputs_schema: { type: 'object', required: ['entities', 'enriched'], properties: { entities: { type: 'array' }, enriched: { type: 'object' } } },
      ws_output_schema: { type: 'object', required: ['report'], properties: { report: { type: 'string' }, confidence: { type: 'number' }, recommendations: { type: 'array' } } }
    }
  ],
  workflows: [{
    wf_name: 'demo_pipeline',
    wf_nodes: [
      { step_id: 'node_extract', ws_ref: 'extract_entities', depends_on: [] },
      { step_id: 'node_enrich', ws_ref: 'enrich_data', depends_on: ['node_extract'] },
      { step_id: 'node_report', ws_ref: 'generate_report', depends_on: ['node_enrich'] }
    ]
  }]
};

export const PROVIDER_MODEL_HINTS = {
  anthropic: 'claude-sonnet-4-20250514',
  openai: 'gpt-4o',
  perplexity: 'sonar-pro',
  mistral: 'mistral-large-latest'
};

export const PROVIDER_KEY_PLACEHOLDERS = {
  anthropic: 'sk-ant-api03-…',
  openai: 'sk-…',
  perplexity: 'pplx-…',
  mistral: 'your-mistral-key'
};
