import { supabase } from '../db/supabase.js';
import { extractWithHaiku } from './shared/haiku.js';
import { withRunLog } from './shared/runLogger.js';
import { getSydneyDate } from '../utils/sydneyDate.js';
import { buildTopicKey } from '../utils/topicKey.js';

const HN_ALGOLIA_URL = 'https://hn.algolia.com/api/v1';

interface HNHit {
  title: string | null;
  url: string | null;
  story_text: string | null;
  objectID: string;
  points: number | null;
  num_comments: number | null;
}

async function searchHN(keyword: string, limit: number): Promise<HNHit[]> {
  const params = new URLSearchParams({
    query: keyword,
    tags: 'story',
    hitsPerPage: String(limit),
    numericFilters: 'created_at_i>' + String(Math.floor(Date.now() / 1000) - 86400 * 7),
  });

  const res = await fetch(`${HN_ALGOLIA_URL}/search?${params}`);
  if (!res.ok) throw new Error(`HN Algolia API error: ${res.status}`);

  const data = (await res.json()) as { hits: HNHit[] };
  return data.hits;
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
      const hits = await searchHN(kw, limit);
      for (const hit of hits) {
        if (seenIds.has(hit.objectID)) continue;
        seenIds.add(hit.objectID);
        posts.push({
          title: hit.title || '(untitled)',
          url: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
          body: hit.story_text?.slice(0, 500) || undefined,
          score: hit.points ?? 0,
        });
      }
    } catch (err) {
      console.warn(`[hn-collector] Failed to fetch "${kw}" (${label}):`, err);
    }
  }

  return posts;
}

export async function hnCollector(isMonday = false) {
  return withRunLog('hn-collector', async () => {
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
      console.log('[hn-collector] No active keywords. Skipping.');
      return { postsFetched: 0, llmTokens: 0 };
    }

    // Monday covers Fri+Sat+Sun — fetch 3x the normal per-keyword limit
    const baseLimit = config?.posts_per_keyword ?? 20;
    const limit = isMonday ? baseLimit * 3 : baseLimit;
    const ecosystemKws = keywords.filter((k) => k.category === 'ecosystem').map((k) => k.keyword);
    const enterpriseKws = keywords.filter((k) => k.category === 'enterprise').map((k) => k.keyword);

    console.log(`[hn-collector] Fetching: ${ecosystemKws.length} ecosystem, ${enterpriseKws.length} enterprise keywords${isMonday ? ' (Monday 3x limit)' : ''}...`);

    const [ecosystemPosts, enterprisePosts] = await Promise.all([
      fetchPostsForKeywords(ecosystemKws, limit, 'ecosystem'),
      fetchPostsForKeywords(enterpriseKws, limit, 'enterprise'),
    ]);

    console.log(`[hn-collector] Fetched ${ecosystemPosts.length} ecosystem + ${enterprisePosts.length} enterprise posts. Sending to Haiku...`);

    const today = getSydneyDate();
    let totalTokens = 0;
    let totalPosts = 0;

    for (const [posts, kws, category] of [
      [ecosystemPosts, ecosystemKws, 'ecosystem'],
      [enterprisePosts, enterpriseKws, 'enterprise'],
    ] as const) {
      if (posts.length === 0) continue;

      const result = await extractWithHaiku('hackernews', posts, kws, category);
      totalTokens += result.llmTokens;
      totalPosts += posts.length;

      if (result.keyword_signals.length > 0) {
        const signalRows = result.keyword_signals.map((s) => ({
          date: today,
          platform: 'hackernews',
          keyword: s.keyword,
          post_count: s.post_count,
          sentiment: s.sentiment,
          momentum: 'flat',
          category,
        }));
        const { error } = await supabase
          .from('keyword_signals')
          .upsert(signalRows, { onConflict: 'date,platform,keyword' });
        if (error) console.error(`[hn-collector] Signal write error (${category}):`, error.message);
      }

      if (result.emerging_topics.length > 0) {
        const topicRows = result.emerging_topics.map((t) => ({
          date: today,
          platform: 'hackernews',
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
            console.error(`[hn-collector] Topic write error (${category}):`, error.message);
          } else {
            const fallbackRows = topicRows.map(({ topic_key: _topicKey, ...row }) => row);
            const { error: fallbackError } = await supabase
              .from('emerging_topics')
              .upsert(fallbackRows, { onConflict: 'date,platform,category,topic_title' });
            if (fallbackError) {
              console.error(`[hn-collector] Topic fallback write error (${category}):`, fallbackError.message);
            }
          }
        }
      }

      console.log(`[hn-collector] ${category}: ${result.keyword_signals.length} signals, ${result.emerging_topics.length} topics.`);
    }

    return { postsFetched: totalPosts, llmTokens: totalTokens };
  });
}
