import { describe, expect, it } from 'vitest';
import {
  normalizeLinkedInAuthorUrn,
  normalizeLinkedInPostUrn,
  resolveLinkedInTarget,
  toLinkedInFeedUrl,
} from './linkedin.js';

describe('linkedin adapter helpers', () => {
  it('normalizes bare person ids into person urns', () => {
    expect(normalizeLinkedInAuthorUrn('abc123')).toBe('urn:li:person:abc123');
    expect(normalizeLinkedInAuthorUrn('urn:li:person:abc123')).toBe('urn:li:person:abc123');
  });

  it('normalizes bare share ids into share urns', () => {
    expect(normalizeLinkedInPostUrn('987654321')).toBe('urn:li:share:987654321');
    expect(normalizeLinkedInPostUrn('urn:li:share:987654321')).toBe('urn:li:share:987654321');
  });

  it('resolves matt linkedin publishing target from env', () => {
    const target = resolveLinkedInTarget('matt_linkedin', {
      LINKEDIN_MATT_ACCESS_TOKEN: 'token',
      LINKEDIN_MATT_PERSON_URN: 'person-id',
    });

    expect('error' in target).toBe(false);
    if ('error' in target) {
      throw new Error(target.error);
    }

    expect(target.accessToken).toBe('token');
    expect(target.authorUrn).toBe('urn:li:person:person-id');
  });

  it('rejects non-matt linkedin accounts for publishing', () => {
    const target = resolveLinkedInTarget('prefactor_linkedin', {});
    expect(target).toEqual({
      error: 'LinkedIn publishing is only enabled for matt_linkedin right now. prefactor_linkedin should stay disabled until page posting is approved.',
    });
  });

  it('builds a LinkedIn feed URL from the post urn', () => {
    expect(toLinkedInFeedUrl('urn:li:share:123')).toBe('https://www.linkedin.com/feed/update/urn:li:share:123/');
  });
});
