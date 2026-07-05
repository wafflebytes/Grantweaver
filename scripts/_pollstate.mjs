import { db } from '../src/services/db.js';
const org = await db.getOrg('T0BESJ1MU7Q');
const n = await db.countEvidence('T0BESJ1MU7Q');
console.log(JSON.stringify({ step: org?.onboarding_state?.step ?? null, index_built_at: org?.index_built_at, evidence_list_id: org?.evidence_list_id, evidenceCount: n }));
process.exit(0);
