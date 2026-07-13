import { describe, expect, it } from 'vitest';

import { shortenModelName } from '../src/office/modelLabel.js';

describe('shortenModelName', () => {
  it('shortens opus with major.minor', () => {
    expect(shortenModelName('claude-opus-4-8')).toBe('opus 4.8');
  });
  it('shortens sonnet with major only', () => {
    expect(shortenModelName('claude-sonnet-5')).toBe('sonnet 5');
  });
  it('strips a trailing date', () => {
    expect(shortenModelName('claude-haiku-4-5-20251001')).toBe('haiku 4.5');
  });
  it('returns unrecognized input unchanged', () => {
    expect(shortenModelName('gpt-4o')).toBe('gpt-4o');
  });
  it('handles empty string', () => {
    expect(shortenModelName('')).toBe('');
  });
});
