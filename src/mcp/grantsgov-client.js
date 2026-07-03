import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

let clientPromise = null;

async function getClient() {
  clientPromise ??= (async () => {
    const c = new Client({ name: 'grantweaver-app', version: '0.1.0' });
    if (process.env.GRANTSGOV_MCP_TRANSPORT === 'http') {
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      await c.connect(new StreamableHTTPClientTransport(new URL(process.env.GRANTSGOV_MCP_URL)));
    } else {
      await c.connect(new StdioClientTransport({
        command: 'node', args: ['src/mcp/grantsgov-server.mjs'],
      }));
    }
    return c;
  })().catch((e) => { clientPromise = null; throw e; });
  return clientPromise;
}

async function callTool(name, args) {
  const c = await getClient();
  const res = await c.callTool({ name, arguments: args });
  const payload = res?.content?.[0]?.text ?? '{}';
  return JSON.parse(payload);
}

export const grantsGov = {
  async search({ keyword, oppStatuses = 'posted|forecasted', rows = 10 }) {
    const out = await callTool('search_grants', { keyword, oppStatuses, rows });
    return out.opportunities ?? [];
  },
  async fetchOpportunity(oppId) {
    return callTool('fetch_opportunity', { opp_id: String(oppId) });
  },
};
