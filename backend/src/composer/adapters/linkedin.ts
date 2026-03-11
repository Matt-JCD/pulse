import type { AccountSlug, ComposerPost, PlatformResult } from '../types.js';

const LINKEDIN_UGC_POSTS_URL = 'https://api.linkedin.com/v2/ugcPosts';

interface LinkedInTarget {
  accessToken: string;
  authorUrn: string;
}

function isUrn(value: string): boolean {
  return value.startsWith('urn:li:');
}

export function normalizeLinkedInAuthorUrn(value: string): string {
  const trimmed = value.trim();
  return isUrn(trimmed) ? trimmed : `urn:li:person:${trimmed}`;
}

export function normalizeLinkedInPostUrn(value: string): string {
  const trimmed = value.trim();
  return isUrn(trimmed) ? trimmed : `urn:li:share:${trimmed}`;
}

export function toLinkedInFeedUrl(postUrn: string): string {
  return `https://www.linkedin.com/feed/update/${postUrn}/`;
}

export function resolveLinkedInTarget(
  account: AccountSlug,
  env: NodeJS.ProcessEnv = process.env,
): LinkedInTarget | { error: string } {
  if (account === 'matt_linkedin') {
    const accessToken = env.LINKEDIN_MATT_ACCESS_TOKEN;
    const authorUrn = env.LINKEDIN_MATT_PERSON_URN;

    if (!accessToken || !authorUrn) {
      return {
        error: 'LinkedIn Matt publishing is not configured. Set LINKEDIN_MATT_ACCESS_TOKEN and LINKEDIN_MATT_PERSON_URN.',
      };
    }

    return {
      accessToken,
      authorUrn: normalizeLinkedInAuthorUrn(authorUrn),
    };
  }

  return {
    error: `LinkedIn publishing is only enabled for matt_linkedin right now. ${account} should stay disabled until page posting is approved.`,
  };
}

/**
 * Publishes a text-only LinkedIn post via the Share on LinkedIn UGC API.
 * This currently targets Matt's personal account only.
 */
export async function publish(post: ComposerPost): Promise<PlatformResult> {
  try {
    const target = resolveLinkedInTarget(post.account);
    if ('error' in target) {
      return {
        platform: 'linkedin',
        success: false,
        error: target.error,
      };
    }

    const res = await fetch(LINKEDIN_UGC_POSTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${target.accessToken}`,
        'Content-Type': 'application/json',
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify({
        author: target.authorUrn,
        lifecycleState: 'PUBLISHED',
        specificContent: {
          'com.linkedin.ugc.ShareContent': {
            shareCommentary: {
              text: post.content,
            },
            shareMediaCategory: 'NONE',
          },
        },
        visibility: {
          'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC',
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return {
        platform: 'linkedin',
        success: false,
        error: `LinkedIn API ${res.status}: ${body}`,
      };
    }

    const restLiId = res.headers.get('x-restli-id');
    const postUrn = restLiId ? normalizeLinkedInPostUrn(restLiId) : undefined;

    return {
      platform: 'linkedin',
      success: true,
      postId: postUrn,
      url: postUrn ? toLinkedInFeedUrl(postUrn) : undefined,
    };
  } catch (err) {
    return {
      platform: 'linkedin',
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
