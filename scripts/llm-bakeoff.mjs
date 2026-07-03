// LLM bake-off (docs/03 §2b): validates candidate models against a replica of
// Grantweaver's real agent turn. Gate = correct OpenAI-format tool calling with
// valid JSON args; rank = latency; quality = grounded multi-step synthesis.
//
// Usage:
//   BAKEOFF_BASE_URL=https://integrate.api.nvidia.com/v1 \
//   BAKEOFF_API_KEY=$NVAPI_KEY \
//   BAKEOFF_MODELS="stepfun-ai/step-3.7-flash,nvidia/nemotron-3-super-120b-a12b" \
//   node scripts/llm-bakeoff.mjs
//
// Defaults to the LLM_* env triple from .env when BAKEOFF_* are unset.

const BASE = process.env.BAKEOFF_BASE_URL ?? process.env.LLM_BASE_URL;
const KEY = process.env.BAKEOFF_API_KEY ?? process.env.LLM_API_KEY;
const MODELS = (process.env.BAKEOFF_MODELS ?? process.env.LLM_MODEL ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const TRIALS = Number(process.env.BAKEOFF_TRIALS ?? 3);

if (!BASE || !KEY || MODELS.length === 0) {
  console.error('Set BAKEOFF_BASE_URL/BAKEOFF_API_KEY/BAKEOFF_MODELS (or LLM_* fallbacks).');
  process.exit(1);
}

const TOOLS = [
  { type: 'function', function: {
    name: 'search_grants',
    description: 'Search live federal funding opportunities on Grants.gov. Returns opportunities with id, number, title, agency, close date, status, url.',
    parameters: { type: 'object', properties: { keyword: { type: 'string' } }, required: ['keyword'] } } },
  { type: 'function', function: {
    name: 'search_workspace',
    description: "Search this Slack workspace's messages in real time for impact evidence: program results, metrics, testimonials. Returns snippets with author, channel, date, permalink.",
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
];

const SYSTEM = `You are Grantweaver, a Slack agent for the nonprofit "Riverbend Youth Collective" (youth mentoring, Austin TX). Use tools to answer. Ground every claim in tool results: cite grant opportunity numbers and evidence permalinks. Never invent metrics.`;

const FIXTURES = {
  search_grants: JSON.stringify({ opportunities: [
    { id: '359841', number: 'ED-GRANTS-070126-002', title: 'Youth Mentoring Program Grants', agency: 'Dept of Education', close_date: '2026-08-15', status: 'posted', url: 'https://grants.gov/359841' },
  ]}),
  search_workspace: JSON.stringify({ results: [
    { author: 'Priya Nair', channel: '#program-updates', date: '2026-05-20', snippet: 'Spring cohort wrap: mentee attendance rose from 61% to 84% over the semester, and 9 of 12 seniors were accepted to college.', permalink: 'https://riverbend-demo.slack.com/archives/C01/p1747700000' },
  ]}),
};

async function chat(model, messages) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, max_tokens: 2048, temperature: 0.2, tools: TOOLS }),
    signal: AbortSignal.timeout(60000),
  });
  const ms = Date.now() - t0;
  if (!res.ok) return { ok: false, ms, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 150)}` };
  const data = await res.json();
  return { ok: true, ms, msg: data.choices?.[0]?.message };
}

async function trialOnce(model) {
  const t = { turns: [], calls: [] };
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: "We're going after federal youth mentoring money. Find what's open, pull our strongest attendance evidence from the workspace, and give me three talking points for why we deserve it." },
  ];
  for (let turn = 0; turn < 5; turn++) {
    const r = await chat(model, messages);
    if (!r.ok) { t.error = r.error; return t; }
    t.turns.push(r.ms);
    const call = r.msg?.tool_calls?.[0];
    if (!call) {
      const text = r.msg?.content ?? '';
      t.final = {
        cites_grant: text.includes('ED-GRANTS-070126-002'),
        cites_metric: /61%|84%/.test(text),
        used_both_tools: t.calls.some((c) => c.name === 'search_grants') && t.calls.some((c) => c.name === 'search_workspace'),
        len: text.length,
      };
      return t;
    }
    let args;
    try { args = JSON.parse(call.function.arguments || '{}'); }
    catch { t.badjson = true; return t; }
    t.calls.push({ name: call.function.name, args });
    messages.push({ role: 'assistant', content: r.msg.content ?? '', tool_calls: [call] });
    messages.push({ role: 'tool', tool_call_id: call.id, content: FIXTURES[call.function.name] ?? '{"error":"unknown tool"}' });
  }
  t.loopout = true;
  return t;
}

let anyFail = false;
for (const model of MODELS) {
  console.log(`\n=== ${model} ===`);
  const latencies = [];
  let passes = 0;
  for (let i = 0; i < TRIALS; i++) {
    const t = await trialOnce(model);
    const pass = !!(t.final?.cites_grant && t.final?.cites_metric && t.final?.used_both_tools && !t.badjson);
    if (pass) passes++;
    latencies.push(...t.turns);
    console.log(` trial ${i}: ${pass ? 'PASS' : 'FAIL'} · calls=[${t.calls.map((c) => c.name).join(',')}] · turns_ms=[${t.turns.join(',')}]${t.error ? ' · ' + t.error : ''}${t.badjson ? ' · bad args JSON' : ''}${t.loopout ? ' · loop cap hit' : ''}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  const sorted = latencies.sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
  console.log(` => ${passes}/${TRIALS} pass · p50 turn ${p50}ms · max ${sorted.at(-1) ?? 0}ms`);
  if (passes < TRIALS) anyFail = true;
}
process.exit(anyFail ? 1 : 0);
