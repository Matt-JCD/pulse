import { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { hnCollector } from '../agents/hnCollector.js';
import { redditCollector } from '../agents/redditCollector.js';
import { twitterCollector } from '../agents/twitterCollector.js';
import { synthesizer } from '../agents/synthesizer.js';
import { getSydneyDate, getSydneyDateOffset } from '../utils/sydneyDate.js';
import { buildTopicKey } from '../utils/topicKey.js';

const router = Router();
const VALID_PLATFORMS = new Set(['hackernews', 'reddit', 'twitter', 'synthesizer']);

interface TopicRow {
  id: number;
  date: string;
  platform: string;
  keyword: string;
  topic_key: string | null;
  topic_title: string;
  summary: string;
  post_count: number;
  sample_urls: string[] | null;
  category: string;
  created_at: string;
}

function topicKey(topic: Pick<TopicRow, 'category' | 'keyword' | 'topic_title'>): string {
  return buildTopicKey(topic.category, topic.keyword, topic.topic_title);
}

// GET /api/intelligence/today — today's daily_report
router.get('/api/intelligence/today', async (_req, res) => {
  const today = getSydneyDate();

  const { data, error } = await supabase
    .from('daily_report')
    .select('*')
    .eq('date', today)
    .single();

  if (error && error.code !== 'PGRST116') {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(data || { date: today, status: 'no_report_yet' });
});

// GET /api/intelligence/report/:date — report for a specific date
router.get('/api/intelligence/report/:date', async (req, res) => {
  const { date } = req.params;

  const { data, error } = await supabase
    .from('daily_report')
    .select('*')
    .eq('date', date)
    .single();

  if (error) {
    res.status(404).json({ error: 'No report for this date' });
    return;
  }

  res.json(data);
});

// GET /api/intelligence/keywords — keyword_signals for date range
router.get('/api/intelligence/keywords', async (req, res) => {
  const days = parseInt(req.query.days as string) || 7;
  const since = getSydneyDateOffset(-days);

  const { data, error } = await supabase
    .from('keyword_signals')
    .select('*')
    .gte('date', since)
    .order('date', { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(data);
});

// GET /api/intelligence/topics — emerging_topics for date range
router.get('/api/intelligence/topics', async (req, res) => {
  const days = parseInt(req.query.days as string) || 7;
  const since = getSydneyDateOffset(-days);
  const today = getSydneyDate();
  const yesterday = getSydneyDateOffset(-1);
  const mode = (req.query.mode as string | undefined) || 'all';

  const { data, error } = await supabase
    .from('emerging_topics')
    .select('*')
    .gte('date', since)
    .order('date', { ascending: false });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  const topics = (data || []) as TopicRow[];
  if (mode !== 'active') {
    res.json(topics);
    return;
  }

  // Active mode: keep only topic keys seen today or yesterday,
  // plus top high-volume keys across the full window, and return
  // their rows for the full requested window so trends remain visible.
  const activeKeys = new Set<string>();
  const totalsByKey = new Map<string, number>();

  for (const topic of topics) {
    const key = topic.topic_key || topicKey(topic);
    totalsByKey.set(key, (totalsByKey.get(key) ?? 0) + topic.post_count);
    if (topic.date !== today && topic.date !== yesterday) continue;
    activeKeys.add(key);
  }

  const TOP_WINDOW_KEYS = 20;
  const topKeys = [...totalsByKey.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_WINDOW_KEYS)
    .map(([key]) => key);
  for (const key of topKeys) activeKeys.add(key);

  const filtered = topics.filter((topic) => activeKeys.has(topic.topic_key || topicKey(topic)));
  res.json(filtered);
});

// GET /api/intelligence/run-log — agent run history
router.get('/api/intelligence/run-log', async (_req, res) => {
  const { data, error } = await supabase
    .from('run_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(data);
});

// POST /api/intelligence/trigger-run — manually trigger collectors
router.post('/api/intelligence/trigger-run', async (req, res) => {
  const platform = req.body?.platform as string | undefined;
  if (platform && !VALID_PLATFORMS.has(platform)) {
    res.status(400).json({
      error: `Invalid platform "${platform}". Expected one of: hackernews, reddit, twitter, synthesizer.`,
    });
    return;
  }

  res.json({ status: 'started', platform: platform || 'all' });

  // Each collector runs in its own try/catch so one failure never blocks the rest.
  const tryRun = async (name: string, fn: () => Promise<unknown>) => {
    try {
      console.log(`[trigger] Starting ${name}...`);
      await fn();
    } catch (err) {
      console.error(`[trigger] ${name} failed:`, err instanceof Error ? err.message : err);
    }
  };

  if (!platform || platform === 'hackernews') await tryRun('hn-collector', hnCollector);
  if (!platform || platform === 'reddit')      await tryRun('reddit-collector', redditCollector);
  if (!platform || platform === 'twitter')     await tryRun('twitter-collector', twitterCollector);
  if (!platform || platform === 'synthesizer') await tryRun('synthesizer', synthesizer);
});

export default router;
