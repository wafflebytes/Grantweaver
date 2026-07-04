// Server-rendered /org/{token} evidence-index page. Zero
// client JS beyond the theme toggle; inline CSS extends site/style.css's
// tokens so it reads as the same product. Data is counts+links only — the
// same no-message-content rule as the evidence_index table itself.
import { db } from '../services/db.js';
import { fmtDate } from '../surfaces/cards.js';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STRENGTH_ORDER = { star: 0, solid: 1, weak: 2 };
const STRENGTH_ICON = { star: '⭐', solid: '●', weak: '○' };

function themeRows(index) {
  const byTheme = new Map();
  for (const row of index) {
    if (!byTheme.has(row.theme)) byTheme.set(row.theme, { theme: row.theme, channels: [], strength: row.strength, hits: 0, hasFiles: false, permalinks: [] });
    const t = byTheme.get(row.theme);
    t.channels.push(row.channel_name ? `#${row.channel_name}` : `#${row.channel_id}`);
    t.hits += row.hits ?? 0;
    t.hasFiles = t.hasFiles || row.has_files;
    t.permalinks.push(...(row.permalinks ?? []));
    if (STRENGTH_ORDER[row.strength] < STRENGTH_ORDER[t.strength]) t.strength = row.strength;
  }
  return [...byTheme.values()].sort((a, b) => STRENGTH_ORDER[a.strength] - STRENGTH_ORDER[b.strength] || b.hits - a.hits);
}

function expiredPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Grantweaver — link expired</title>${STYLE}</head><body>
<div class="wrap card" style="max-width:480px;margin:80px auto;text-align:center">
  <h1>🧶 This link has expired</h1>
  <p>Ask Grantweaver for a fresh one — type <code>/grantweaver index</code> in Slack.</p>
</div></body></html>`;
}

const STYLE = `<style>
:root{--green:#1B4332;--green-deep:#143528;--green-soft:#2D6A4F;--gold:#D4A017;--gold-soft:#E8C25A;--gold-pale:#F6E8C2;
--cream:#FAF7F0;--paper:#FFFFFF;--ink:#1f2a24;--muted:#5c6b62;--radius:18px;
--on-green:#FAF7F0;
--shadow:0 1px 3px rgba(27,67,50,.06),0 8px 24px -12px rgba(27,67,50,.14);
--display:'SF Pro Rounded',ui-rounded,-apple-system,'Segoe UI',Roboto,sans-serif;--body:-apple-system,'Segoe UI',Roboto,sans-serif}
@media (prefers-color-scheme:dark){:root{--cream:#121a15;--paper:#182019;--ink:#eef2ef;--muted:#9db0a6;
--shadow:0 1px 3px rgba(0,0,0,.3),0 8px 24px -12px rgba(0,0,0,.5)}}
/* --cream doubles as the page background AND (via --on-green) the header's
   text color on its dark green gradient — dark mode redefines --cream to a
   near-black page background, which was ALSO darkening the header text to
   match, making the evidence-page header numbers nearly unreadable
   (live-reported: poor contrast on "surfaced / applied for / evidence
   items / hrs saved"). --on-green stays a fixed light color regardless of
   theme since the header's background never changes with theme either. */
*{box-sizing:border-box;margin:0}
body{font-family:var(--body);color:var(--ink);background:var(--cream);line-height:1.6;padding:0 0 48px}
.wrap{max-width:760px;margin:0 auto;padding:0 20px}
h1,h2,h3{font-family:var(--display);letter-spacing:-.02em;color:var(--green)}
@media (prefers-color-scheme:dark){h1,h2,h3{color:var(--gold-soft)}}
header.top{background:radial-gradient(120% 140% at 50% -20%,var(--green-soft) 0%,var(--green) 45%,var(--green-deep) 100%);color:var(--on-green);padding:36px 0}
header.top h1{color:var(--on-green);font-size:1.6rem;margin-bottom:4px}
header.top .meta{color:var(--on-green);opacity:.85;font-size:.9rem}
.meter{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-top:18px}
.meter div{background:rgba(255,255,255,.14);border-radius:12px;padding:10px 14px;color:var(--on-green)}
.meter b{display:block;font-family:var(--display);font-size:1.3rem;color:var(--on-green)}
.card{background:var(--paper);border-radius:var(--radius);box-shadow:var(--shadow);padding:24px;margin-top:24px}
.chip{display:inline-block;font-size:.78rem;background:rgba(212,160,23,.14);color:var(--gold);border-radius:999px;padding:3px 10px;margin:2px 4px 2px 0}
.theme-row{padding:14px 0;border-bottom:1px solid rgba(27,67,50,.08)}
.theme-row:last-child{border-bottom:none}
.theme-row .label{font-weight:600;font-family:var(--display)}
.bar{height:8px;background:rgba(27,67,50,.08);border-radius:4px;overflow:hidden;margin:8px 0}
.bar > div{height:100%;background:linear-gradient(90deg,var(--gold-soft),var(--gold))}
.channels a{color:var(--muted);text-decoration:none;font-size:.85rem;margin-right:10px}
.pipeline-row{display:flex;justify-content:space-between;gap:12px;padding:8px 0;border-bottom:1px solid rgba(27,67,50,.06);font-size:.92rem}
.badge{font-size:.72rem;padding:2px 8px;border-radius:999px;background:rgba(45,106,79,.12)}
footer{margin-top:32px;font-size:.82rem;color:var(--muted);text-align:center}
footer a{color:var(--muted)}
.empty{color:var(--muted);font-style:italic}
</style>`;

export async function renderOrgPage(teamId) {
  if (!teamId) return expiredPage();
  const [org, index, pipeline, meter] = await Promise.all([
    db.getOrg(teamId), db.listIndex(teamId), db.listOpportunities(teamId), db.impactMeter(teamId),
  ]);
  if (!org) return expiredPage();

  const themes = themeRows(index);
  const facts = org.eligibility_facts ?? {};

  const themeHtml = themes.length
    ? themes.map((t) => {
        const pct = Math.max(6, Math.min(100, t.hits * 12));
        return `<div class="theme-row">
          <div class="label">${STRENGTH_ICON[t.strength]} ${esc(t.theme)}${t.hasFiles ? ' 📎' : ''}</div>
          <div class="bar"><div style="width:${pct}%"></div></div>
          <div class="channels">${t.channels.map((c) => `<span>${esc(c)}</span>`).join(' · ')} — ${t.hits} hit${t.hits === 1 ? '' : 's'}
          ${t.permalinks.slice(0, 3).map((p) => `· <a href="${esc(p)}" target="_blank" rel="noopener">view in Slack</a>`).join(' ')}</div>
        </div>`;
      }).join('')
    : `<p class="empty">No index yet — ask Grantweaver to scan your workspace.</p>`;

  const pipelineHtml = pipeline.length
    ? pipeline.slice(0, 10).map((o) => `<div class="pipeline-row">
        <span>${esc(o.title)}</span>
        <span><span class="badge">${esc(o.stage)}</span> ${o.fit_score != null ? `· fit ${o.fit_score}/100` : ''} · ${o.close_date ? esc(fmtDate(o.close_date)) : 'rolling'}
        ${o.checklist?.length ? `· ${o.checklist.filter((c) => c.done).length}/${o.checklist.length}` : ''}</span>
      </div>`).join('')
    : `<p class="empty">No pipeline yet.</p>`;

  const built = org.index_built_at ? new Date(org.index_built_at).toISOString().slice(0, 10) : 'not yet';

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(org.org_name ?? 'Organization')} — Evidence Index — Grantweaver</title>${STYLE}</head><body>
<header class="top"><div class="wrap">
  <h1>🧶 ${esc(org.org_name ?? 'Your organization')} — Evidence Index</h1>
  <div class="meta">Built ${built}</div>
  <div class="meter">
    <div><b>${meter.surfaced}</b>surfaced</div>
    <div><b>$${meter.applied.toLocaleString()}</b>applied for</div>
    <div><b>${meter.evidence}</b>evidence items</div>
    <div><b>${meter.hoursSaved}</b>hrs saved (est.)</div>
  </div>
</div></header>
<div class="wrap">
  <div class="card">
    <h2>Profile</h2>
    <blockquote>${esc(org.mission ?? 'No mission on file yet.')}</blockquote>
    <div>${(org.focus_areas ?? []).map((f) => `<span class="chip">${esc(f)}</span>`).join('') || '<span class="empty">No focus areas set.</span>'}</div>
    <p style="margin-top:10px;color:var(--muted);font-size:.9rem">
      ${esc(org.state ?? '—')} · ${esc(org.org_size ?? '—')} team ·
      ${esc(facts.entity_type ?? 'entity type unknown')} · ${esc(String(facts.years_operating ?? '—'))} yrs ·
      SAM/UEI: ${facts.has_sam_uei == null ? 'unknown' : facts.has_sam_uei ? 'yes' : 'no'}
    </p>
  </div>
  <div class="card">
    <h2>Evidence Index</h2>
    ${themeHtml}
  </div>
  <div class="card">
    <h2>Pipeline</h2>
    ${pipelineHtml}
  </div>
  <footer>
    Grantweaver never stores message content — this page is built from counts and links only.<br>
    <a href="/privacy.html">Privacy</a> · <a href="/support.html">Support</a>
  </footer>
</div>
</body></html>`;
}
