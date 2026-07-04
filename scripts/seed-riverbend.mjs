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

// Maya/Dre have no real sandbox user tokens, so their messages post via the
// bot with a username/avatar override (chat:write.customize). Real photos
// served from the app's own static site (site/avatars/*.jpg) read far
// better in a live demo than an emoji shortcode ever did.
const APP_BASE_URL = process.env.APP_BASE_URL?.replace(/\/$/, '');
// ui-avatars.com generates a deterministic initials avatar from a URL —
// no local asset needed, and it fills the gap for personas that never got a
// real photo (only maya.jpg/dre.jpg exist under site/avatars).
const initialsAvatar = (name, bg) => `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=${bg}&color=fff&size=192`;
const PERSONAS = {
  maya: { name: 'Maya Okafor', icon_url: APP_BASE_URL ? `${APP_BASE_URL}/avatars/maya.jpg` : undefined },
  dre: { name: 'Dre Sullivan', icon_url: APP_BASE_URL ? `${APP_BASE_URL}/avatars/dre.jpg` : undefined },
  priya: { name: 'Priya Raman', icon_url: initialsAvatar('Priya Raman', '8e44ad') },
  sam: { name: 'Sam Whitfield', icon_url: initialsAvatar('Sam Whitfield', 'd35400') },
  jo: { name: 'Jo Martinez', icon_url: initialsAvatar('Jo Martinez', '16a085') },
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
// these. `react: true` = a 🧵 pre-reaction (evidence-capture demo). This is
// the curated core (docs/26 §4 evidence targets + hand-picked color) — kept
// intact and unbroken in the final posting order so its one thread pair
// (STEM Saturday recap → reply) keeps working via relative replyTo offsets.
const CORE_PLAN = [
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
  { ch: 'events', who: 'sam', text: 'STEM Saturday recap: 118 kids + 34 volunteers. Local news came by! Photos in thread 📸', star: 'R', file: 'A2', thread: true, id: 'stem-recap' },
  { ch: 'events', who: 'jo', text: 'Adding the local news mention to our press folder — great coverage.', replyToId: 'stem-recap' },
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

// ~10x filler on top of CORE_PLAN (Chaitanya, Jul 4: seed read too thin —
// more messages, more depth, still voice-disciplined per docs/26 §1 and
// noise-quota'd per §3). Grouped by channel; mergePlan() below interleaves
// channels while keeping each channel's own messages (incl. its threads,
// tracked by id/replyToId) in relative order.
const FILLER_PLAN = [
  // ── #general — org-wide chatter/noise, all 5 personas ──────────────
  ...[
    ['sam', "Morning crew ☀️ who's on drop-off duty today?"],
    ['dre', 'Anyone have the spare key to the supply closet?'],
    ['maya', "Reminder: all-staff huddle moved to 4pm, same Zoom link."],
    ['jo', 'The printer on 2 is out of toner again, ordered more.'],
    ['priya', "Anyone want the extra half of my sandwich, going to waste"],
    ['sam', 'Shoutout to whoever restocked the snack bin 🙌'],
    ['dre', "Heads up, the side door code changed — check your DM."],
    ['maya', 'Quick one: does anyone have a working stapler? Mine died.'],
    ['jo', 'New donor thank-you cards came in, they look great.'],
    ['priya', "Traffic on 4th is brutal this week, budget extra time."],
    ['sam', "Building's WiFi dropped again around 2, back now."],
    ['dre', 'Photocopier jammed, put in a ticket with the landlord.'],
    ['maya', "Congrats to Jo on 3 years with Riverbend today! 🎉"],
    ['jo', 'Aw thank you!! feels like yesterday and also forever ago'],
    ['priya', "Does anyone know a good taco place near the north site?"],
    ['sam', 'Found a stray water bottle in Room B, claim it before I do'],
    ['dre', 'PSA: the thermostat in the annex is broken, bring a sweater.'],
    ['maya', 'Great turnout at last night\'s community info session.'],
    ['jo', "Sent the monthly newsletter draft to the usual reviewers."],
    ['priya', 'Someone left cupcakes in the break room, no note, thank you mystery person'],
    ['sam', 'Reminder: fire drill Thursday 10am, nothing to do, just walk out'],
    ['dre', "Anyone else's badge reader acting up at the side entrance?"],
    ['maya', 'Board chair is stopping by Friday, tidy the front office please'],
    ['jo', "Loving the new bulletin board layout, whoever did that"],
    ['priya', 'Ordering more art supplies for the Thursday group, any requests?'],
    ['sam', "Happy Friday y'all, go enjoy the sun 🌞"],
    ['dre', 'Quarterly all-staff photo is next week, wear something you like'],
    ['maya', "Reminder: expense reports due end of month."],
    ['jo', 'The scanner finally works again, RIP the last two weeks'],
    ['priya', "Anyone free to swap Tuesday shift for Wednesday? DM me"],
    ['sam', "It's someone's birthday in the break room, cake alert 🎂"],
    ['dre', "Site B's copier is down too now, must be a bad week for machines"],
    ['maya', 'Reminder to lock the supply cabinet after hours please.'],
    ['jo', "Loved seeing everyone at the potluck, great turnout"],
    ['priya', "Anyone have a spare charger? Mine walked off somewhere"],
    ['sam', "New coffee brand in the kitchen, verdict: pretty good"],
    ['dre', 'Elevator maintenance tomorrow 9-11, use the stairs'],
    ['maya', 'Sending good vibes to everyone finishing report season 💪'],
    ['jo', 'Front desk plant finally died, sending it off with honors 🪴'],
    ['priya', 'Does the annex have a working microwave now? Heard it was fixed'],
    ['sam', "Parking lot got restriped, spots are in slightly different spots now"],
    ['dre', 'Reminder: submit your mileage forms by Friday'],
    ['maya', 'Nice writeup in the local paper about the after-school program.'],
    ['jo', "New photo release forms are in the shared drive, use those going forward"],
    ['priya', "Any recs for a good podcast for the commute?"],
    ['sam', "Someone's umbrella has been in the lost and found for a month, claim it"],
    ['dre', "Heat's back on in the annex, you're welcome"],
    ['maya', 'Reminder: no meetings scheduled during lunch block please.'],
    ['jo', "Updated the org chart, small tweaks only"],
    ['priya', "Happy almost-weekend, see everyone Monday"],
    ['sam', 'Anyone want to split an Costco run this weekend for snack supplies?'],
    ['dre', "Building inspection is Thursday, nothing to prep, just FYI"],
    ['maya', "Really proud of the team this month, that's all"],
    ['jo', 'Camera on the front desk laptop stopped working, filed a ticket'],
    ['priya', "Group chat for carpooling to the retreat, who's in?"],
    ['sam', "Vending machine ate my dollar, in loving memory 🪙"],
    ['dre', "New attendance clipboards came in, grabbing a stack for each site"],
    ['maya', 'Reminder that Monday is a federal holiday, office closed.'],
    ['jo', "Loved the photos from yesterday, adding a few to the newsletter"],
    ['priya', "Does anyone have the extra folding tables from the storage unit?"],
    ['sam', "Beans (the office dog) says hi again 🐶"],
    ['dre', 'FYI the shared calendar had a glitch, re-added the missing events'],
    ['maya', 'Nice to see so many familiar faces at the open house.'],
    ['jo', "Sent thank-you notes to this quarter's individual donors."],
    ['priya', "Who's bringing snacks to Friday's team meeting?"],
    ['sam', "Confetti everywhere from the volunteer party, worth it though 🎉"],
    ['dre', "Reminder to log hours in the new system, old spreadsheet is retired"],
    ['maya', 'Grateful for this team every single week, truly.'],
    ['jo', "New logo mockups are in the shared drive if anyone wants to weigh in"],
    ['priya', "Anyone know if the library partnership renewed for spring?"],
    ['sam', "Big thanks to the maintenance crew for the quick turnaround"],
    ['dre', "Reminder: submit incident reports same-day, not next week please"],
    ['maya', "Sending well wishes to anyone fighting the office cold going around"],
    ['jo', "Front window finally got the new decals up, looks sharp"],
    ['priya', "Does anyone have extra name tags from the retreat?"],
    ['sam', "Happy Monday, coffee's on in the back"],
    ['dre', "Copier toner order finally shipped, ETA Thursday"],
    ['maya', "Reminder: staff survey closes Friday, please fill it out"],
    ['jo', "Loved this week's team huddle energy"],
    ['priya', "Someone left their jacket in Room A, it's on the coat rack now"],
    ['sam', "Happy Friday eve, almost there"],
    ['dre', "Reminder that the annex parking lot gate code changed"],
    ['maya', "Thank you all for covering while I was out sick"],
    ['jo', "New hire paperwork templates are updated in the drive"],
    ['priya', "Anyone want to grab coffee before the Thursday session?"],
    ['sam', "It's raining, umbrellas by the front door if you need one"],
    ['dre', "Front desk phone line was down this morning, fixed now"],
    ['maya', "So glad we got through onboarding week smoothly"],
    ['jo', "Reminder: submit any press mentions to me for the scrapbook"],
    ['priya', "Loved catching up with everyone at lunch today"],
    ['sam', "Someone's headphones are on my desk, come get them"],
    ['dre', "Building manager says the HVAC fix is scheduled for next week"],
    ['maya', "Happy Friday team, you all earned the weekend"],
    ['jo', "Website contact form had a small bug, fixed now"],
    ['priya', "Does anyone have a spare umbrella I can borrow?"],
    ['sam', "New volunteer swag shirts came in, they look great"],
  ].map(([who, text]) => ({ ch: 'general', who, text })),

  // ── #program-updates — Dre's metrics home, occasional replies ──────
  { ch: 'program-updates', who: 'dre', text: "Weekly attendance rollup is up in the shared sheet, nothing unusual.", id: 'pu-1' },
  { ch: 'program-updates', who: 'maya', text: "Thanks Dre, numbers look steady, appreciate the consistency.", replyToId: 'pu-1' },
  ...[
    ['dre', "Site A attendance ticked up 4% this month, holding steady at Site B."],
    ['dre', 'Fixed the double-counting bug in the sign-in sheet from last week.'],
    ['dre', 'Homework help hours are up: 210 logged this month vs 180 last.'],
    ['dre', "New volunteer tutor pairings finalized for 12 more kids."],
    ['dre', "Reminder: sign-in sheets go in the blue folder, not the front desk tray."],
    ['dre', 'Q3 dropout rate holding at 3%, lowest we\'ve tracked in two years.'],
    ['dre', "Behavioral incident reports down 18% since the new check-in routine."],
    ['dre', 'Site B added a second cohort, capacity now 55 kids there.'],
    ['dre', "Snack program usage up — averaging 62 kids/day now."],
    ['dre', "Reminder: outcome surveys go out to families next Friday."],
    ['dre', 'New reading-level benchmarks logged for the K-3 cohort, mostly on track.'],
    ['dre', "Transportation grant covered 30 more bus passes this month."],
    ['dre', 'STEM club enrollment doubled since the spring push.'],
    ['dre', "Two more certified tutors started this week, good hires."],
    ['dre', 'Attendance tracker export is fixed, pulling clean CSVs now.'],
    ['dre', "Site C waitlist opened, 9 families signed up in the first day."],
    ['dre', 'Weekly check-in calls with families are at 92% completion rate.'],
    ['dre', "Flagging: two kids on the waitlist have been there 60+ days now."],
    ['dre', 'Mentor-mentee match rate is at 96%, best it\'s been all year.'],
    ['maya', 'These numbers are exactly what I need for the funder update, thank you.'],
    ['dre', 'Homework completion is up to 78% from 65% last semester.'],
    ['dre', 'New partnership with the library branch starts next month, more study space.'],
    ['dre', "Summer program planning kicked off, targeting 150 kids this year."],
    ['dre', 'Volunteer no-show rate is down to 6%, the new reminder texts are working.'],
    ['dre', "Attendance at Friday sessions specifically is our weak spot, digging in."],
    ['dre', 'Field trip permission slips are all in for next week, we\'re set.'],
    ['dre', "New case management software rollout is 80% done across sites."],
    ['maya', "@dre can you also send the March numbers when you get a sec?"],
    ['dre', "On it, will have March numbers by end of day."],
    ['dre', "March numbers: 44 of 49 mentees improved attendance, similar shape to Q2."],
    ['dre', 'Grant compliance checklist for the state contract is fully up to date.'],
    ['dre', "Two families moved out of district, sad to lose them but wished them well."],
    ['dre', 'Tutoring impact survey results are strong, sharing the summary Monday.'],
    ['dre', "Site A's new intake form cut processing time in half."],
    ['dre', 'Weekend enrichment pilot had 40 kids show up, more than expected.'],
    ['dre', "Program satisfaction scores from parents: 4.7 out of 5 this quarter."],
    ['dre', 'Reminder: end-of-semester reports due to me by the 15th.'],
    ['dre', "New volunteer training module is live, cuts onboarding time a lot."],
    ['dre', 'Chronic absenteeism is down across all three sites this year.'],
    ['dre', "Grant reporting for the county contract submitted on time."],
    ['dre', 'Adding a fourth site next fall if enrollment trends hold.'],
    ['dre', "Weekly staff huddle notes are in the shared doc as usual."],
    ['dre', 'STEM Saturday attendance keeps climbing, may need a bigger venue.'],
    ['dre', "New data dashboard is live, much easier to spot trends now."],
    ['dre', 'Two mentors hit their one-year anniversary this month, thank you both.'],
    ['dre', "Reminder: outcome data is due to me before any grant deadline, always."],
    ['dre', 'Site B\'s Thursday move is paying off, volume up as flagged before.'],
    ['dre', "Family engagement nights are averaging 30 households now, up from 18."],
  ].map(([who, text]) => ({ ch: 'program-updates', who, text })),

  // ── #mentor-stories — Priya's stories, long-form voice ──────────────
  ...[
    ['priya', "One of our newer mentors told me this week was the first time her mentee smiled the whole session. Small win, huge for me."],
    ['priya', "A 6th grader asked her mentor to help her write a letter to her future self. We're keeping copies (with permission) for the memory box."],
    ['priya', "Mentor training tonight went long because nobody wanted to leave, good problem to have."],
    ['priya', "One of our quieter kids asked to lead the icebreaker today. First time all year. Small thing, meant a lot."],
    ['priya', "A mentor emailed me just to say her mentee finally opened up about a rough week at home. Trust building, slow and real."],
    ['priya', "Two mentees who used to avoid each other are now study partners. Didn't see that coming."],
    ['priya', "A dad came by pickup just to say thank you, said his son talks about his mentor all week."],
    ['priya', "Had to hold back tears during check-ins today, in a good way."],
    ['priya', "New mentor cohort orientation went great, six new faces, all excited."],
    ['priya', "One mentee brought a drawing for her mentor unprompted. Framing that one in my head forever."],
    ['priya', "A teacher pulled me aside to say a kid in our program has completely turned around in class."],
    ['priya', "Mentor-mentee matching for the new cohort is done, feels like a good group."],
    ['priya', "One of our long-timers graduates the program this spring. Bittersweet doesn't cover it."],
    ['priya', "A mentee asked if his mentor could come to his basketball game. She went. Of course she went."],
    ['priya', "Retention check: 90% of matched pairs from last fall are still meeting weekly."],
    ['priya', "A parent said her daughter finally has someone besides family she trusts. That's the whole point, right there."],
    ['priya', "One of our shyest kids raised his hand to answer a question in group today. First time ever."],
    ['priya', "Mentor appreciation night is next month, already tearing up thinking about the speeches."],
    ['priya', "A former mentee came back to volunteer as a peer mentor. Full circle moment."],
    ['priya', "Session ran over because the group didn't want to stop talking about their goals. I'll take it."],
    ['priya', "One mentor pair hit their 100th session together this week. Milestone worth celebrating."],
    ['priya', "A mentee told her mentor she wants to be a teacher now. She wasn't sure about anything a year ago."],
    ['priya', "New intake interviews this week, three families, all great fits for the program."],
    ['priya', "A mentor brought in her old yearbook to show her mentee they're not so different."],
    ['priya', "Group session theme this week was 'what makes you proud of yourself.' Heavy, good, needed."],
    ['priya', "One of our mentees made honor roll for the first time. Mentor cried, I cried, everyone cried."],
    ['priya', "A sibling of a current mentee asked to join the program too. Waitlist is growing but happily."],
    ['priya', "Had a rough session today, one kid was having a hard week. Reminder that this work matters most on the hard days."],
    ['priya', "A mentor asked for extra training on trauma-informed check-ins. Scheduling that for next month."],
    ['priya', "One mentee's essay about her mentor is getting submitted to the school paper. So proud."],
    ['priya', "New mentor orientation packet is finalized, much cleaner than last year's."],
    ['priya', "A dad stopped by just to drop off cookies for the mentors. Small gesture, big heart."],
    ['priya', "Two mentees who started the year barely speaking now run the icebreaker themselves."],
    ['priya', "Mentor burnout check-ins this week, everyone's doing okay, a few need lighter loads next month."],
    ['priya', "A mentee's grandmother came to pickup just to meet the mentor in person. Lovely moment."],
    ['priya', "Session recap: goal-setting week went well, kids picked things like 'read 5 books' and 'try out for the team.'"],
    ['priya', "One of our mentors is moving but wants to keep mentoring remotely. Figuring out logistics."],
    ['priya', "A mentee thanked his mentor for 'believing him when no one else did.' I needed a minute after that one."],
    ['priya', "New batch of thank-you notes from mentees to mentors, posting a few (with permission) in the newsletter."],
    ['priya', "Mentor of the month nomination season, so many good stories to choose from."],
  ].map(([who, text]) => ({ ch: 'mentor-stories', who, text })),

  // ── #volunteers — Sam's counts + coordination ───────────────────────
  { ch: 'volunteers', who: 'sam', text: "New volunteer orientation this Saturday, 8 signed up so far!", id: 'vol-1' },
  { ch: 'volunteers', who: 'jo', text: "Nice, want me to send the reminder email to the group?", replyToId: 'vol-1' },
  { ch: 'volunteers', who: 'sam', text: "Yes please!! You're the best 🙏", replyToId: 'vol-1' },
  ...[
    ['sam', "Background checks cleared for all 6 new volunteers, they're good to go."],
    ['sam', "Volunteer hours this week: 412, on track for a great month."],
    ['sam', "Reminder: sign-in sheet is now digital, link pinned in this channel."],
    ['sam', "Shoutout to our longest-serving volunteer, 5 years this month! 🎉"],
    ['sam', "Volunteer appreciation dinner planning kicked off, save the date coming soon."],
    ['sam', "Two volunteers stepped up to cover the Saturday shift last minute, heroes."],
    ['sam', "New volunteer handbook is finalized, sending it out this week."],
    ['sam', "Volunteer of the month goes to Priya's mentor team, incredible energy all around."],
    ['sam', "Coordinating carpools for the field trip, DM me if you need a ride."],
    ['sam', "Volunteer retention this year is way up from last, so proud of this crew."],
    ['sam', "Two corporate groups signed up for a volunteer day next month, exciting."],
    ['sam', "Reminder: volunteer badges need to be worn on site, a few folks forgot last week."],
    ['sam', "New sign-up sheet for the winter event is live, spots filling fast."],
    ['sam', "Volunteer training session ran smooth today, good group of new folks."],
    ['sam', "225 active volunteers now, we crossed 200 last month and haven't slowed down."],
    ['sam', "Big thanks to the volunteers who came in on short notice for the storm cleanup."],
    ['sam', "Volunteer feedback survey results are in, mostly glowing, a few good suggestions."],
    ['sam', "New volunteer interest form got 14 submissions this week alone."],
    ['sam', "Coordinating with the local college for a service-learning partnership."],
    ['sam', "Volunteer hours YTD just crossed 3,600, incredible milestone."],
    ['sam', "Reminder: parking for volunteers is in the north lot now, not the front."],
    ['sam', "New volunteer swag order came in, handing out shirts this week."],
    ['sam', "Two long-time volunteers are training to become team leads, great growth."],
    ['sam', "Volunteer no-show rate keeps dropping thanks to the text reminders."],
    ['sam', "Planning the winter volunteer social, ideas welcome!"],
    ['sam', "Roster update: added 5 new names, removed 2 who moved away. Bittersweet."],
    ['sam', "Big group from the credit union volunteering Saturday, should be a fun one."],
    ['sam', "Volunteer supply closet restocked, gloves and vests are back in stock."],
    ['sam', "Shoutout to the weekend crew for handling the surprise rainout so well."],
  ].map(([who, text]) => ({ ch: 'volunteers', who, text })),

  // ── #events — recaps + photos, mostly Sam and Jo ────────────────────
  ...[
    ['sam', "Fall festival planning kickoff meeting is Thursday, bring ideas!"],
    ['jo', "Flyer draft for the festival is in the shared drive, feedback welcome."],
    ['sam', "Face painting and a bounce house are confirmed for the festival, kids are gonna love it."],
    ['sam', "Winter showcase date is locked in, mark your calendars."],
    ['jo', "Photos from last week's family night are up in the shared album."],
    ['sam', "Talent show signups are open, already have 12 acts registered."],
    ['sam', "Field day is a go for next Friday, weather permitting."],
    ['jo', "Press release for the STEM Saturday recap went out to the local paper."],
    ['sam', "Volunteer appreciation picnic is set for next month, catering booked."],
    ['sam', "Talent show recap: 18 acts, packed house, a magician stole the show 🎩"],
    ['jo', "Adding the talent show photos to the year-end highlight reel."],
    ['sam', "Movie night under the stars this Friday, popcorn machine is confirmed working this time."],
    ['sam', "Book fair brought in $600 for the library fund, best year yet."],
    ['jo', "New event photo consent forms are updated, use the latest version going forward."],
    ['sam', "Spring open house planning is underway, targeting 200 attendees."],
    ['sam', "Community cleanup day recap: 40 volunteers, 12 bags of litter, great turnout."],
    ['jo', "Local TV came by the open house, segment airs Thursday night."],
    ['sam', "Halloween event costumes contest had way more entries than expected, love it."],
    ['sam', "Winter showcase recap: 90 families attended, one of our biggest events yet."],
    ['jo', "Uploading the winter showcase photos now, so many good ones."],
    ['sam', "Game night fundraiser cleared its ticket goal by Wednesday, excited for Saturday."],
    ['sam', "Career day brought in 15 local professionals to speak, kids loved the firefighter."],
    ['jo', "New flyer for career day going out to families this week."],
    ['sam', "Talent show 2.0 planning starts next month, last one was such a hit."],
    ['sam', "Field trip to the science museum is booked for next quarter."],
    ['jo', "Photo release reminder: always check the list before posting group shots."],
    ['sam', "Spring cleanup crew found the old mural under all that ivy, restoring it next month."],
    ['sam', "Graduation ceremony for our 8th graders is set, invites going out."],
    ['jo', "Yearbook layout draft is ready for review, deadline is end of month."],
  ].map(([who, text]) => ({ ch: 'events', who, text })),

  // ── #grants — funding talk, the demo channel ────────────────────────
  { ch: 'grants', who: 'maya', text: "Kicking off our grant calendar review for next quarter, three deadlines coming up.", id: 'gr-1' },
  { ch: 'grants', who: 'dre', text: "I'll have outcome data ready for all three before the first deadline.", replyToId: 'gr-1' },
  ...[
    ['maya', "Flagging a new state youth-development RFP, deadline in 6 weeks."],
    ['dre', "That one lines up well with our attendance + survey data, good fit."],
    ['maya', "Reviewing last year's declined proposal to see what we can improve."],
    ['maya', "Reached out to our program officer for feedback on the last submission."],
    ['dre', "Compiling the outcome sheet for the mentoring RFP now."],
    ['maya', "Board wants a diversified funding mix this year, less reliance on one grant."],
    ['maya', "New corporate foundation opened applications, focus area matches us well."],
    ['dre', "Sent over the latest attendance numbers for whichever proposal needs them next."],
    ['maya', "Reminder: letters of support from partner schools are due to me by Friday."],
    ['maya', "Grant tracker spreadsheet updated with all open opportunities."],
    ['maya', "Talked to our accountant about matching-fund requirements for the county grant."],
    ['dre', "Checklist for the federal application is about 70% done on my end."],
    ['maya', "Scheduling a call with the funder to clarify the reporting requirements."],
    ['maya', "Reviewing budget narrative draft before it goes out, looks solid."],
    ['dre', "Flagging that our waitlist data strengthens the capacity-funding ask a lot."],
    ['maya', "Board approved pursuing two new grants this quarter, both good fits."],
    ['maya', "Following up on the site visit request from our current funder."],
    ['dre', "New logic model draft is ready for review whenever."],
    ['maya', "Grant renewal paperwork for the current county contract is in progress."],
    ['maya', "Thank-you letter to last year's biggest funder went out this week."],
    ['dre', "Compiling year-over-year outcome comparisons for the annual report."],
    ['maya', "New volunteer hours data will help the community-impact section a lot."],
    ['maya', "Scheduling internal review of the draft before it goes to the board for sign-off."],
    ['dre', "Attaching updated logic model and outcome sheet to the shared drive."],
    ['maya', "Great note from our program officer, they liked the last quarterly report."],
  ].map(([who, text]) => ({ ch: 'grants', who, text })),

  // ── #board — Maya's summaries, low volume, no thread ────────────────
  ...[
    ['maya', "Sending the Q1 board packet early this year, wanted extra review time."],
    ['maya', "Board retreat planning is underway, targeting early spring."],
    ['maya', "New board member orientation packet is finalized."],
    ['maya', "Committee chairs, please send your updates by end of week."],
    ['maya', "Board approved the revised strategic plan unanimously last meeting."],
    ['maya', "Annual report draft is with the design team now."],
    ['maya', "Reminder: board meeting minutes from last quarter are in the shared drive."],
    ['maya', "Finance committee flagged a small surplus this quarter, good news."],
    ['maya', "New board recruitment is going well, two strong candidates in the pipeline."],
    ['maya', "Governance committee updated our conflict-of-interest policy, minor changes."],
    ['maya', "Board chair asked for a deeper dive on program outcomes next meeting."],
    ['maya', "Site visit for board members is scheduled for next month."],
    ['maya', "Thank you to the board for the strong turnout at last week's meeting."],
    ['maya', "Annual fundraising gala date is set, save the evening."],
  ].map(([who, text]) => ({ ch: 'board', who, text })),

  // ── #budget-finance — privacy foil, jo mostly, never watched ────────
  ...[
    ['jo', "Updated the Q3 expense tracker, a few categories running over."],
    ['jo', "Payroll adjustment for the two new hires is processed."],
    ['jo', "Vendor invoice for the printer lease is overdue, following up."],
    ['jo', "Reserve fund is holding steady, no changes needed this quarter."],
    ['jo', "Reimbursement requests from last month are all processed."],
    ['jo', "New accounting software rollout is mostly done, minor kinks left."],
    ['jo', "Insurance renewal quote came in, slightly higher than last year."],
    ['jo', "Petty cash reconciliation for March is complete."],
    ['jo', "Grant drawdown request for the county contract submitted."],
    ['jo', "Year-end audit prep checklist is about halfway done."],
    ['jo', "Utility bill for the annex was higher than expected, checking the meter."],
    ['jo', "Updated the cash flow projection through year end, looks stable."],
    ['jo', "Vendor contract renewal for supplies is up for review next month."],
    ['jo', "Payroll taxes filed on time this quarter, no issues."],
  ].map(([who, text]) => ({ ch: 'budget-finance', who, text })),
];

// Real Slack channels mix quick one-liners with the occasional longer,
// multi-sentence post (a recap, a reflection, a detailed ask) — the filler
// above skewed uniformly short, which reads as generated. This adds genuine
// length variance per channel, still voice-disciplined per persona.
const LONGFORM_PLAN = [
  { ch: 'general', who: 'maya', text: "Wanted to take a second and just say how proud I am of this team. Between the STEM Saturday turnout, the board packet, and everyone covering for each other during the snow day mess, it's been a genuinely strong stretch. Thank you all, truly." },
  { ch: 'general', who: 'jo', text: "PSA since a few people asked: the new photo release forms are mandatory for anything going in the newsletter or on social, no exceptions, even for quick candid shots at events. I know it's an extra step but it protects the families and it protects us. Grab a stack from the front desk if you're heading to an event this week." },
  { ch: 'general', who: 'sam', text: "Okay so the office dog incident today deserves its own paragraph. Beans got into the volunteer welcome baskets, ate approximately zero of the granola bars but destroyed the ribbon on every single one, and then looked extremely proud of himself the whole time. 10/10, no notes, please never train him out of this." },
  { ch: 'general', who: 'dre', text: "Longer note than usual: the building manager confirmed the HVAC contractor is coming Thursday, not Tuesday like I said earlier, so the annex will still be cold through Wednesday. Bring a layer, and if anyone has a portable heater sitting at home we could use one or two in the meantime, just make sure it's the kind that auto-shuts-off." },
  { ch: 'general', who: 'priya', text: "Random appreciation post: I've been doing this job for four years now and the thing that never stops being true is that the small moments matter more than the big wins. A kid remembering your name, a parent nodding instead of arguing, a mentor showing up even on a bad day. None of that shows up in a spreadsheet but it's the whole job." },
  { ch: 'program-updates', who: 'dre', text: "Longer update than usual because there's a lot to unpack from this month. Attendance across all three sites is up 6% overall, but the gains are uneven — Site A is carrying most of it while Site C is basically flat, which tracks with the staffing gap we talked about last quarter. I'm going to pull a site-by-site breakdown for the next board packet so Maya has the full picture, not just the aggregate number, because the aggregate is honestly hiding a problem." },
  { ch: 'program-updates', who: 'dre', text: "Wanted to explain the survey methodology change since a few people asked why the numbers jumped this cycle. We switched from a 5-point to a 4-point scale to remove the neutral option, which pushes respondents to actually take a side, and that's most of why 'trust' scores look different from last year's report. Same underlying instrument otherwise, so the comparison is still fair, just worth footnoting in anything external-facing." },
  { ch: 'program-updates', who: 'maya', text: "This is exactly the kind of trend line I need for funder conversations — steady program growth alongside a real capacity constraint gives us a much stronger ask than just 'we want more money.' Can we get a one-pager version of this by next week? I have a call with a potential funder and would love to bring hard numbers instead of just talking points." },
  { ch: 'mentor-stories', who: 'priya', text: "Longer story from today because I don't want to lose the details. One of our mentors has been working with a kid who, back in September, wouldn't make eye contact with anyone, adult or peer. Today during check-in he asked HER how her day was first, before she could even ask him. She texted me about it the second she got to her car because she didn't want to forget how it felt. That's the whole job, right there, in one text message." },
  { ch: 'mentor-stories', who: 'priya', text: "Sharing this one with permission from the family: a mom told me at pickup that her son used to dread Tuesdays because that used to be the day report cards came home and things weren't going well. Now Tuesday is mentor day and it's his favorite day of the week. She said she almost didn't believe it was the same kid. I've been thinking about that all afternoon." },
  { ch: 'mentor-stories', who: 'priya', text: "A slightly harder one to share but I think it matters: one of our newer mentors almost quit last month, felt like she wasn't making progress with a really guarded kid. I encouraged her to stick with it one more cycle. This week that same kid asked if she could come to his soccer game. Sometimes the breakthrough takes longer than we'd like, and that's exactly why consistency matters more than any single session." },
  { ch: 'volunteers', who: 'sam', text: "Longer post because I want to properly thank the crew who showed up for the storm cleanup this weekend on basically zero notice. We had branches down across the whole back lot, standing water near the entrance, and a fence panel that just gave up entirely. Twelve people showed up within two hours of the group text going out, no complaints, just work gloves and good attitudes. This is why I love this program." },
  { ch: 'volunteers', who: 'sam', text: "Quick explainer on the new background check process since a few new folks asked: it now takes about 5 business days instead of 2 weeks because we switched vendors, and you'll get an email directly from them, not from us, so check your spam folder if it's been a week with nothing. Ping me if you're still waiting past day 7 and I'll follow up on my end." },
  { ch: 'events', who: 'jo', text: "Recap post since I know not everyone could make it: the winter showcase pulled in easily our biggest crowd yet, somewhere north of 90 families by my count at the door, plus a handful of walk-ins we didn't expect. The talent show portion ran long because nobody wanted to leave, which is a great problem to have, and the local news segment airing Thursday should give us another nice bump in visibility going into spring enrollment season." },
  { ch: 'events', who: 'sam', text: "Longer recap from STEM Saturday because the short version doesn't do it justice: 118 kids came through across the four activity stations, we ran out of the robotics kits by 11am and had to improvise with cardboard and tape (which honestly the kids loved even more), and a local news crew showed up unannounced and interviewed three of our mentors on camera. Photos are in the thread, more coming as people upload from their phones." },
  { ch: 'grants', who: 'maya', text: "Longer strategy note for the team: I've been mapping out our grant calendar against staff capacity and I think we're overextending if we chase all three of the opportunities on the board right now. I'd rather submit two strong, well-supported applications than three rushed ones. Dre, can we talk this week about which two make the most sense given where our outcome data is strongest?" },
  { ch: 'grants', who: 'dre', text: "Longer answer to your question above: I think the youth-development RFP and the mentoring-specific one are our strongest bets because both of them map directly onto data we already have clean and ready — attendance, the trust survey, and the tutoring hours. The federal one is a great fit on paper but the reporting burden is heavy and I don't think we have the staff bandwidth to do it justice on top of everything else this quarter." },
  { ch: 'board', who: 'maya', text: "Longer note ahead of next week's meeting: I want to spend real time on the capacity conversation rather than rushing through it at the end like we did last quarter. Demand is genuinely outpacing what we can staff, and I'd rather the board hear that clearly, with the waitlist numbers in front of them, than have it buried in an appendix. I'll send the full packet Monday but wanted to flag the emphasis change now." },
  { ch: 'budget-finance', who: 'jo', text: "Longer note on the reserve fund since Maya asked for detail: we're currently sitting at just under four months of operating expenses in reserve, which is below our policy target of six but not alarming given the grant timing this quarter. Once the county drawdown clears, likely within two weeks, we should be back above five months. Flagging so nobody's surprised by the dip if they're looking at the dashboard." },
];

// A channel where every message is from the same one or two authors reads
// as a bulletin feed, not a live team Slack (Chaitanya: "a pile of messages
// that look like single messages sent by the person" after seeing #volunteers
// as an unbroken wall of sam). This gives other personas a voice via threaded
// reactions/follow-ups scattered through every channel, not just the two
// hand-authored thread pairs above.
const REPLY_BANK = {
  general: ['lol 😂', 'noted, thanks', 'wait really?', 'same here honestly', 'appreciate the heads up', 'ha, classic', 'on my way', 'can confirm', '🙌', 'this made me smile ngl', 'good to know'],
  'program-updates': ['these numbers look great', 'nice, thanks for pulling this together', 'can you send the full breakdown separately?', 'this is going straight into the report', 'wow, big jump', 'flagging this for the board deck', 'appreciate the detail here', 'good context, thank you'],
  'mentor-stories': ['this made my whole week honestly', 'sending tissues 😭', 'these stories are why we do this', 'love this so much', 'can we share this (anonymized) in the newsletter?', 'wow. just wow.', 'this is everything', 'okay I teared up a little'],
  volunteers: ['incredible turnout', 'so proud of this crew', 'they earned every bit of that appreciation', 'this is amazing, thank you all', 'can we shout this out in the newsletter?', 'love seeing this number climb', 'heroes, seriously', 'this crew never stops impressing me'],
  events: ['this looks like it was such a good time', 'the photos are great', "can't wait for the next one", 'this made the local group chat too, everyone was talking about it', 'amazing turnout', 'so glad this went well'],
  grants: ['good call, let\'s align on that', "makes sense, I'll get you what you need", 'agreed, let\'s prioritize those two', 'this strengthens the ask a lot', 'thanks for digging into this', 'great, keep me posted'],
  board: ['thank you for the thorough update', 'looking forward to discussing this further', 'appreciate the transparency here', 'good flag, let\'s make time for it'],
  'budget-finance': ['thanks for flagging', "makes sense, let's keep an eye on it", 'good to know, appreciate the update'],
};

function otherPersonaFrom(exclude) {
  const options = Object.keys(PERSONAS).filter((p) => !exclude.includes(p));
  return options[Math.floor(Math.random() * options.length)];
}

let autoReplyCounter = 0;
function addCrossTalk(byChannel) {
  for (const ch of Object.keys(byChannel)) {
    const bank = REPLY_BANK[ch] ?? REPLY_BANK.general;
    const out = [];
    for (const m of byChannel[ch]) {
      out.push(m);
      if (m.replyToId) continue; // don't reply to a reply
      if (Math.random() < 0.42) {
        const id = m.id ?? (m.id = `auto-${ch}-${autoReplyCounter++}`);
        const replier = otherPersonaFrom([m.who]);
        out.push({ ch, who: replier, text: bank[Math.floor(Math.random() * bank.length)], replyToId: id });
        if (Math.random() < 0.22) {
          const replier2 = otherPersonaFrom([m.who, replier]);
          out.push({ ch, who: replier2, text: bank[Math.floor(Math.random() * bank.length)], replyToId: id });
        }
      }
    }
    byChannel[ch] = out;
  }
}

// Interleave CORE_PLAN/FILLER_PLAN/LONGFORM_PLAN per channel (channel-local
// order preserved so thread pairs never need to look outside their own
// channel's relative sequence), scatter cross-persona replies through every
// channel, then round-robin channels so the posting order isn't just
// "all core, then all filler."
function mergePlan(...lists) {
  const byChannel = {};
  for (const ch of Object.keys(CHANNELS)) byChannel[ch] = [];
  for (const list of lists) for (const m of list) byChannel[m.ch].push(m);
  addCrossTalk(byChannel);
  const queues = Object.values(byChannel);
  const result = [];
  let more = true;
  while (more) {
    more = false;
    for (const q of queues) if (q.length) { result.push(q.shift()); more = true; }
  }
  return result;
}

const PLAN = mergePlan(CORE_PLAN, FILLER_PLAN, LONGFORM_PLAN);

// Slack has no channel-delete API and won't let you create a channel whose
// name is held by an archived one, so a real wipe is archive-old-and-rename,
// then let ensureChannels create fresh channels under the original names.
// Refuses to touch a channel the bot isn't a member of — safest signal that
// this script didn't create it.
async function wipeChannels() {
  const existing = await bot.conversations.list({ types: 'public_channel', limit: 200 });
  const stamp = Date.now();
  for (const name of Object.keys(CHANNELS)) {
    const found = existing.channels.find((c) => c.name === name);
    if (!found || found.is_archived) continue;
    if (!found.is_member) { console.warn(`[wipe] skipping #${name} — bot is not a member`); continue; }
    const renamed = `${name}-old-${stamp}`;
    await bot.conversations.rename({ channel: found.id, name: renamed }).catch((e) =>
      console.warn(`[wipe] could not rename #${name}: ${e?.data?.error ?? e.message}`));
    await bot.conversations.archive({ channel: found.id }).catch((e) =>
      console.warn(`[wipe] could not archive #${name}: ${e?.data?.error ?? e.message}`));
    console.log(`[wipe] archived #${name} as #${renamed}`);
  }
}

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
    // SEED_BOT_TOKEN is the seeder app (a different Slack app from
    // Grantweaver itself) — live-caught bug: nothing ever invited the
    // actual Grantweaver bot into freshly (re)created channels, so
    // @-mentioning it after a --wipe reseed silently did nothing (no
    // app_mention event ever fires for a bot that isn't a channel member).
    if (process.env.SLACK_BOT_TOKEN) {
      try {
        const gw = new WebClient(process.env.SLACK_BOT_TOKEN);
        const gwUserId = (await gw.auth.test()).user_id;
        await bot.conversations.invite({ channel: ids[name], users: gwUserId }).catch(() => {});
      } catch { /* SLACK_BOT_TOKEN missing/invalid in this environment — skip */ }
    }
  }
  return { ids, joined };
}

async function postPlan(ids, joined) {
  const tsByIndex = [];
  const tsById = {};
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
    // id/replyToId (not array-position offsets) so filler can be freely
    // interleaved per channel without breaking existing thread pairs.
    const thread_ts = m.replyToId != null ? tsById[m.replyToId] ?? undefined : undefined;
    let res;
    if (client) {
      res = await client.chat.postMessage({ channel, text: m.text, thread_ts });
    } else {
      res = await bot.chat.postMessage({
        channel, text: m.text, thread_ts,
        username: persona.name, // needs chat:write.customize
        ...(persona.icon_url ? { icon_url: persona.icon_url } : {}),
      });
    }
    tsByIndex.push(res.ts);
    if (m.id) tsById[m.id] = res.ts;
    posted++;
    if (m.star === 'R') {
      const reactor = clientFor('maya') ?? bot;
      await reactor.reactions.add({ channel, timestamp: res.ts, name: 'thread' }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 350));
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

// Grants.gov's own /search2 endpoint does weak relevance matching — a
// "youth mentoring" query live-verified to return "Ovarian Cancer Clinical
// Trial Academy" and "Bureau of Land Management Rangeland Resource
// Management" in its top 10, neither containing either search word. A
// seeded demo pipeline full of unrelated grants undermines the whole point
// of the demo, so filter candidates for actual topical relevance (title
// match) client-side rather than trusting the API's ranking, and widen the
// query if one pass doesn't surface enough real matches.
const RELEVANCE_WORDS = /youth|mentor|after.?school|adolescen|teen|student|education|child|family|community/i;
async function resolveRealOpps() {
  // F9 fix: every seeded pipeline row must resolve live via fetchOpportunity
  // — a fictional opp_id breaks get_opportunity_details on camera.
  const queries = ['youth mentoring', 'youth development', 'after school education', 'community youth services'];
  const seen = new Set();
  const verified = [];
  for (const keyword of queries) {
    if (verified.length >= 4) break;
    const candidates = await grantsGov.search({ keyword, oppStatuses: 'posted', rows: 20 }).catch(() => []);
    const relevant = candidates.filter((c) => RELEVANCE_WORDS.test(c.title) && !seen.has(c.opp_id));
    for (const c of relevant) {
      if (verified.length >= 4) break;
      const details = await grantsGov.fetchOpportunity(c.opp_id).catch(() => null);
      if (details) { verified.push({ ...c, details }); seen.add(c.opp_id); }
    }
  }
  if (verified.length < 4) throw new Error(`Only ${verified.length}/4 topically-relevant, live-resolving opp_ids found across ${queries.length} queries — check Grants.gov reachability/relevance before seeding state.`);
  return verified;
}

// Clears everything derived from prior seed/demo runs for this team so a
// --wipe reseed starts genuinely fresh (not just new channels over stale
// pipeline rows) — order respects FK dependencies on opportunities/orgs.
async function wipeState(pool, teamId) {
  for (const table of ['opp_activity', 'watches', 'evidence_index', 'pending_intents', 'signals', 'opportunities']) {
    await pool.query(`DELETE FROM ${table} WHERE team_id=$1`, [teamId]);
  }
  console.log('[wipe] cleared opportunities/watches/evidence_index/activity/signals/pending_intents for this team.');
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
  // Live-caught bug: this used to store the literal persona handle
  // ('dre', 'jo') as owner_user_id — not a real Slack user ID — which
  // silently broke List sync (owner is a `user` column type; Slack's API
  // rejects anything not matching a real user ID with invalid_arguments).
  // Resolve the real ID via the persona's own token, falling back to null
  // (unassigned) if that persona has no token in this environment.
  const ownerHandles = { drafting: 'dre', reviewing: 'jo' };
  const owners = {};
  for (const [stage, handle] of Object.entries(ownerHandles)) {
    const client = clientFor(handle);
    owners[stage] = client ? (await client.auth.test().catch(() => null))?.user_id ?? null : null;
  }
  for (let i = 0; i < stages.length; i++) {
    const o = opps[i], stage = stages[i];
    await pool.query(
      `INSERT INTO opportunities (team_id, opp_id, opp_number, title, agency, close_date, award_ceiling, url, stage, match_score, owner_user_id, last_activity_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() - ($12 || ' days')::interval)
       ON CONFLICT (team_id, opp_id) DO UPDATE SET stage=EXCLUDED.stage, title=EXCLUDED.title,
         agency=EXCLUDED.agency, owner_user_id=EXCLUDED.owner_user_id, updated_at=now()`,
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

  if (flags.has('--wipe')) {
    await wipeChannels();
    await wipeState(pool, teamId);
  }

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
  // @slack/web-api's WebClient keeps an HTTP keep-alive agent open, which
  // otherwise leaves this one-shot CLI script hanging indefinitely after a
  // successful run instead of exiting (live-caught: a run sat alive for
  // hours after printing "Done.", starving later --verify runs of DB
  // connections).
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
