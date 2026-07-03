// TODO(T3.4): weekly digest + deadline-sweep cron registrations (docs/06 §8).
export function startScheduler(_app) {
  console.log('[scheduler] not yet wired — no-op (T3.4)');
}

/** TODO(T3.4): exported for tests & manual runs once the real sweep lands. */
export async function runDeadlineSweepOnce(_client) {}
