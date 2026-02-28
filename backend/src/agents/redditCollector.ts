import { supabase } from '../db/supabase.js';
import { extractWithHaiku } from './shared/haiku.js';
import { withRunLog } from './shared/runLogger.js';
import { getSydneyDate } from '../utils/sydneyDate.js';
import { buildTopicKey } from '../utils/topicKey.js';

interface RedditPost {
  title: string;
  selftext: string;
  url: string;
  permalink: string;
  score: number;
  num_comments: number;
}

interface RedditListing {
  data: {
    children: { data: RedditPost }[];
  };
}

async function searchReddit(keyword: string, limit: number): Promise<RedditPost[]> {
  const userAgent = process.env.REDDIT_USER_AGENT || 'Pulse/0.1 by Prefactor-Founder';
  const params = new URLSearchParams({
    q: keyword,
    sort: 'relevance',
    t: 'week',
    limit: String(Math.min(limit, 100)),
    type: 'link',
  });

  const res = await fetch(`https://www.reddit.com/search.json?${params}`, {
    headers: { 'User-Agent': userAgent },
  });

  if (!res.ok) throw new Error(`Reddit search failed: ${res.status}`);

  const listing = (await res.json()) as RedditListing;
  return listing.data.children.map((c) => c.data);
}

async function fetchPostsForKeywords(
  keywords: string[],
  limit: number,
  label: string,
): Promise<{ title: string; url: string; body?: string; score?: number }[]> {
  const posts: { title: string; url: string; body?: string; score?: number }[] = [];
  const seenPermalinks = new Set<string>();

  for (const kw of keywords) {
    try {
      const results = await searchReddit(kw, limit);
      for (const post of results) {
        if (seenPermalinks.has(post.permalink)) continue;
        seenPermalinks.add(post.permalink);
        posts.push({
          title: post.title,
          url: `https://reddit.com${post.permalink}`,
          body: post.selftext?.slice(0, 500) || undefined,
          score: post.score,
        });
      }
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      console.warn(`[reddit-collector] Failed to fetch "${kw}" (${label}):`, err);
    }
  }

  return posts;
}

export async function redditCollector(isMonday = false) {
  return withRunLog('reddit-collector', async () => {
    const { data: config } = await supabase
      .from('config')
      .select('posts_per_keyword')
      .eq('id', 1)
      .single();

    const { data: keywords } = await supabase
      .from('keywords')
      .select('keyword, category')
      .eq('active', true);

    if (!keywords || keywords.length === 0) {
      console.log('[reddit-collector] No active keywords. Skipping.');
      return { postsFetched: 0, llmTokens: 0 };
    }

    // Monday covers Fri+Sat+Sun — fetch 3x the normal per-keyword limit
    const baseLimit = config?.posts_per_keyword ?? 20;
    const limit = isMonday ? baseLimit * 3 : baseLimit;
    const ecosystemKws = keywords.filter((k) => k.category === 'ecosystem').map((k) => k.keyword);
    const enterpriseKws = keywords.filter((k) => k.category === 'enterprise').map((k) => k.keyword);

    console.log(`[reddit-collector] Fetching: ${ecosystemKws.length} ecosystem, ${enterpriseKws.length} enterprise keywords${isMonday ? ' (Monday 3x limit)' : ''}...`);

    // Reddit rate limits mean we run sequentially, not in parallel
    const ecosystemPosts = await fetchPostsForKeywords(ecosystemKws, limit, 'ecosystem');
    const enterprisePosts = await fetchPostsForKeywords(enterpriseKws, limit, 'enterprise');

    console.log(`[reddit-collector] Fetched ${ecosystemPosts.length} ecosystem + ${enterprisePosts.length} enterprise posts. Sending to Haiku...`);

    const today = getSydneyDate();
    let totalTokens = 0;
    let totalPosts = 0;

    for (const [posts, kws, category] of [
      [ecosystemPosts, ecosystemKws, 'ecosystem'],
      [enterprisePosts, enterpriseKws, 'enterprise'],
    ] as const) {
      if (posts.length === 0) continue;

      const result = await extractWithHaiku('reddit', posts, kws, category);
      totalTokens += result.llmTokens;
      totalPosts += posts.length;

      if (result.keyword_signals.length > 0) {
        const signalRows = result.keyword_signals.map((s) => ({
          date: today,
          platform: 'reddit',
          keyword: s.keyword,
          post_count: s.post_count,
          sentiment: s.sentiment,
          momentum: 'flat',
          category,
        }));
        const { error } = await supabase
          .from('keyword_signals')
          .upsert(signalRows, { onConflict: 'date,platform,keyword' });
        if (error) console.error(`[reddit-collector] Signal write error (${category}):`, error.message);
      }

      if (result.emerging_topics.length > 0) {
        const topicRows = result.emerging_topics.map((t) => ({
          date: today,
          platform: 'reddit',
          keyword: t.keyword,
          topic_key: buildTopicKey(category, t.keyword, t.topic_title),
          topic_title: t.topic_title,
          summary: t.summary,
          post_count: t.post_count,
          sample_urls: t.sample_urls,
          category,
        }));
        const { error } = await supabase
          .from('emerging_topics')
          .upsert(topicRows, { onConflict: 'date,platform,category,topic_key' });
        if (error) {
          const shouldFallback =
            error.message.includes('topic_key') ||
            error.message.includes('uq_emerging_topics_daily_topic');

          if (!shouldFallback) {
            console.error(`[reddit-collector] Topic write error (${category}):`, error.message);
          } else {
            const fallbackRows = topicRows.map(({ topic_key: _topicKey, ...row }) => row);
            const { error: fallbackError } = await supabase
              .from('emerging_topics')
              .upsert(fallbackRows, { onConflict: 'date,platform,category,topic_title' });
            if (fallbackError) {
              console.error(`[reddit-collector] Topic fallback write error (${category}):`, fallbackError.message);
            }
          }
        }
      }

      console.log(`[reddit-collector] ${category}: ${result.keyword_signals.length} signals, ${result.emerging_topics.length} topics.`);
    }

    return { postsFetched: totalPosts, llmTokens: totalTokens };
  });
}
