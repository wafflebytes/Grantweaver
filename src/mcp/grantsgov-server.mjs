import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API = 'https://api.grants.gov/v1/api';
const cache = new Map(); // key -> {at, data}
const TTL = 10 * 60 * 1000;

async function post(path, body) {
  const key = path + JSON.stringify(body);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const r = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) {
    if (hit) { console.warn(`[grantsgov] ${r.status} — serving stale cache`); return hit.data; }
    throw new Error(`grants.gov ${path} → HTTP ${r.status}`);
  }
  const data = await r.json();
  cache.set(key, { at: Date.now(), data });
  return data;
}

function text(obj) { return { content: [{ type: 'text', text: JSON.stringify(obj) }] }; }

// Grants.gov returns award amounts as numbers, numeric strings, or the
// literal string "none" — normalize to number | null so consumers never
// see "$NaN" or feed "none" into a NUMERIC column.
function money(v) {
  if (v == null || v === '' || String(v).toLowerCase() === 'none') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function buildServer() {
  const server = new McpServer({ name: 'grantsgov-mcp', version: '0.1.0' });

  server.tool(
    'search_grants',
    'Search live US federal funding opportunities on Grants.gov. Returns posted/forecasted opportunities with title, agency, close date, and detail URL. Public data; no auth.',
    {
      keyword: z.string().describe('Search keywords, e.g. "youth mentoring"'),
      oppStatuses: z.string().default('posted|forecasted').describe('posted | forecasted | closed, pipe-separated'),
      rows: z.number().int().min(1).max(25).default(10),
      fundingCategories: z.string().optional().describe('Comma-separated category codes: ED education, HL health, EN environment, CD community development, IS income security'),
      agencies: z.string().optional().describe('Comma-separated agency codes, e.g. "HHS,ED"'),
      eligibilities: z.string().optional().describe('Comma-separated applicant-eligibility codes; "12" = 501(c)(3) nonprofits'),
    },
    async ({ keyword, oppStatuses, rows, fundingCategories, agencies, eligibilities }) => {
      const data = await post('/search2', {
        keyword, oppStatuses, rows, startRecordNum: 0,
        ...(fundingCategories ? { fundingCategories } : {}),
        ...(agencies ? { agencies } : {}),
        ...(eligibilities ? { eligibilities } : {}),
      });
      const hits = (data?.data?.oppHits ?? []).map((h) => ({
        opp_id: String(h.id),
        opp_number: h.number,
        title: h.title,
        agency: h.agencyName ?? h.agency,
        close_date: h.closeDate ?? null,
        open_date: h.openDate ?? null,
        status: h.oppStatus,
        url: `https://grants.gov/search-results-detail/${h.id}`,
      }));
      return text({ total: data?.data?.hitCount ?? hits.length, opportunities: hits });
    },
  );

  server.tool(
    'fetch_opportunity',
    'Fetch full details for one Grants.gov opportunity by id: synopsis, eligibility, award ceiling/floor, close date, grantor contact email.',
    { opp_id: z.string() },
    async ({ opp_id }) => {
      const data = await post('/fetchOpportunity', { opportunityId: Number(opp_id) });
      const s = data?.data ?? {};
      const syn = s.synopsis ?? {};
      return text({
        opp_id,
        opp_number: s.opportunityNumber,
        title: s.opportunityTitle,
        agency: syn.agencyName,
        synopsis: String(syn.synopsisDesc ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 4000),
        award_ceiling: money(syn.awardCeiling),
        award_floor: money(syn.awardFloor),
        close_date: syn.responseDate,
        eligibility: String(syn.applicantEligibilityDesc ?? '').slice(0, 1500),
        contact: syn.agencyContactEmail,
        // Live-verified field names: applicantTypes lives on
        // `synopsis`, not the top-level record; attachment folders are
        // top-level. We surface names only — D10 says never download them.
        applicant_types: (syn.applicantTypes ?? []).map((t) => ({ id: t.id, description: t.description })),
        docs: (s.synopsisAttachmentFolders ?? []).map((f) => f.name).filter(Boolean),
      });
    },
  );

  return server;
}

// ── entrypoint ─────────────────────────────────────────────────────────
const mode = process.argv.includes('--http') ? 'http' : 'stdio';
if (mode === 'stdio') {
  const server = buildServer();
  await server.connect(new StdioServerTransport());
} else {
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const http = await import('node:http');
  const srv = http.createServer(async (req, res) => {
    if (!req.url?.startsWith('/mcp')) { res.writeHead(404).end(); return; }
    // Stateless one-shot pattern (simplest for demo); see SDK docs for sessions.
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  srv.listen(7801, () => console.log('grantsgov-mcp listening on :7801/mcp'));
}
