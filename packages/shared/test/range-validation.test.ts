import { describe, it, expect } from 'vitest';
import { parseRangeHeader, validateRangeAgainstSize } from '../src/protocol/schemas';

// Re-import the range functions from proxy.ts logic (they're not exported from shared,
// so we re-implement the test against the shared validateRangeAgainstSize helper
// and test the parseRangeHeader logic separately).

describe('parseRangeHeader — syntax parsing', () => {
  it('returns null for undefined header', () => {
    expect(parseRangeHeader(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseRangeHeader('')).toBeNull();
  });

  it('parses bytes=0-99', () => {
    expect(parseRangeHeader('bytes=0-99')).toEqual({ start: 0, end: 99 });
  });

  it('parses bytes=100- (open-ended)', () => {
    expect(parseRangeHeader('bytes=100-')).toEqual({ start: 100, end: undefined });
  });

  it('returns null for end < start', () => {
    expect(parseRangeHeader('bytes=50-49')).toBeNull();
  });

  it('returns null for invalid syntax', () => {
    expect(parseRangeHeader('items=0-10')).toBeNull();
    expect(parseRangeHeader('bytes=abc-def')).toBeNull();
    expect(parseRangeHeader('bytes=-10')).toBeNull();
  });

  it('trims whitespace', () => {
    expect(parseRangeHeader('  bytes=0-99  ')).toEqual({ start: 0, end: 99 });
  });
});

describe('validateRangeAgainstSize — satisfiability', () => {
  it('accepts valid range within file', () => {
    expect(validateRangeAgainstSize({ start: 0, end: 99 }, 100)).toBeNull();
    expect(validateRangeAgainstSize({ start: 50, end: 99 }, 100)).toBeNull();
  });

  it('accepts open-ended range', () => {
    expect(validateRangeAgainstSize({ start: 50, end: undefined }, 100)).toBeNull();
  });

  it('rejects start >= fileSize', () => {
    expect(validateRangeAgainstSize({ start: 100, end: 199 }, 100)).not.toBeNull();
    expect(validateRangeAgainstSize({ start: 200, end: 299 }, 100)).not.toBeNull();
  });

  it('rejects end >= fileSize', () => {
    expect(validateRangeAgainstSize({ start: 0, end: 100 }, 100)).not.toBeNull();
    expect(validateRangeAgainstSize({ start: 50, end: 200 }, 100)).not.toBeNull();
  });

  it('rejects empty file', () => {
    expect(validateRangeAgainstSize({ start: 0, end: 0 }, 0)).toBe('empty file');
  });

  it('accepts full range of exact file size', () => {
    expect(validateRangeAgainstSize({ start: 0, end: 999 }, 1000)).toBeNull();
  });

  it('accepts range at end of file', () => {
    expect(validateRangeAgainstSize({ start: 999, end: 999 }, 1000)).toBeNull();
  });
});
