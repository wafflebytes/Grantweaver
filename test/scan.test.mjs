import { describe, it, expect } from 'vitest';
import { scanQueries } from '../src/services/scan.js';

describe('scanQueries', () => {
  it('is deterministic for the same org profile', () => {
    const org = { focus_areas: ['youth', 'education'] };
    expect(scanQueries(org)).toEqual(scanQueries(org));
  });

  it('caps at 8 queries and always includes the 4 fixed probes', () => {
    const org = { focus_areas: ['a', 'b', 'c', 'd', 'e'] }; // >4 focus areas
    const qs = scanQueries(org);
    expect(qs.length).toBeLessThanOrEqual(8);
    expect(qs.some((q) => q.label.includes('attendance'))).toBe(true);
    expect(qs.some((q) => q.label.includes('testimonial'))).toBe(true);
  });

  it('degrades gracefully with no focus areas', () => {
    const qs = scanQueries({});
    expect(qs.length).toBe(4); // just the fixed probes
  });
});
