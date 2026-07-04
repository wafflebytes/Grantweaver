// Seeds the Riverbend Youth Collective sandbox so it reads like a real
// nonprofit's Slack that's been alive for ~3 months: 6 personas, 8 channels,
// noise + threads + files, verbatim evidence targets, and a pipeline whose
// opp_ids are verified live against Grants.gov (never a fictional id — see
// the fetchOpportunity-verify step, standing fix for the F9 finding).
//
// env: SEED_BOT_TOKEN (channel create/join/invite; also posts for any
//      persona missing a real user token), SEED_USER_TOKENS as JSON
//      {"maya":"xoxp-…","dre":"xoxp-…",...}, DATABASE_URL, LLM_* (unused
//      here but loaded via --env-file for parity with the rest of the app)
// flags: --wipe (delete+recreate channels this script owns; refuses on
//        channels it didn't create) --messages-only --state-only --verify
import { WebClient } from '@slack/web-api';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { grantsGov } from '../src/mcp/grantsgov-client.js';

const ASSETS_DIR = new URL('../test/fixtures/seed-assets/', import.meta.url);
const FILE_SLOTS = {
  A1: ['program-updates_attendance-semester.pdf'],
  A2: ['events_stem-saturday-1.jpg', 'events_stem-saturday-2.jpg', 'events_stem-saturday-3.jpg'],
  A3: ['board_q3-board-report.pdf'],
  A4: ['events_fall-flyer.png'],
  A5: ['mentor-stories_parent-note.jpg'],
  A6: ['volunteers_signup-sheet.pdf'],
};

const bot = new WebClient(process.env.SEED_BOT_TOKEN);
let userTokens = {};
try { userTokens = JSON.parse(process.env.SEED_USER_TOKENS ?? '{}'); } catch { /* fall through to bot posting */ }
const clientFor = (handle) => (userTokens[handle] ? new WebClient(userTokens[handle]) : null);

const flags = new Set(process.argv.slice(2));
const DAYS = 86400000;
const offsetDate = (d) => new Date(Date.now() + d * DAYS).toISOString().slice(0, 10);

const PERSONAS = {
  maya: { name: 'Maya Okafor', icon: ':woman-office-worker:' },
  dre: { name: 'Dre Sullivan', icon: ':man-technologist:' },
  priya: { name: 'Priya Raman', icon: ':woman-raising-hand:' },
  sam: { name: 'Sam Whitfield', icon: ':man-raising-hand:' },
  jo: { name: 'Jo Martinez', icon: ':woman-tipping-hand:' },
};

// Channel → { watched, post } per docs 26 §2.
const CHANNELS = {
  general: { watched: false, post: false },
  'program-updates': { watched: true, post: false },
  'mentor-stories': { watched: true, post: false },
  volunteers: { watched: true, post: false },
  events: { watched: true, post: false },
  grants: { watched: true, post: true },
  board: { watched: false, post: false },
  'budget-finance': { watched: false, post: false }, // privacy foil — never watched
};

// oldest-first; ⭐/⭐R rows are the verbatim evidence targets — never reword
// these. `react: true` = a 🧵 pre-reaction (evidence-capture demo).
const PLAN = [
  { ch: 'general', who: 'sam', text: 'Morning! Coffee machine in the back is fixed 🎉' },
  { ch: 'general', who: 'maya', text: 'Reminder: street parking is permit-only on Thursdays now.' },
  { ch: 'volunteers', who: 'sam', text: 'Orientation for 6 new volunteers this Saturday — signup sheet in the doc.' },
  { ch: 'program-updates', who: 'dre', text: "Attendance tracker glitched again, fixing it before Friday's roundup." },
  { ch: 'general', who: 'jo', text: 'Welcome to our two newest volunteers, Tasha and Rob! 👋' },
  { ch: 'mentor-stories', who: 'priya', text: 'Quiet week for stories, mostly logistics — will have more after Saturday.' },
  { ch: 'general', who: 'dre', text: 'Anyone seen the projector? Room B is missing it again.' },
  { ch: 'events', who: 'sam', text: 'STEM Saturday is this weekend — 34 volunteers confirmed so far.' },
  { ch: 'general', who: 'priya', text: 'Wifi password changed — check the whiteboard.' },
  { ch: 'program-updates', who: 'dre', text: 'Semester wrap: 42 of 47 mentees improved school attendance. Average GPA up 0.4. Full sheet attached.', star: 'R', file: 'A1' },
  { ch: 'general', who: 'sam', text: 'Office dog tax 🐶 (Beans visited today)' },
  { ch: 'events', who: 'sam', text: 'STEM Saturday recap: 118 kids + 34 volunteers. Local news came by! Photos in thread 📸', star: 'R', file: 'A2', thread: true },
  { ch: 'events', who: 'jo', text: 'Adding the local news mention to our press folder — great coverage.', replyTo: -1 },
  { ch: 'general', who: 'maya', text: "Reminder: don't forget to submit timesheets by Friday." },
  { ch: 'volunteers', who: 'sam', text: 'Volunteer milestone!! 200 active volunteers as of this month, 3,400 hours YTD 🎉 Y\'all are incredible.', star: true },
  { ch: 'general', who: 'jo', text: 'Bracket update: I am in last place. Again.' },
  { ch: 'mentor-stories', who: 'priya', text: "From Ms. Alvarez at Roosevelt Middle today: 'The Riverbend kids come to class prepared. Whatever you're doing — keep doing it.' Made my week.", star: 'R' },
  { ch: 'general', who: 'dre', text: '🎂 Happy birthday Maya!! 🎂' },
  { ch: 'volunteers', who: 'sam', text: 'Roster sheet updated for fall — attaching for @dre and @maya.', file: 'A6' },
  { ch: 'mentor-stories', who: 'priya', text: "D. (8th grade, 2nd year in program) read his essay aloud at assembly — the same kid who wouldn't speak in group last fall. His mentor cried. I cried.", star: true },
  { ch: 'general', who: 'sam', text: 'Snow day — building closed tomorrow, all sessions moved online.' },
  { ch: 'events', who: 'jo', text: 'New program flyer for fall — feedback welcome.', file: 'A4' },
  { ch: 'program-updates', who: 'dre', text: "Mid-year survey is in: 87% of mentees say they have 'an adult they trust' — up from 54% at intake. n=45, same instrument as last year.", star: true },
  { ch: 'general', who: 'priya', text: 'Lunch order for the team meeting — sending the link around.' },
  { ch: 'mentor-stories', who: 'priya', text: "A parent stopped me at pickup: 'You gave my son somewhere to belong.' Adding to the testimonial doc.", file: 'A5' },
  { ch: 'general', who: 'maya', text: 'Board meeting moved to next Tuesday, same time.' },
  { ch: 'program-updates', who: 'dre', text: 'Tutoring hours logged this quarter: 1,240 across all sites. Site B doubled its volume after we moved to Thursdays.', star: true },
  { ch: 'board', who: 'maya', text: 'Q3 board packet attached. Headline: program demand up 40% YoY, funding flat. We must diversify grants this year.', star: true, file: 'A3' },
  { ch: 'general', who: 'jo', text: 'Anyone free to cover front desk 2-4pm Thursday?' },
  { ch: 'program-updates', who: 'dre', text: 'Waitlist update: 63 kids now. We need capacity funding, flagging for @maya.' },
  { ch: 'general', who: 'sam', text: 'Congrats to the office on 6 months noise-complaint free 😂' },
  { ch: 'grants', who: 'maya', text: 'Reminder: our OJJDP idea needs outcome data by section. @dre can you pull the semester numbers?' },
  { ch: 'grants', who: 'dre', text: 'On it — semester attendance + survey numbers are both in #program-updates already, will compile today.' },
  { ch: 'general', who: 'priya', text: 'Anyone else\'s heat not working in the annex?' },
  { ch: 'budget-finance', who: 'jo', text: 'Draft budget has the director salary line at $72k — do not share outside this channel yet.' },
  { ch: 'general', who: 'maya', text: 'Nice work everyone on a strong quarter. 🙌' },
];

async function ensureChannels() {
  const ids = {}, joined = new Set();
  const existing = await bot.conversations.list({ types: 'public_channel', limit: 200 });
  for (const name of Object.keys(CHANNELS)) {
    const found = existing.channels.find((c) => c.name === name);
    const created = !found;
    ids[name] = found?.id ?? (await bot.conversations.create({ name })).channel.id;
    // The bot is auto-joined to channels it creates; for pre-existing
    // channels, try an explicit join (best-effort — some tokens lack
    // channels:join, in which case fall back to checking membership).
    if (created) {
      joined.add(name);
    } else {
      try { await bot.conversations.join({ channel: ids[name] }); joined.add(name); }
      catch (e) {
        const info = await bot.conversations.info({ channel: ids[name] }).catch(() => null);
        if (info?.channel?.is_member) joined.add(name);
        else console.warn(`[seed] not a member of #${name} and could not join: ${e?.data?.error ?? e.message}`);
      }
    }
    // Invite every persona with a real user token so their posts read as
    // themselves, not the app.
    const userIds = [];
    for (const handle of Object.keys(PERSONAS)) {
      const client = clientFor(handle);
      if (!client) continue;
      try { userIds.push((await client.auth.test()).user_id); } catch { /* token invalid/missing — skip */ }
    }
    if (userIds.length) await bot.conversations.invite({ channel: ids[name], users: userIds.join(',') }).catch(() => {});
  }
  return { ids, joined };
}

async function postPlan(ids, joined) {
  const tsByIndex = [];
  let posted = 0;
  for (let i = 0; i < PLAN.length; i++) {
    const m = PLAN[i];
    if (!joined.has(m.ch)) {
      console.warn(`[seed] skipping message ${i} — not joined to #${m.ch}`);
      tsByIndex.push(null);
      continue;
    }
    const channel = ids[m.ch];
    const persona = PERSONAS[m.who];
    const client = clientFor(m.who);
    const thread_ts = m.replyTo != null ? tsByIndex[i + m.replyTo] ?? undefined : undefined;
    let res;
    if (client) {
      res = await client.chat.postMessage({ channel, text: m.text, thread_ts });
    } else {
      res = await bot.chat.postMessage({
        channel, text: m.text, thread_ts,
        username: persona.name, icon_emoji: persona.icon, // needs chat:write.customize
      });
    }
    tsByIndex.push(res.ts);
    posted++;
    if (m.star === 'R') {
      const reactor = clientFor('maya') ?? bot;
      await reactor.reactions.add({ channel, timestamp: res.ts, name: 'thread' }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(`Posted ${posted}/${PLAN.length} messages across ${Object.keys(CHANNELS).length} channels.`);
  return tsByIndex;
}

async function uploadAssets(ids, joined, tsByIndex) {
  let uploaded = 0;
  for (let i = 0; i < PLAN.length; i++) {
    const m = PLAN[i];
    if (!m.file || !joined.has(m.ch)) continue;
    const filenames = FILE_SLOTS[m.file];
    if (!filenames) { console.warn(`[seed] no asset filenames mapped for ${m.file}`); continue; }
    // Event photos are attributed to jo (she manages the press folder); otherwise the message's own author.
    const uploader = (m.file === 'A2' ? clientFor('jo') : clientFor(m.who)) ?? bot;
    const channel_id = ids[m.ch];
    const thread_ts = tsByIndex[i];
    for (const filename of filenames) {
      const filePath = fileURLToPath(new URL(filename, ASSETS_DIR));
      try {
        await uploader.files.uploadV2({ channel_id, thread_ts, filename, file: createReadStream(filePath) });
        uploaded++;
      } catch (e) {
        console.warn(`[seed] failed to upload ${filename} for ${m.file}: ${e?.data?.error ?? e.message}`);
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }
  console.log(`Uploaded ${uploaded} asset file(s).`);
}

async function resolveRealOpps() {
  // F9 fix: every seeded pipeline row must resolve live via fetchOpportunity
  // — a fictional opp_id breaks get_opportunity_details on camera.
  const candidates = await grantsGov.search({ keyword: 'youth mentoring', oppStatuses: 'posted', rows: 10 }).catch(() => []);
  const verified = [];
  for (const c of candidates) {
    const details = await grantsGov.fetchOpportunity(c.opp_id).catch(() => null);
    if (details) verified.push({ ...c, details });
    if (verified.length >= 4) break;
  }
  if (verified.length < 4) throw new Error(`Only ${verified.length}/4 real opp_ids resolved live — check Grants.gov reachability before seeding state.`);
  return verified;
}

async function seedState(pool, teamId) {
  await pool.query(
    `INSERT INTO orgs (team_id, org_name, mission, focus_areas, state, org_size, watched_channels, post_channels)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (team_id) DO UPDATE SET org_name=EXCLUDED.org_name, mission=EXCLUDED.mission,
       focus_areas=EXCLUDED.focus_areas, state=EXCLUDED.state, org_size=EXCLUDED.org_size,
       watched_channels=EXCLUDED.watched_channels, post_channels=EXCLUDED.post_channels`,
    [teamId, 'Riverbend Youth Collective',
     'After-school mentorship and academic support for under-served youth ages 10-17 in Dayton, Ohio.',
     ['youth', 'education'], 'OH', '1-10',
     Object.entries(CHANNELS).filter(([, c]) => c.watched).map(([n]) => n),
     Object.entries(CHANNELS).filter(([, c]) => c.post).map(([n]) => n)]);
  await pool.query(`UPDATE orgs SET eligibility_facts=$2 WHERE team_id=$1`,
    [teamId, JSON.stringify({ entity_type: '501c3', years_operating: '5+', has_sam_uei: true })]);

  const opps = await resolveRealOpps();
  const stages = ['suggested', 'reviewing', 'drafting', 'submitted'];
  const owners = { drafting: 'dre', reviewing: 'jo' };
  for (let i = 0; i < stages.length; i++) {
    const o = opps[i], stage = stages[i];
    await pool.query(
      `INSERT INTO opportunities (team_id, opp_id, opp_number, title, agency, close_date, award_ceiling, url, stage, match_score, owner_user_id, last_activity_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() - ($12 || ' days')::interval)
       ON CONFLICT (team_id, opp_id) DO UPDATE SET stage=EXCLUDED.stage, updated_at=now()`,
      [teamId, String(o.opp_id), o.opp_number ?? null, o.title, o.agency ?? null,
       o.details?.close_date ?? offsetDate(45), o.details?.award_ceiling ?? null,
       `https://grants.gov/search-results-detail/${o.opp_id}`, stage, 0.8,
       owners[stage] ?? null, stage === 'drafting' ? 6 : 0]);
  }
  console.log(`Seeded org + ${stages.length} pipeline rows (real Grants.gov opp_ids, verified live).`);
}

async function verify(pool, teamId) {
  const { rows: idx } = await pool.query('SELECT theme FROM evidence_index WHERE team_id=$1', [teamId]);
  const { rows: opps } = await pool.query('SELECT opp_id FROM opportunities WHERE team_id=$1', [teamId]);
  let ok = true;
  for (const o of opps) {
    const d = await grantsGov.fetchOpportunity(o.opp_id).catch(() => null);
    if (!d) { console.error(`[verify] opp_id ${o.opp_id} does not resolve live`); ok = false; }
  }
  console.log(`[verify] ${opps.length} pipeline opp_ids checked, evidence_index has ${idx.length} rows (run the onboarding scan to populate it).`);
  if (!ok) process.exit(1);
}

async function main() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  const teamId = (await bot.auth.test()).team_id;

  if (!flags.has('--state-only')) {
    const { ids, joined } = await ensureChannels();
    if (!flags.has('--verify')) {
      const tsByIndex = await postPlan(ids, joined);
      await uploadAssets(ids, joined, tsByIndex);
    }
  }
  if (!flags.has('--messages-only')) await seedState(pool, teamId);
  if (flags.has('--verify')) await verify(pool, teamId);

  await pool.end();
  console.log('Done. Run the onboarding scan (or /grantweaver simulate) next to build the evidence index.');
}
main().catch((e) => { console.error(e); process.exit(1); });
