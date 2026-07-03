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
    const sql = await fs.readFile(new URL('../../migrations/001_init.sql', import.meta.url), 'utf8');
    await pool.query(sql); // file is fully idempotent (IF NOT EXISTS)
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
