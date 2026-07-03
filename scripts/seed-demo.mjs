// Seeds the Riverbend Youth Collective history into the sandbox.
// Strategy A (default): post via seeder bot with chat:write.customize
//   (username/icon per persona). Requires SEED_BOT_TOKEN.
// Strategy B (Risk R2 fallback): post via real test-user tokens in
//   SEED_USER_TOKENS if RTS turns out not to index bot-authored messages.
import { WebClient } from '@slack/web-api';
import pg from 'pg';

const bot = new WebClient(process.env.SEED_BOT_TOKEN);
const userTokens = (process.env.SEED_USER_TOKENS ?? '').split(',').filter(Boolean)
  .map((t) => new WebClient(t.trim()));
const useUsers = process.argv.includes('--as-users') && userTokens.length > 0;

const CHANNELS = ['welcome', 'general', 'program-updates', 'impact-stories', 'grants', 'events', 'random'];
const PERSONAS = {
  'Priya Nair':    ':woman-raising-hand:',
  'Marcus Bell':   ':man-office-worker:',
  'Jo Ortiz':      ':woman-tipping-hand:',
  'Sam Keller':    ':man-raising-hand:',
  'Dana Whitfield':':woman-office-worker:',
};

// The full PLAN array: every seed message, in posting order.
const PLAN = [
  { ch: 'program-updates', who: 'Priya Nair', text: '[Mar 21] Reminder: outcome tracking sheets due Friday. Attendance data especially — funders always ask.' },
  { ch: 'impact-stories',  who: 'Jo Ortiz',   text: '[Mar 12] Robotics mini-camp had a waitlist of 30 kids. We need more volunteers AND more funding for kits — every camp fills in 48 hours.' },
  { ch: 'grants',          who: 'Dana Whitfield', text: '[Apr 8] State Farm Youth grant submitted! 🤞 $25k for Homework Lab supplies and stipends. Decision expected by August.' },
  { ch: 'impact-stories',  who: 'Jo Ortiz',   text: '[Apr 18] DeShawn (14) just made honor roll for the first time. His mentor Keith has met him at the library every Tuesday for 8 months. This is why we do this. 😭', react: 'thread' },
  { ch: 'events',          who: 'Jo Ortiz',   text: "[Apr 26] Spring Showcase photos are up! 200+ parents attended. The kids' robotics demos stole the show." },
  { ch: 'program-updates', who: 'Priya Nair', text: '[Apr 30] Quick win: 91% of families renewed for fall programming — highest retention we\'ve ever had.' },
  { ch: 'impact-stories',  who: 'Sam Keller', text: "[May 2] Maya's mom stopped by the office today: 'I don't know what you all did, but my daughter talks about college now.' She was in tears. So was I." },
  { ch: 'program-updates', who: 'Priya Nair', text: '[May 14] Spring cohort wrap-up 🎉 42 of 47 mentees improved school attendance this semester. Average GPA up 0.4 points. Full data in the tracker.', react: 'thread' },
  { ch: 'program-updates', who: 'Marcus Bell', text: '[May 15] Incredible numbers, Priya. Board will love this. Dana — anything here we can use for the fall funding push?' },
  { ch: 'grants',          who: 'Dana Whitfield', text: '[May 20] Note to self: the Riverside Foundation LOI is due end of August. Need attendance + testimonial material again… time to go digging through channels. Again.' },
  { ch: 'program-updates', who: 'Priya Nair', text: "[May 28] Post-program survey is in: 87% of mentees say they have 'an adult they trust' — up from 54% at intake. This is the number I'm proudest of." },
  { ch: 'impact-stories',  who: 'Sam Keller', text: "[Jun 3] From a teacher at Roosevelt Middle: 'The Riverbend kids come to class prepared. Whatever you're doing after school, it's working.' Getting this in writing for our files.", react: 'thread' },
  { ch: 'program-updates', who: 'Priya Nair', text: '[Jun 6] Tutoring hours logged this quarter: 1,240 across 63 active volunteers. Homework Lab attendance averaging 34 kids/session.' },
  { ch: 'grants',          who: 'Marcus Bell', text: "[Jun 10] Board approved pursuing federal funding this cycle. Dana, let's find OJJDP or Dept of Ed opportunities for mentorship." },
  { ch: 'events',          who: 'Jo Ortiz',   text: '[Jun 14] Volunteer appreciation night: 40 mentors celebrated. Keith got Mentor of the Year.' },
  { ch: 'program-updates', who: 'Priya Nair', text: '[Jun 18] Summer Bridge enrollment at 58 kids, 12 on the waitlist. Reading assessments scheduled for week 1 and week 6 so we can show growth.' },
  { ch: 'impact-stories',  who: 'Jo Ortiz',   text: '[Jun 20] One of our seniors, Amara, got into Ohio State — first in her family. She asked if she could come back as a mentor next year. 🥹' },
  // ── noise ──
  { ch: 'general', who: 'Marcus Bell', text: 'Reminder: street parking is permit-only on Thursdays now.' },
  { ch: 'general', who: 'Jo Ortiz',    text: 'Welcome to our two new volunteers, Tasha and Rob! 👋' },
  { ch: 'general', who: 'Sam Keller',  text: 'Anyone seen the projector? Room B is missing it again.' },
  { ch: 'general', who: 'Priya Nair',  text: 'Wifi password changed — check the whiteboard.' },
  { ch: 'random',  who: 'Jo Ortiz',    text: 'Office dog tax 🐶 (Beans visited today)' },
  { ch: 'random',  who: 'Sam Keller',  text: 'Bracket update: I am in last place. Again.' },
  { ch: 'program-updates', who: 'Priya Nair', text: 'Homework Lab moved to Room B this week — AC repairs in the annex.' },
  { ch: 'general', who: 'Marcus Bell', text: 'Snow day — building closed tomorrow, all sessions moved online.' },
  { ch: 'random',  who: 'Priya Nair',  text: '🎂 Happy birthday Dana!! 🎂' },
];

// Pipeline close_dates are OFFSETS from run time so the demo never carries a
// stale absolute date across a long judging window.
const DAYS = 86400000;
function offsetDate(days) { return new Date(Date.now() + days * DAYS).toISOString().slice(0, 10); }

const PIPELINE_SEED = [
  { opp_id: 'seed-suggested-1', opp_number: 'ED-GRANTS-072526-001', title: 'After-School STEM Enrichment Grant', agency: 'Dept. of Education', close_date: offsetDate(35), award_ceiling: 50000, url: 'https://grants.gov', stage: 'suggested', match_score: 0.7 },
  { opp_id: 'seed-reviewing-1', opp_number: 'OJJDP-2026-YM-01', title: 'OJJDP Mentoring Children of Prisoners Program', agency: 'Office of Juvenile Justice and Delinquency Prevention', close_date: offsetDate(45), award_ceiling: 100000, url: 'https://grants.gov', stage: 'reviewing', match_score: 0.85 },
  { opp_id: 'seed-drafting-1', opp_number: 'RIVFDN-2026-LOI', title: 'Riverside Foundation LOI — Youth Mentorship', agency: 'Riverside Foundation', close_date: offsetDate(55), award_ceiling: 60000, url: 'https://grants.gov', stage: 'drafting', match_score: 0.9, canvas_id: 'stub-seed-canvas' },
  { opp_id: 'seed-submitted-1', opp_number: 'SF-YOUTH-2026', title: 'State Farm Youth Advisory Board Grant', agency: 'State Farm', close_date: offsetDate(-20), award_ceiling: 75000, url: 'https://grants.gov', stage: 'submitted', match_score: 0.8 },
  { opp_id: 'seed-awarded-1', opp_number: 'HHS-ACF-2025-CD', title: 'Community-Based Child Abuse Prevention Grant', agency: 'HHS Administration for Children and Families', close_date: offsetDate(-90), award_ceiling: 40000, url: 'https://grants.gov', stage: 'awarded', match_score: 0.75 },
];

async function seedOrgAndPipeline() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  });
  const auth = await bot.auth.test();
  const teamId = auth.team_id;

  await pool.query(
    `INSERT INTO orgs (team_id, org_name, mission, focus_areas, state, org_size, digest_channel)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (team_id) DO UPDATE SET org_name=EXCLUDED.org_name, mission=EXCLUDED.mission,
       focus_areas=EXCLUDED.focus_areas, state=EXCLUDED.state, org_size=EXCLUDED.org_size`,
    [teamId, 'Riverbend Youth Collective',
     'After-school mentorship and academic support for under-served youth ages 10-17 in Dayton, Ohio.',
     ['youth', 'education', 'mentorship'], 'OH', '1-10', null]);

  for (const o of PIPELINE_SEED) {
    await pool.query(
      `INSERT INTO opportunities (team_id, opp_id, opp_number, title, agency, close_date, award_ceiling, url, stage, match_score, canvas_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (team_id, opp_id) DO UPDATE SET
         close_date=EXCLUDED.close_date, stage=EXCLUDED.stage, updated_at=now()`,
      [teamId, o.opp_id, o.opp_number, o.title, o.agency, o.close_date, o.award_ceiling, o.url, o.stage, o.match_score, o.canvas_id ?? null]);
  }
  console.log(`Seeded org + ${PIPELINE_SEED.length} pipeline opportunities for team ${teamId}.`);
  await pool.end();
}

async function main() {
  // 1. Ensure channels
  const ids = {};
  const joined = new Set();
  const existing = await bot.conversations.list({ types: 'public_channel', limit: 200 });
  for (const name of CHANNELS) {
    const found = existing.channels.find((c) => c.name === name);
    if (found?.is_member) { ids[name] = found.id; joined.add(name); continue; }
    ids[name] = found?.id ?? (await bot.conversations.create({ name })).channel.id;
    try {
      await bot.conversations.join({ channel: ids[name] });
      joined.add(name);
    } catch (e) {
      console.warn(`[seed] could not join #${name} (${e?.data?.error ?? e.message}) — skipping its messages`);
    }
  }

  // 2. Post plan (~1 msg/sec for rate-limit kindness)
  let i = 0;
  for (const m of PLAN) {
    if (!joined.has(m.ch)) { i++; continue; }
    const channel = ids[m.ch];
    let res;
    if (useUsers) {
      const client = userTokens[i % userTokens.length];
      res = await client.chat.postMessage({ channel, text: `*${m.who}:* ${m.text}` });
    } else {
      res = await bot.chat.postMessage({
        channel, text: m.text,
        username: m.who, icon_emoji: PERSONAS[m.who] ?? ':bust_in_silhouette:', // needs chat:write.customize
      });
    }
    if (m.react) await bot.reactions.add({ channel, timestamp: res.ts, name: m.react }).catch(() => {});
    i++;
    await new Promise((r) => setTimeout(r, 1100));
  }
  console.log(`Seeded ${PLAN.length} messages across ${CHANNELS.length} channels.`);

  // 3. Org profile + pipeline (every stage populated, so the Home board tells a story)
  await seedOrgAndPipeline();

  console.log('NEXT: verify RTS finds "mentee attendance", "survey trust", "teacher testimonial".');
}
main().catch((e) => { console.error(e); process.exit(1); });
