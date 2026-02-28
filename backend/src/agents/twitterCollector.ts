import { supabase } from '../db/supabase.js';
import { extractWithHaiku } from './shared/haiku.js';
import { withRunLog } from './shared/runLogger.js';
import { getSydneyDate } from '../utils/sydneyDate.js';
import { buildTopicKey } from '../utils/topicKey.js';

interface Tweet {
  id: string;
  text: string;
  full_text?: string;
  username: string;
  user_name: string;
  favorite_count: number;
  retweet_count: number;
  reply_count: number;
  view_count?: string;
  created_at: string;
  urls: { expanded_url?: string; url?: string }[];
}

interface SearchResponse {
  data: Tweet[];
  next_cursor?: string;
}

async function searchTwitter(keyword: string, limit: number): Promise<Tweet[]> {
  const apiKey = process.env.SCRAPEBADGER_API_KEY;
  if (!apiKey) throw new Error('Missing SCRAPEBADGER_API_KEY in .env');

  const since = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
  const query = `${keyword} since:${since} lang:en -is:retweet`;

  const params = new URLSearchParams({ query, query_type: 'Top' });

  const res = await fetch(
    `https://scrapebadger.com/v1/twitter/tweets/advanced_search?${params}`,
    { headers: { 'x-api-key': apiKey } },
  );

  if (!res.ok) throw new Error(`ScrapeBadger search failed: ${res.status} ${await res.text()}`);

  const body = (await res.json()) as SearchResponse;
  return (body.data || []).slice(0, limit);
}

async function fetchPostsForKeywords(
  keywords: string[],
  limit: number,
  label: string,
): Promise<{ title: string; url: string; body?: string; score?: number }[]> {
  const posts: { title: string; url: string; body?: string; score?: number }[] = [];
  const seenIds = new Set<string>();

  for (const kw of keywords) {
    try {
      const tweets = await searchTwitter(kw, limit);
      for (const tweet of tweets) {
        if (seenIds.has(tweet.id)) continue;
        seenIds.add(tweet.id);
        const text = tweet.full_text || tweet.text;
        const score = tweet.favorite_count + tweet.retweet_count * 2 + tweet.reply_count;
        posts.push({
          title: text.slice(0, 120),
          url: `https://twitter.com/${tweet.username}/status/${tweet.id}`,
          body: text.length > 120 ? text.slice(120, 500) : undefined,
          score,
        });
      }
      await new Promise((r) => setTimeout(r, 1000));
    } catch (err) {
      console.warn(`[twitter-collector] Failed to fetch "${kw}" (${label}):`, err);
    }
  }

  return posts;
}

export async function twitterCollector(isMonday = false) {
  return withRunLog('twitter-collector', async () => {
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
      console.log('[twitter-collector] No active keywords. Skipping.');
      return { postsFetched: 0, llmTokens: 0 };
    }

    // Monday covers Fri+Sat+Sun — fetch 3x the normal per-keyword limit
    const baseLimit = config?.posts_per_keyword ?? 20;
    const limit = isMonday ? baseLimit * 3 : baseLimit;
    const ecosystemKws = keywords.filter((k) => k.category === 'ecosystem').map((k) => k.keyword);
    const enterpriseKws = keywords.filter((k) => k.category === 'enterprise').map((k) => k.keyword);

    console.log(`[twitter-collector] Fetching: ${ecosystemKws.length} ecosystem, ${enterpriseKws.length} enterprise keywords${isMonday ? ' (Monday 3x limit)' : ''}...`);

    const [ecosystemPosts, enterprisePosts] = await Promise.all([
      fetchPostsForKeywords(ecosystemKws, limit, 'ecosystem'),
      fetchPostsForKeywords(enterpriseKws, limit, 'enterprise'),
    ]);

    console.log(`[twitter-collector] Fetched ${ecosystemPosts.length} ecosystem + ${enterprisePosts.length} enterprise posts. Sending to Haiku...`);

    const today = getSydneyDate();
    let totalTokens = 0;
    let totalPosts = 0;

    for (const [posts, kws, category] of [
      [ecosystemPosts, ecosystemKws, 'ecosystem'],
      [enterprisePosts, enterpriseKws, 'enterprise'],
    ] as const) {
      if (posts.length === 0) continue;

      const result = await extractWithHaiku('twitter', posts, kws, category);
      totalTokens += result.llmTokens;
      totalPosts += posts.length;

      if (result.keyword_signals.length > 0) {
        const signalRows = result.keyword_signals.map((s) => ({
          date: today,
          platform: 'twitter',
          keyword: s.keyword,
          post_count: s.post_count,
          sentiment: s.sentiment,
          momentum: 'flat',
          category,
        }));
        const { error } = await supabase
          .from('keyword_signals')
          .upsert(signalRows, { onConflict: 'date,platform,keyword' });
        if (error) console.error(`[twitter-collector] Signal write error (${category}):`, error.message);
      }

      if (result.emerging_topics.length > 0) {
        const topicRows = result.emerging_topics.map((t) => ({
          date: today,
          platform: 'twitter',
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
            console.error(`[twitter-collector] Topic write error (${category}):`, error.message);
          } else {
            const fallbackRows = topicRows.map(({ topic_key: _topicKey, ...row }) => row);
            const { error: fallbackError } = await supabase
              .from('emerging_topics')
              .upsert(fallbackRows, { onConflict: 'date,platform,category,topic_title' });
            if (fallbackError) {
              console.error(`[twitter-collector] Topic fallback write error (${category}):`, fallbackError.message);
            }
          }
        }
      }

      console.log(`[twitter-collector] ${category}: ${result.keyword_signals.length} signals, ${result.emerging_topics.length} topics.`);
    }

    return { postsFetched: totalPosts, llmTokens: totalTokens };
  });
}
