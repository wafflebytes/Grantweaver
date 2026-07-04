import pg from 'pg';
import fs from 'node:fs/promises';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 10,
});

export const db = {
  pool, // exposed for tests only

  async migrateIfNeeded() {
    for (const f of ['001_init.sql', '002_phase2.sql']) {
      const sql = await fs.readFile(new URL(`../../migrations/${f}`, import.meta.url), 'utf8');
      await pool.query(sql); // each file is fully idempotent (IF NOT EXISTS)
    }
  },

  // ── orgs ───────────────────────────────────────────────────────────
  async getOrg(teamId) {
    const { rows } = await pool.query('SELECT * FROM orgs WHERE team_id=$1', [teamId]);
    return rows[0] ?? null;
  },
  async allOrgs() {
    const { rows } = await pool.query('SELECT * FROM orgs');
    return rows;
  },
  async upsertOrg(teamId, fields) {
    const cur = (await this.getOrg(teamId)) ?? {};
    const n = { ...cur, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
    await pool.query(
      `INSERT INTO orgs (team_id, org_name, mission, focus_areas, state, org_size, digest_channel, evidence_emoji)
       VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8,'thread'))
       ON CONFLICT (team_id) DO UPDATE SET
         org_name=EXCLUDED.org_name, mission=EXCLUDED.mission, focus_areas=EXCLUDED.focus_areas,
         state=EXCLUDED.state, org_size=EXCLUDED.org_size,
         digest_channel=COALESCE(EXCLUDED.digest_channel, orgs.digest_channel),
         evidence_emoji=COALESCE(EXCLUDED.evidence_emoji, orgs.evidence_emoji)`,
      [teamId, n.org_name ?? null, n.mission ?? null, n.focus_areas ?? [], n.state ?? null,
       n.org_size ?? null, n.digest_channel ?? null, n.evidence_emoji ?? null]);
  },

  // ── opportunities ──────────────────────────────────────────────────
  async listOpportunities(teamId) {
    const { rows } = await pool.query(
      'SELECT * FROM opportunities WHERE team_id=$1 ORDER BY close_date ASC NULLS LAST', [teamId]);
    return rows;
  },
  async addOpportunity(teamId, o) {
    await pool.query(
      `INSERT INTO opportunities (team_id, opp_id, opp_number, title, agency, close_date, award_ceiling, url, stage, match_score, added_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'reviewing',$9,$10)
       ON CONFLICT (team_id, opp_id) DO UPDATE SET stage='reviewing', updated_at=now()`,
      [teamId, String(o.opp_id), o.opp_number ?? null, o.title, o.agency ?? null,
       o.close_date || null, o.award_ceiling || null, o.url ?? null, o.match_score ?? null, o.added_by ?? null]);
  },
  async moveOpportunity(teamId, oppId, stage) {
    await pool.query(
      'UPDATE opportunities SET stage=$3, updated_at=now() WHERE team_id=$1 AND opp_id=$2',
      [teamId, String(oppId), stage]);
  },
  async attachCanvas(teamId, oppId, canvasId) {
    await pool.query(
      `UPDATE opportunities SET canvas_id=$3, stage='drafting', updated_at=now()
       WHERE team_id=$1 AND opp_id=$2`, [teamId, String(oppId), canvasId]);
  },
  async setPipelineList(teamId, listId, columns) {
    await pool.query(
      'UPDATE orgs SET pipeline_list_id=$2, pipeline_list_columns=$3 WHERE team_id=$1',
      [teamId, listId, JSON.stringify(columns)]);
  },
  async setOpportunityListItem(teamId, oppId, listItemId) {
    await pool.query(
      'UPDATE opportunities SET list_item_id=$3 WHERE team_id=$1 AND opp_id=$2',
      [teamId, String(oppId), listItemId]);
  },
  async setOwner(teamId, oppId, userId) {
    await pool.query(
      'UPDATE opportunities SET owner_user_id=$3, last_activity_at=now() WHERE team_id=$1 AND opp_id=$2',
      [teamId, String(oppId), userId]);
  },
  async setFit(teamId, oppId, { fit_score, fit_rationale, eligibility_verdict, eligibility_reason }) {
    await pool.query(
      `UPDATE opportunities SET fit_score=$3, fit_rationale=$4, eligibility_verdict=$5,
         eligibility_reason=$6, last_activity_at=now() WHERE team_id=$1 AND opp_id=$2`,
      [teamId, String(oppId), fit_score ?? null, fit_rationale ?? null,
       eligibility_verdict ?? null, eligibility_reason ?? null]);
  },
  async setChecklist(teamId, oppId, checklist) {
    await pool.query(
      'UPDATE opportunities SET checklist=$3, last_activity_at=now() WHERE team_id=$1 AND opp_id=$2',
      [teamId, String(oppId), JSON.stringify(checklist ?? [])]);
  },
  async toggleChecklistItem(teamId, oppId, itemId, done) {
    const { rows } = await pool.query(
      'SELECT checklist FROM opportunities WHERE team_id=$1 AND opp_id=$2', [teamId, String(oppId)]);
    const checklist = (rows[0]?.checklist ?? []).map((it) => (it.id === itemId ? { ...it, done: Boolean(done) } : it));
    await this.setChecklist(teamId, oppId, checklist);
    return checklist;
  },
  async touchActivity(teamId, oppId) {
    await pool.query(
      'UPDATE opportunities SET last_activity_at=now() WHERE team_id=$1 AND opp_id=$2', [teamId, String(oppId)]);
  },
  async setCanvasWritten(teamId, oppId) {
    await pool.query(
      'UPDATE opportunities SET canvas_written_at=now() WHERE team_id=$1 AND opp_id=$2', [teamId, String(oppId)]);
  },

  // ── orgs (phase 2) ─────────────────────────────────────────────────
  async setChannels(teamId, { watched, post }) {
    await pool.query(
      'UPDATE orgs SET watched_channels=$2, post_channels=$3 WHERE team_id=$1',
      [teamId, watched ?? [], post ?? []]);
  },
  async setOnboardingState(teamId, stateOrNull) {
    await pool.query(
      'UPDATE orgs SET onboarding_state=$2 WHERE team_id=$1',
      [teamId, stateOrNull ? JSON.stringify(stateOrNull) : null]);
  },
  async setEligibilityFacts(teamId, facts) {
    await pool.query(
      'UPDATE orgs SET eligibility_facts=$2 WHERE team_id=$1',
      [teamId, JSON.stringify(facts ?? {})]);
  },
  async resetOrg(teamId) {
    // Order matters: tables with no FK on `orgs` first (they must
    // survive even if the org row is somehow already gone), then the org row
    // itself — its ON DELETE CASCADE takes opportunities/watches/evidence_index.
    // `feedback` deliberately survives (product telemetry, not org state).
    await pool.query('DELETE FROM pending_intents WHERE team_id=$1', [teamId]);
    await pool.query('DELETE FROM signals WHERE team_id=$1', [teamId]);
    await pool.query('DELETE FROM opp_activity WHERE team_id=$1', [teamId]);
    await pool.query('DELETE FROM orgs WHERE team_id=$1', [teamId]);
  },

  // ── activity / signals ─────────────────────────────────────────────
  async logActivity(teamId, oppId, { actor, kind, summary }) {
    await pool.query(
      'INSERT INTO opp_activity (team_id, opp_id, actor, kind, summary) VALUES ($1,$2,$3,$4,$5)',
      [teamId, String(oppId), actor ?? 'agent', kind, summary]);
  },
  async listActivity(teamId, oppId, limit = 10) {
    const { rows } = await pool.query(
      'SELECT * FROM opp_activity WHERE team_id=$1 AND opp_id=$2 ORDER BY at DESC LIMIT $3',
      [teamId, String(oppId), limit]);
    return rows;
  },
  async addSignal(teamId, { kind, subject, detail }) {
    await pool.query(
      'INSERT INTO signals (team_id, kind, subject, detail) VALUES ($1,$2,$3,$4)',
      [teamId, kind, subject, detail ?? null]);
  },
  async countSignalsSince(teamId, kind, subject, hours) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM signals
       WHERE team_id=$1 AND kind=$2 AND subject=$3 AND created_at > now() - ($4 || ' hours')::interval`,
      [teamId, kind, subject, hours]);
    return rows[0].n;
  },
  async listNotRelevant(teamId) {
    const { rows } = await pool.query(
      "SELECT subject, detail FROM signals WHERE team_id=$1 AND kind='not_relevant' ORDER BY created_at DESC",
      [teamId]);
    return rows;
  },

  // ── watches ────────────────────────────────────────────────────────
  async addWatch(teamId, { kind, params, created_by }) {
    const { rows } = await pool.query(
      'INSERT INTO watches (team_id, kind, params, created_by) VALUES ($1,$2,$3,$4) RETURNING *',
      [teamId, kind, JSON.stringify(params ?? {}), created_by ?? null]);
    return rows[0];
  },
  async listWatches(teamId) {
    const { rows } = await pool.query('SELECT * FROM watches WHERE team_id=$1 ORDER BY created_at DESC', [teamId]);
    return rows;
  },
  async updateWatchSeen(watchId, { last_run_at, last_seen_ids }) {
    await pool.query(
      'UPDATE watches SET last_run_at=$2, last_seen_ids=$3 WHERE id=$1',
      [watchId, last_run_at ?? new Date(), last_seen_ids ?? []]);
  },
  async removeWatch(teamId, watchId) {
    await pool.query('DELETE FROM watches WHERE team_id=$1 AND id=$2', [teamId, watchId]);
  },

  // ── evidence index ─────────────────────────────────────────────────
  async upsertIndexRow(teamId, row) {
    await pool.query(
      `INSERT INTO evidence_index (team_id, theme, channel_id, channel_name, strength, hits, permalinks, has_files)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (team_id, theme, channel_id) DO UPDATE SET
         channel_name=EXCLUDED.channel_name, strength=EXCLUDED.strength, hits=EXCLUDED.hits,
         permalinks=EXCLUDED.permalinks, has_files=EXCLUDED.has_files, scanned_at=now()`,
      [teamId, row.theme, row.channel_id, row.channel_name ?? null, row.strength ?? 'solid',
       row.hits ?? 0, row.permalinks ?? [], row.has_files ?? false]);
  },
  async listIndex(teamId) {
    const { rows } = await pool.query(
      'SELECT * FROM evidence_index WHERE team_id=$1 ORDER BY theme, channel_name', [teamId]);
    return rows;
  },
  async clearIndex(teamId) {
    await pool.query('DELETE FROM evidence_index WHERE team_id=$1', [teamId]);
  },

  // ── pending intents (confirm-before-generate) ─────────────────────
  async createIntent(teamId, { kind, params, requested_by, channel_id }) {
    const { rows } = await pool.query(
      `INSERT INTO pending_intents (team_id, kind, params, requested_by, channel_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [teamId, kind, JSON.stringify(params ?? {}), requested_by ?? null, channel_id ?? null]);
    return rows[0];
  },
  async setIntentMessage(intentId, messageTs) {
    await pool.query('UPDATE pending_intents SET message_ts=$2 WHERE id=$1', [intentId, messageTs]);
  },
  async getIntent(intentId) {
    const { rows } = await pool.query('SELECT * FROM pending_intents WHERE id=$1', [intentId]);
    return rows[0] ?? null;
  },
  async mergeIntentParams(intentId, patch) {
    // Change-scope merges pointer/label params ({evidence:[{c,ts}], sections,
    // notes}) into a still-pending intent — same no-message-content rule as
    // createIntent's params.
    const { rows } = await pool.query(
      `UPDATE pending_intents SET params = params || $2::jsonb
       WHERE id=$1 AND status='pending' RETURNING *`,
      [intentId, JSON.stringify(patch ?? {})]);
    return rows[0] ?? null;
  },
  async getIntentByMessage(channelId, messageTs) {
    const { rows } = await pool.query(
      'SELECT * FROM pending_intents WHERE channel_id=$1 AND message_ts=$2', [channelId, messageTs]);
    return rows[0] ?? null;
  },
  async claimIntent(intentId) {
    // Atomic pending→running so a double-click (button + ✅ reaction, or two
    // clicks) only ever wins once — the UPDATE...RETURNING only returns a row
    // when the WHERE clause matched pre-update, so a second concurrent caller
    // gets an empty result set.
    const { rows } = await pool.query(
      `UPDATE pending_intents SET status='running' WHERE id=$1 AND status='pending' RETURNING *`,
      [intentId]);
    return rows[0] ?? null;
  },
  async finishIntent(intentId, status) {
    await pool.query('UPDATE pending_intents SET status=$2 WHERE id=$1', [intentId, status]);
  },
  async expireStaleIntents(hours = 24) {
    const { rows } = await pool.query(
      `UPDATE pending_intents SET status='expired'
       WHERE status='pending' AND created_at < now() - ($1 || ' hours')::interval RETURNING id`,
      [hours]);
    return rows.length;
  },

  // ── evidence: POINTERS ONLY ────────────────────────────────────────
  // This DAL must never accept content. Guard enforces it at runtime too.
  async saveEvidence(teamId, ptr) {
    for (const k of ['text', 'snippet', 'content', 'message']) {
      if (k in ptr) throw new Error(`COMPLIANCE VIOLATION: evidence pointer may not contain "${k}"`);
    }
    await pool.query(
      `INSERT INTO evidence_pointers (team_id, channel_id, message_ts, permalink, tag, saved_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (team_id, channel_id, message_ts) DO UPDATE SET
         tag=EXCLUDED.tag,
         permalink=CASE WHEN EXCLUDED.permalink <> '' THEN EXCLUDED.permalink ELSE evidence_pointers.permalink END`,
      [teamId, ptr.channel_id, ptr.message_ts, ptr.permalink ?? '', ptr.tag ?? 'story', ptr.saved_by ?? null]);
  },
  async listEvidence(teamId, limit = 20) {
    const { rows } = await pool.query(
      'SELECT * FROM evidence_pointers WHERE team_id=$1 ORDER BY saved_at DESC LIMIT $2', [teamId, limit]);
    return rows;
  },
  async countEvidence(teamId) {
    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM evidence_pointers WHERE team_id=$1', [teamId]);
    return rows[0].n;
  },
  async linkEvidenceToOpp(teamId, channelId, messageTs, oppId) {
    await pool.query(
      'UPDATE evidence_pointers SET opp_id=$4 WHERE team_id=$1 AND channel_id=$2 AND message_ts=$3',
      [teamId, channelId, messageTs, String(oppId)]);
  },
  async setEvidenceStrength(teamId, channelId, messageTs, strength) {
    await pool.query(
      'UPDATE evidence_pointers SET strength=$4 WHERE team_id=$1 AND channel_id=$2 AND message_ts=$3',
      [teamId, channelId, messageTs, strength]);
  },

  // ── feedback & meter ───────────────────────────────────────────────
  async saveFeedback(f) {
    await pool.query(
      'INSERT INTO feedback (team_id, user_id, message_ts, value) VALUES ($1,$2,$3,$4)',
      [f.teamId ?? null, f.userId ?? null, f.messageTs ?? null, f.value ?? null]);
  },

  async impactMeter(teamId) {
    const opps = await this.listOpportunities(teamId);
    const evidence = await this.countEvidence(teamId);
    const drafts = opps.filter((o) => o.canvas_id).length;
    const applied = opps
      .filter((o) => ['submitted', 'awarded'].includes(o.stage))
      .reduce((s, o) => s + Number(o.award_ceiling ?? 0), 0);
    return {
      surfaced: opps.length,
      applied,
      evidence,
      drafts,
      hoursSaved: Math.round(2 * drafts + 0.5 * evidence + 0.25 * opps.length),
    };
  },
};
