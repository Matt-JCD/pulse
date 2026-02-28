import { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { draftPost } from '../composer/drafting.js';
import { getDailyCount } from '../composer/counter.js';
import { getSydneyDate } from '../utils/sydneyDate.js';
import type { ComposerPost, Platform } from '../composer/types.js';

const router = Router();

const VALID_PLATFORMS = new Set<Platform>(['twitter', 'linkedin']);

// ─── POST /api/composer/draft ───────────────────────────────────────────────
// Manually trigger a draft for a specific topic and platform.
router.post('/api/composer/draft', async (req, res) => {
  const { topicId, topicTitle, topicSummary, keywords, sourceLinks, platform } = req.body;

  if (!platform || !VALID_PLATFORMS.has(platform)) {
    res.status(400).json({ error: `platform must be one of: ${[...VALID_PLATFORMS].join(', ')}` });
    return;
  }
  if (!topicTitle || typeof topicTitle !== 'string') {
    res.status(400).json({ error: 'topicTitle is required' });
    return;
  }

  const post = await draftPost({
    topicId: topicId || '',
    topicTitle,
    topicSummary: topicSummary || '',
    keywords: keywords || [],
    sourceLinks: sourceLinks || [],
    platform,
  });

  if (!post) {
    res.status(500).json({ error: 'Failed to generate draft. Check API key configuration.' });
    return;
  }

  res.status(201).json(post);
});

// ─── GET /api/composer/queue ────────────────────────────────────────────────
// Returns posts in the review queue (draft + scheduled), ordered by scheduled_at.
router.get('/api/composer/queue', async (req, res) => {
  const { data, error } = await supabase
    .from('posts')
    .select('*')
    .in('status', ['draft', 'scheduled'])
    .order('scheduled_at', { ascending: true });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(data);
});

// ─── GET /api/composer/stats ────────────────────────────────────────────────
// Returns today's publishing counts per platform.
router.get('/api/composer/stats', async (_req, res) => {
  const twitterCount = await getDailyCount('twitter');
  const linkedinCount = await getDailyCount('linkedin');

  res.json({
    date: getSydneyDate(),
    twitter: { count: twitterCount, limit: 16 },
    linkedin: { count: linkedinCount, limit: 50 },
  });
});

// ─── PATCH /api/composer/:id/approve ────────────────────────────────────────
// Approves a draft — sets status to 'scheduled'.
// The composer scheduler will publish it when scheduled_at arrives.
router.patch('/api/composer/:id/approve', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('posts')
    .update({ status: 'scheduled', updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'draft')
    .select()
    .single();

  if (error) {
    res.status(404).json({ error: 'Post not found or not in draft status.' });
    return;
  }

  res.json(data);
});

// ─── PATCH /api/composer/:id/reject ─────────────────────────────────────────
// Rejects a draft, then attempts to draft a replacement from the next best
// unused topic for the same time slot.
router.patch('/api/composer/:id/reject', async (req, res) => {
  const { id } = req.params;

  // 1. Load the post being rejected
  const { data: post, error: loadErr } = await supabase
    .from('posts')
    .select('*')
    .eq('id', id)
    .eq('status', 'draft')
    .single();

  if (loadErr || !post) {
    res.status(404).json({ error: 'Post not found or not in draft status.' });
    return;
  }

  // 2. Mark as rejected
  await supabase
    .from('posts')
    .update({ status: 'rejected', updated_at: new Date().toISOString() })
    .eq('id', id);

  // 3. Find the next best unused topic and draft a replacement
  const today = getSydneyDate();
  const { data: usedPosts } = await supabase
    .from('posts')
    .select('source_topic')
    .eq('platform', post.platform)
    .gte('created_at', `${today}T00:00:00Z`);

  const usedTopics = new Set((usedPosts || []).map((p: { source_topic: string }) => p.source_topic));

  const { data: topics } = await supabase
    .from('emerging_topics')
    .select('topic_title, summary, keyword, sample_urls, post_count')
    .eq('date', today)
    .order('post_count', { ascending: false });

  const nextTopic = (topics || []).find((t) => !usedTopics.has(t.topic_title));

  let replacement: ComposerPost | null = null;
  if (nextTopic && post.scheduled_at) {
    replacement = await draftPost(
      {
        topicId: '',
        topicTitle: nextTopic.topic_title,
        topicSummary: nextTopic.summary,
        keywords: [nextTopic.keyword],
        sourceLinks: nextTopic.sample_urls || [],
        platform: post.platform as Platform,
      },
      post.scheduled_at,
    );
  }

  res.json({
    rejected: { id: post.id, source_topic: post.source_topic },
    replacement: replacement || null,
  });
});

// ─── PATCH /api/composer/:id/edit ───────────────────────────────────────────
// Updates post content only. Status remains 'draft'.
router.patch('/api/composer/:id/edit', async (req, res) => {
  const { id } = req.params;
  const { content } = req.body;

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    res.status(400).json({ error: 'content is required and must be a non-empty string.' });
    return;
  }

  const { data, error } = await supabase
    .from('posts')
    .update({ content: content.trim(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'draft')
    .select()
    .single();

  if (error) {
    res.status(404).json({ error: 'Post not found or not in draft status.' });
    return;
  }

  res.json(data);
});

export default router;
