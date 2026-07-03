import fs from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false } });

const dir = new URL('../migrations/', import.meta.url);
const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
for (const f of files) {
  const sql = await fs.readFile(new URL(f, dir), 'utf8');
  console.log(`applying ${f}…`);
  await pool.query(sql);
}
console.log('migrations complete');
await pool.end();
