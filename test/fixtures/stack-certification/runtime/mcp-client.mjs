import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const serverPath = process.argv[2];
if (!serverPath) throw new Error('expected rendered server path');
const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath] });
const client = new Client({ name: 'golem-stack-certification-client', version: '1.0.0' });
await client.connect(transport);
try {
  const tools = await client.listTools();
  assert(tools.tools.some((tool) => tool.name === 'echo'), 'isolated MCP render omitted echo tool');
  const result = await client.callTool({ name: 'echo', arguments: { message: 'mcp' } });
  assert.equal(result.content[0].text, '{"message":"mcp"}');
  process.stdout.write(`${JSON.stringify({ tools: tools.tools.length, echo: result.content[0].text })}\n`);
} finally {
  await client.close();
}
