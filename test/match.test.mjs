import { describe, it, expect } from 'vitest';
import { scoreMatch } from '../src/agent/tools.js';

describe('scoreMatch', () => {
  const org = { mission: 'After-school mentorship for under-served youth in Dayton, Ohio',
    focus_areas: ['youth', 'education'] };
  it('scores focus-area hits', () => {
    const { match_score } = scoreMatch({ title: 'Youth Mentoring Initiative', synopsis: 'education programs' }, org);
    expect(match_score).toBeGreaterThan(0.6);
  });
  it('handles missing profile', () => {
    const { match_score, match_reason } = scoreMatch({ title: 'Anything' }, null);
    expect(match_score).toBe(0.5);
    expect(match_reason).toContain('setup');
  });
});
