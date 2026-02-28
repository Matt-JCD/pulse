import type { PlatformResult } from '../types.js';

// TODO: LinkedIn API access is pending.
// When approved, implement:
// 1. OAuth 2.0 authentication with LINKEDIN_ACCESS_TOKEN
// 2. POST to https://api.linkedin.com/v2/ugcPosts (or /rest/posts with v2 API)
// 3. Include LINKEDIN_PERSON_URN as the author
// 4. Return platform_post_id and post URL on success

/**
 * Stub — LinkedIn API access is not yet configured.
 * Returns a descriptive error so the orchestrator knows why.
 */
export async function publish(_content: string): Promise<PlatformResult> {
  return {
    platform: 'linkedin',
    success: false,
    error: 'LinkedIn API access pending — not yet configured.',
  };
}
