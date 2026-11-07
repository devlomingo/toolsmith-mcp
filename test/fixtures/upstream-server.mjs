// Minimal stdio MCP server used as an upstream in tests: one read tool, one
// destructive tool, one unannotated tool (destructive by MCP default).
import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const tools = [
  {
    name: 'read_note',
    description: 'Read a note',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'wipe_disk',
    description: 'Erase everything',
    inputSchema: { type: 'object', properties: {} },
    annotations: { destructiveHint: true },
  },
  {
    name: 'mystery',
    description: 'No annotations',
    inputSchema: { type: 'object', properties: {} },
  },
];
let wiped = 0;
serveStdio(() => {
  const s = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
  s.setRequestHandler('tools/list', async () => ({ tools }));
  s.setRequestHandler('tools/call', async (req) => {
    if (req.params.name === 'wipe_disk') wiped++;
    return { content: [{ type: 'text', text: JSON.stringify({ tool: req.params.name, wiped }) }] };
  });
  return s;
});
