// Usage: node scripts/try-grants.mjs "youth mentoring"
const keyword = process.argv[2] ?? 'youth mentoring';
const r = await fetch('https://api.grants.gov/v1/api/search2', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ keyword, oppStatuses: 'posted|forecasted', rows: 5, startRecordNum: 0 }),
});
const data = await r.json();
console.log('hitCount:', data?.data?.hitCount);
console.dir(data?.data?.oppHits?.[0], { depth: 5 }); // ← copy real field names into the MCP server mapper
