// One-shot JSON classifiers — always temperature 0, always survive malformed
// output (docs/24 §7.2/§8.1 fallback rule: a bad LLM response degrades the
// feature, never blocks the turn).
import { completeOnce } from '../agent/llm.js';

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

/** ONE LLM call for up to 6 opps. Never throws — callers fall back to Phase-1 scoreMatch stars on any failure. */
export async function assessFitBatch(org, opps) {
  if (!opps.length) return [];
  try {
    const text = await completeOnce(
      [{ role: 'user', content: fitBatchPrompt(org, org?._notRelevant ?? [], opps.slice(0, 6)) }],
      { temperature: 0, maxTokens: 1200 },
    );
    const parsed = parseJsonArray(text);
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
    const text = await completeOnce(
      [{ role: 'user', content: checklistPrompt(opp) }],
      { temperature: 0, maxTokens: 900 },
    );
    const parsed = parseJsonArray(text);
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
