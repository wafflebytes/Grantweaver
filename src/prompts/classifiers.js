// One-shot JSON classifiers — always temperature 0, always survive malformed
// output (a bad LLM response degrades the
// feature, never blocks the turn).
import { completeOnce, completeWithDeadline } from '../agent/llm.js';

// These classifiers are all explicitly "never throws, degrade to a
// heuristic" — a slow LLM call must never block the caller anywhere near
// completeOnce's ~8min theoretical worst case (see llm.js). 25s comfortably
// covers a real completion on a healthy backend while still leaving a
// live-streamed turn's timeline feeling responsive.
const CLASSIFIER_DEADLINE_MS = 25_000;

function truncate(s, n) { return (s ?? '').slice(0, n); }

export function fitBatchPrompt(org, notRelevantSignals, opps) {
  const facts = org?.eligibility_facts ?? {};
  const signalLines = (notRelevantSignals ?? []).map((s) => `- ${s.subject}: ${s.detail ?? ''}`).join('\n') || '(none yet)';
  const oppBlocks = opps.map((o) => [
    `=== ${o.opp_id} ===`,
    `Title: ${o.title}`,
    `Synopsis: ${truncate(o.synopsis, 600)}`,
    `Eligibility text: ${truncate(o.eligibility_desc, 400)}`,
    `Applicant types: ${(o.applicant_types ?? []).map((t) => t.description ?? t).join(', ') || 'unspecified'}`,
  ].join('\n')).join('\n\n');

  return `You assess grant fit for a nonprofit. Be blunt — a wrong "great fit" costs
them a week of wasted work; a wrong "not eligible" costs them a grant. When
the notice text is ambiguous, verdict is "unknown", never a guess.

ORGANIZATION
Name: ${org?.org_name ?? 'unknown'} · Mission: ${org?.mission ?? 'unknown'}
Focus areas: ${(org?.focus_areas ?? []).join(', ') || 'unknown'} · State: ${org?.state ?? 'unknown'} · Team size: ${org?.org_size ?? 'unknown'}
Entity: ${facts.entity_type ?? 'unknown'} · Operating years: ${facts.years_operating ?? 'unknown'} ·
SAM.gov/UEI registered: ${facts.has_sam_uei ?? 'unknown'}

THE ORG HAS REJECTED THESE BEFORE (avoid similar):
${signalLines}

OPPORTUNITIES
${oppBlocks}

For EACH opportunity return:
- fit_score 0-100: mission/focus/geography/size alignment. 80+ = "drop other
  work and look"; 50-79 = worth reviewing; <50 = show only if asked.
- fit_rationale: ≤120 chars, concrete ("after-school mentoring for OH youth
  matches priority area 2"), never generic ("good fit for your mission").
- eligibility_verdict: "eligible" only when the applicant types or
  eligibility text clearly include this org's entity type; "likely_not" when
  they clearly exclude it (say what's missing); else "unknown".
- eligibility_reason: ≤120 chars citing the deciding phrase.

Respond with ONLY a JSON array:
[{"opp_id":"…","fit_score":72,"fit_rationale":"…","eligibility_verdict":"eligible","eligibility_reason":"…"}]`;
}

export function checklistPrompt(opp) {
  return `Extract the application requirements checklist from this federal funding
notice. Only requirements the APPLICANT must satisfy or produce; skip agency
boilerplate.

NOTICE: ${opp.title}
${truncate(opp.synopsis, 3000)}
Attachment names: ${(opp.docs ?? []).join(', ') || 'none listed'}
Applicant types: ${(opp.applicant_types ?? []).map((t) => t.description ?? t).join(', ') || 'unspecified'} · Close date: ${opp.close_date ?? 'unspecified'}

Return 5-12 items. Every federal notice gets a
{"id":"sam_uei","label":"Active SAM.gov registration + UEI","kind":"registration"}
item unless the notice explicitly waives it. kinds: document (things to
write), form_field (structured answers/forms), registration, logistics
(deadlines, page limits, submission mechanics). detail: page/word limits or
form numbers when stated. due_hint: only when the notice states an interim
date (LOI due, webinar).

ONLY JSON: [{"id":"narrative","label":"Project narrative","kind":"document","detail":"max 10 pages","due_hint":null}]`;
}

export function themePrompt(scanResults) {
  const rows = scanResults.map((r) => [
    `query: ${r.query_label}`, `channel_id: ${r.channel_id}`, `channel_name: ${r.channel_name}`,
    `permalink: ${r.permalink}`, `is_file: ${!!r.is_file}`, `snippet: ${truncate(r.snippet, 300)}`,
  ].join(' | ')).join('\n');

  return `You are indexing a nonprofit's Slack workspace for grant-writing evidence.
Group these search results into 3-8 THEMES a funder would recognize
(e.g. "attendance & academic outcomes", "parent & teacher testimonials",
"program reach & volume", "events & community presence").

INPUT: search results as {query_label, channel_id, channel_name, permalink,
snippet, is_file} — snippets are for YOUR EYES ONLY to classify; they are
never stored.
${rows || '(no results)'}

For each (theme × channel) pair with ≥1 hit return:
- theme: 2-5 word label, funder vocabulary, lowercase
- channel_id, channel_name
- strength: "star" = specific numbers or named quotable outcomes; "solid" =
  concrete but unquantified; "weak" = mentions without substance
- permalinks: up to 5 strongest
- has_files: true if any hit is a file

ONLY JSON: [{"theme":"…","channel_id":"…","channel_name":"…","strength":"star","permalinks":["…"],"has_files":false}]`;
}

/** ONE LLM call for the whole scan. Never throws — callers degrade to a heuristic theme-per-query-label grouping. */
export async function classifyThemes(scanResults) {
  if (!scanResults.length) return [];
  try {
    const parsed = await completeWithReasoningHeadroom(
      [{ role: 'user', content: themePrompt(scanResults) }], 0,
    );
    if (!parsed) return null; // signals "classifier down" — caller degrades
    return parsed
      .filter((r) => r && r.theme && r.channel_id)
      .map((r) => ({
        theme: String(r.theme).slice(0, 80),
        channel_id: String(r.channel_id),
        channel_name: r.channel_name ? String(r.channel_name).slice(0, 80) : null,
        strength: ['weak', 'solid', 'star'].includes(r.strength) ? r.strength : 'solid',
        permalinks: Array.isArray(r.permalinks) ? r.permalinks.slice(0, 5).map(String) : [],
        has_files: !!r.has_files,
      }));
  } catch (e) {
    console.warn('[classifiers:theme] falling back to heuristic —', e?.message ?? e);
    return null;
  }
}

export function harvestPrompt(text, pipeline) {
  const openGrants = (pipeline ?? [])
    .filter((o) => ['drafting', 'reviewing'].includes(o.stage))
    .map((o) => `${o.opp_id} ${o.title}`).join('\n') || '(none open)';
  return `A message was just posted in a nonprofit's Slack channel. Decide if it is
grant-worthy IMPACT EVIDENCE: concrete results, metrics, testimonials,
milestones, or documentation of program work. Routine chatter, questions,
logistics, and plans are NOT evidence.

MESSAGE: ${truncate(text, 600)}
OPEN GRANTS (for linking): ${openGrants}

ONLY JSON: {"is_evidence":true,"tag":"metric|story|testimonial|other",
"opp_id_hint":"opp_id or null","why":"≤80 chars"}
When unsure, is_evidence=false — a wrong nudge erodes trust fast.`;
}

function parseJsonObject(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

/** ONE LLM call per harvested message. Never throws — callers fall back to heuristic-only (already-passed guard chain = is_evidence). */
export async function classifyHarvest(text, pipeline) {
  try {
    const parsed = parseJsonObject(await completeOnce(
      [{ role: 'user', content: harvestPrompt(text, pipeline) }], { temperature: 0, maxTokens: 300 },
    ));
    if (!parsed) return null;
    return {
      is_evidence: !!parsed.is_evidence,
      tag: ['metric', 'story', 'testimonial', 'other'].includes(parsed.tag) ? parsed.tag : 'other',
      opp_id_hint: parsed.opp_id_hint ? String(parsed.opp_id_hint) : null,
      why: parsed.why ? String(parsed.why).slice(0, 100) : '',
    };
  } catch (e) {
    console.warn('[classifiers:harvest] falling back —', e?.message ?? e);
    return null;
  }
}

function parseJsonArray(text) {
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  try {
    const arr = JSON.parse(match[0]);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

/**
 * A reasoning model's own chain-of-thought competes with the JSON answer for
 * the SAME max_tokens budget, and its length is non-deterministic even at
 * temperature 0 (live-confirmed: the identical prompt burned ~2000 reasoning
 * tokens on one call and ~5000 on the next) — so a single fixed budget can
 * legitimately come back empty by chance, not just on a real failure. One
 * retry at a much larger budget recovers most of these before we fall back.
 */
async function completeWithReasoningHeadroom(messages, temperature) {
  for (const maxTokens of [8000, 14000]) {
    const text = await completeWithDeadline(() => completeOnce(messages, { temperature, maxTokens }), CLASSIFIER_DEADLINE_MS);
    if (text === undefined) { console.warn('[llm] classifier call missed its deadline — falling back'); return null; }
    const parsed = parseJsonArray(text);
    if (parsed) return parsed;
  }
  return null;
}

/** ONE LLM call for up to 6 opps. Never throws — callers fall back to Phase-1 scoreMatch stars on any failure. */
export async function assessFitBatch(org, opps) {
  if (!opps.length) return [];
  try {
    const parsed = await completeWithReasoningHeadroom(
      [{ role: 'user', content: fitBatchPrompt(org, org?._notRelevant ?? [], opps.slice(0, 6)) }], 0,
    );
    if (!parsed) return [];
    return parsed
      .filter((r) => r && typeof r.opp_id !== 'undefined')
      .map((r) => ({
        opp_id: String(r.opp_id),
        fit_score: Number.isFinite(r.fit_score) ? Math.max(0, Math.min(100, Math.round(r.fit_score))) : null,
        fit_rationale: r.fit_rationale ? String(r.fit_rationale).slice(0, 160) : null,
        eligibility_verdict: ['eligible', 'likely_not', 'unknown'].includes(r.eligibility_verdict) ? r.eligibility_verdict : 'unknown',
        eligibility_reason: r.eligibility_reason ? String(r.eligibility_reason).slice(0, 160) : null,
      }));
  } catch (e) {
    console.warn('[classifiers:fit] falling back to stars —', e?.message ?? e);
    return [];
  }
}

/** ONE LLM call at add-time. Never throws — an empty checklist is a safe degrade (just no % shown). */
export async function extractChecklist(opp) {
  try {
    const parsed = await completeWithReasoningHeadroom(
      [{ role: 'user', content: checklistPrompt(opp) }], 0,
    );
    if (!parsed) return [];
    const items = parsed
      .filter((it) => it && it.id && it.label)
      .map((it) => ({
        id: String(it.id), label: String(it.label).slice(0, 200),
        kind: ['document', 'form_field', 'registration', 'logistics'].includes(it.kind) ? it.kind : 'document',
        detail: it.detail ? String(it.detail).slice(0, 200) : undefined,
        due_hint: it.due_hint ? String(it.due_hint).slice(0, 100) : undefined,
        done: false,
      }));
    if (!items.some((it) => it.id === 'sam_uei')) {
      items.push({ id: 'sam_uei', label: 'Active SAM.gov registration + UEI', kind: 'registration', done: false });
    }
    return items;
  } catch (e) {
    console.warn('[classifiers:checklist] skipped —', e?.message ?? e);
    return [];
  }
}
