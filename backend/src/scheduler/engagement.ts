import { supabase } from '../db/supabase.js';
import type { ComposerPost } from '../composer/types.js';

const LINKEDIN_MATT_ACCESS_TOKEN = process.env.LINKEDIN_MATT_ACCESS_TOKEN;
const LINKEDIN_PREFACTOR_ACCESS_TOKEN = process.env.LINKEDIN_PREFACTOR_ACCESS_TOKEN;
const LINKEDIN_ORG_ID = process.env.LINKEDIN_ORG_ID;
const X_BEARER_TOKEN = process.env.X_BEARER_TOKEN;

function normalizeLinkedInShareUrn(postId: string | null): string | null {
  if (!postId) return null;
  return postId.startsWith('urn:li:') ? postId : `urn:li:share:${postId}`;
}

interface EngagementStats {
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
}

const ZERO_STATS: EngagementStats = { impressions: 0, likes: 0, comments: 0, shares: 0 };

/**
 * Fetches engagement stats from the LinkedIn API.
 *
 * Matt's personal account uses the Member Social Actions endpoint.
 * Prefactor's company page uses the Organization Share Statistics endpoint.
 */
async function fetchLinkedInEngagement(post: ComposerPost): Promise<EngagementStats> {
  try {
    if (post.account === 'matt_linkedin') {
      if (!LINKEDIN_MATT_ACCESS_TOKEN) {
        console.warn('[engagement] LINKEDIN_MATT_ACCESS_TOKEN not set — skipping');
        return ZERO_STATS;
      }

      const socialActionUrn = normalizeLinkedInShareUrn(post.platform_post_id);
      if (!socialActionUrn) {
        return ZERO_STATS;
      }

      const res = await fetch(
        `https://api.linkedin.com/v2/socialActions/${socialActionUrn}`,
        { headers: { Authorization: `Bearer ${LINKEDIN_MATT_ACCESS_TOKEN}` } },
      );

      if (!res.ok) {
        console.error(`[engagement] LinkedIn Matt API ${res.status} for post #${post.id}`);
        return ZERO_STATS;
      }

      const data = await res.json() as {
        likesSummary?: { totalLikes?: number };
        commentsSummary?: { totalFirstLevelComments?: number };
      };

      return {
        impressions: 0, // Member Social Actions endpoint doesn't return impressions
        likes: data.likesSummary?.totalLikes ?? 0,
        comments: data.commentsSummary?.totalFirstLevelComments ?? 0,
        shares: 0,
      };
    }

    // prefactor_linkedin — Organization Share Statistics
    if (!LINKEDIN_PREFACTOR_ACCESS_TOKEN || !LINKEDIN_ORG_ID) {
      console.warn('[engagement] LINKEDIN_PREFACTOR_ACCESS_TOKEN or LINKEDIN_ORG_ID not set — skipping');
      return ZERO_STATS;
    }

    const shareUrn = normalizeLinkedInShareUrn(post.platform_post_id);
    if (!shareUrn) {
      return ZERO_STATS;
    }

    const res = await fetch(
      `https://api.linkedin.com/v2/organizationalEntityShareStatistics?q=organizationalEntity&organizationalEntity=${LINKEDIN_ORG_ID}&shares=${shareUrn}`,
      { headers: { Authorization: `Bearer ${LINKEDIN_PREFACTOR_ACCESS_TOKEN}` } },
    );

    if (!res.ok) {
      console.error(`[engagement] LinkedIn Prefactor API ${res.status} for post #${post.id}`);
      return ZERO_STATS;
    }

    const data = await res.json() as {
      elements?: Array<{
        totalShareStatistics?: {
          impressionCount?: number;
          likeCount?: number;
          commentCount?: number;
          shareCount?: number;
        };
      }>;
    };

    const stats = data.elements?.[0]?.totalShareStatistics;
    return {
      impressions: stats?.impressionCount ?? 0,
      likes: stats?.likeCount ?? 0,
      comments: stats?.commentCount ?? 0,
      shares: stats?.shareCount ?? 0,
    };
  } catch (err) {
    console.error(`[engagement] LinkedIn fetch error for post #${post.id}:`, err instanceof Error ? err.message : err);
    return ZERO_STATS;
  }
}

/**
 * Fetches engagement stats from the X (Twitter) API v2.
 * Uses the public_metrics fields on the tweet lookup endpoint.
 */
async function fetchXEngagement(post: ComposerPost): Promise<EngagementStats> {
  try {
    if (!X_BEARER_TOKEN) {
      console.warn('[engagement] X_BEARER_TOKEN not set — skipping');
      return ZERO_STATS;
    }

    const res = await fetch(
      `https://api.twitter.com/2/tweets/${post.platform_post_id}?tweet.fields=public_metrics`,
      { headers: { Authorization: `Bearer ${X_BEARER_TOKEN}` } },
    );

    if (!res.ok) {
      const body = await res.text();
      console.error(`[engagement] X API ${res.status} for post #${post.id}: ${body}`);
      return ZERO_STATS;
    }

    const data = await res.json() as {
      data?: {
        public_metrics?: {
          impression_count?: number;
          like_count?: number;
          reply_count?: number;
          retweet_count?: number;
        };
      };
    };

    const m = data.data?.public_metrics;
    console.log(`[engagement] X post #${post.id} metrics:`, JSON.stringify(m || 'no public_metrics'));
    return {
      impressions: m?.impression_count ?? 0,
      likes: m?.like_count ?? 0,
      comments: m?.reply_count ?? 0,
      shares: m?.retweet_count ?? 0,
    };
  } catch (err) {
    console.error(`[engagement] X fetch error for post #${post.id}:`, err instanceof Error ? err.message : err);
    return ZERO_STATS;
  }
}

/**
 * Refreshes engagement stats for all published posts from the last 7 days.
 *
 * Queries posts with a platform_post_id, calls the appropriate API based on
 * account, and writes the results back to the posts table.
 */
export async function refreshEngagement(): Promise<void> {
  const { data: posts, error } = await supabase
    .from('posts')
    .select('*')
    .eq('status', 'published')
    .not('platform_post_id', 'is', null)
    .gte('published_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
    .order('published_at', { ascending: false });

  if (error) {
    console.error('[engagement] Query error:', error.message);
    return;
  }

  if (!posts || posts.length === 0) {
    console.log('[engagement] No published posts in the last 7 days to refresh.');
    return;
  }

  console.log(`[engagement] Refreshing stats for ${posts.length} post(s)...`);

  let successCount = 0;

  for (const post of posts as ComposerPost[]) {
    let stats: EngagementStats;

    if (post.account === 'prefactor_x') {
      stats = await fetchXEngagement(post);
    } else {
      stats = await fetchLinkedInEngagement(post);
    }

    const { error: updateError } = await supabase
      .from('posts')
      .update({
        impressions: stats.impressions,
        likes: stats.likes,
        comments: stats.comments,
        shares: stats.shares,
        engagement_fetched_at: new Date().toISOString(),
      })
      .eq('id', post.id);

    if (updateError) {
      console.error(`[engagement] Failed to update post #${post.id}:`, updateError.message);
    } else {
      successCount++;
    }
  }

  console.log(`[engagement] Done. Updated ${successCount}/${posts.length} posts.`);
}
