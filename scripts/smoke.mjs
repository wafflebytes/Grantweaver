// Semi-automated smoke: automates what it can, prints a human checklist for the rest.
import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});
const results = [];
const check = (name, ok, note = '') => { results.push({ name, ok, note }); console.log(`${ok ? '✅' : '❌'} ${name} ${note}`); };

// 1. Health
const health = await fetch(`${process.env.APP_URL ?? 'http://localhost:3100'}/healthz`).then((r) => r.json()).catch(() => null);
check('healthz', !!health?.ok, health?.sha ?? '');

// 2. Grants.gov reachable, real shape
const gg = await fetch('https://api.grants.gov/v1/api/search2', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ keyword: 'youth mentoring', oppStatuses: 'posted', rows: 3, startRecordNum: 0 }),
}).then((r) => r.json()).catch(() => null);
check('grants.gov search2', (gg?.data?.oppHits?.length ?? 0) > 0, `hits=${gg?.data?.hitCount}`);

// 3. Compliance: no content columns anywhere in the schema
const cols = await pool.query(`
  SELECT table_name, column_name FROM information_schema.columns
  WHERE table_schema='public' AND column_name = ANY($1)`,
  [['text', 'snippet', 'content', 'message_text', 'body']]);
check('no content columns in DB', cols.rows.length === 0, JSON.stringify(cols.rows));

// 4. Evidence guard throws on content (mirrors test/db compliance guard — run
// here too so a smoke run against a real DB catches a regression, not just CI)
const { db } = await import('../src/services/db.js');
let guardThrew = false;
try {
  await db.saveEvidence('T_SMOKE', { channel_id: 'C1', message_ts: '1.1', text: 'should never be accepted' });
} catch { guardThrew = true; }
check('evidence guard rejects content keys', guardThrew);

// 5. Seeded state present (after demo prep)
const orgs = await pool.query('SELECT count(*)::int AS n FROM orgs');
check('org profile exists', orgs.rows[0].n >= 1);

// 6. Compliance: pending_intents.params (docs/22 §1) is a free-form JSONB
// column by necessity — the column-name scan above can't catch a drafted
// document's markdown landing in there (P1.2 bug, fixed in intents.js's
// in-process stash). Scan actual VALUES for tell-tale citation markdown.
const intentRows = await pool.query("SELECT id, params FROM pending_intents WHERE kind='draft'");
const leaked = intentRows.rows.filter((r) => /\]\(https?:\/\//.test(JSON.stringify(r.params)));
check('no drafted markdown in pending_intents.params', leaked.length === 0, leaked.map((r) => r.id).join(','));

console.log(`\n── MANUAL CHECKLIST ──
[ ] assistant greeting + suggested prompts on fresh thread
[ ] "Find grants for youth mentoring in Ohio" → ≥3 cards via MCP (check mcp logs)
[ ] Add to pipeline → Home tab shows it
[ ] "What evidence do we have that mentoring works?" → cards incl. attendance metric + survey stat; permalinks open
[ ] "Draft the LOI…" → canvas, cited, pipeline→drafting, no doubled title heading
[ ] 🧵 react → ephemeral + pointer row
[ ] /grantweaver digest → digest in #grants
[ ] guardrail suite: fabrication refusal, no auto-submit, private-channel silence,
    thin-evidence honesty, no interpersonal speculation, exact figures kept,
    memory-free re-search on repeat questions
`);
await pool.end();
process.exit(results.every((r) => r.ok) ? 0 : 1);
