// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  formatOpsSuccessRate,
  formatOpsTimestamp,
  openclashApiTone,
} from './App';

describe('network ops dashboard helpers', () => {
  it('formats update timestamps as a compact local clock', () => {
    const timestamp = new Date(2026, 5, 9, 8, 7, 6).getTime();

    expect(formatOpsTimestamp(timestamp)).toBe('08:07:06');
    expect(formatOpsTimestamp(null)).toBe('—');
  });

  it('formats current node success rate as a whole percent', () => {
    expect(formatOpsSuccessRate(0.955)).toBe('96%');
    expect(formatOpsSuccessRate(1)).toBe('100%');
    expect(formatOpsSuccessRate(null)).toBe('—');
  });

  it('maps OpenClash API state to semantic ops tones', () => {
    expect(openclashApiTone(true)).toBe('ok');
    expect(openclashApiTone('auth_error')).toBe('warn');
    expect(openclashApiTone(false)).toBe('bad');
  });
});
