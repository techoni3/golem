import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { validateMcpInput } from './schema.mjs';

const server = new Server({ name: 'golem-stack-certification', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'echo',
    description: 'Validate and echo a certification message.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['message'],
      properties: { message: { type: 'string', minLength: 1 } }
    }
  }]
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'echo') throw new Error(`unknown tool ${request.params.name}`);
  const input = validateMcpInput(request.params.arguments);
  return { content: [{ type: 'text', text: JSON.stringify({ message: input.message }) }] };
});

await server.connect(new StdioServerTransport());
