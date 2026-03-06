import { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { draftPost, reviseDraft, autoDraftDailyPosts } from '../composer/drafting.js';
import { publishPost } from '../composer/index.js';
import { getDailyCount } from '../composer/counter.js';
import { validatePost } from '../composer/ordering.js';
import { generateEmbedding } from '../scheduler/embeddings.js';
import { handleSlackAction, handleSlackViewSubmission, verifySlackSignature } from '../composer/slack.js';
import { ACCOUNTS, ACCOUNT_SLUGS, getPlatformForAccount } from '../composer/accounts.js';
import { getSydneyDate, getSydneyDayBounds } from '../utils/sydneyDate.js';
import type { ComposerPost, AccountSlug, Platform } from '../composer/types.js';
import type { SlackActionPayload, SlackViewSubmissionPayload } from '../composer/slack.js';

const router = Router();

// ─── POST /api/composer/draft ───────────────────────────────────────────────
// Create a new post draft. Accepts multi-account fields.
router.post('/api/composer/draft', async (req, res) => {
  const {
    account, content, category, scheduled_at,
    is_reshare, is_podcast, guest_name, episode_number,
    // Legacy fields for backward compatibility
    topicId, topicTitle, topicSummary, keywords, sourceLinks, platform, angle,
  } = req.body;

  // If this is an AI-generated draft request (has topicTitle), route to draftPost
  if (topicTitle) {
    const resolvedAccount: AccountSlug = account || 'prefactor_x';
    if (!ACCOUNT_SLUGS.includes(resolvedAccount)) {
      res.status(400).json({ error: `account must be one of: ${ACCOUNT_SLUGS.join(', ')}` });
      return;
    }

    const post = await draftPost({
      topicId: topicId || '',
      topicTitle,
      topicSummary: topicSummary || '',
      keywords: keywords || [],
      sourceLinks: sourceLinks || [],
      platform: getPlatformForAccount(resolvedAccount),
      account: resolvedAccount,
      angle,
      category,
      guestName: guest_name,
      episodeNumber: episode_number,
    }, scheduled_at);

    if (!post) {
      res.status(500).json({ error: 'Failed to generate draft. Check API key configuration.' });
      return;
    }

    res.status(201).json(post);
    return;
  }

  // Manual draft creation (content provided directly)
  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    res.status(400).json({ error: 'content is required.' });
    return;
  }

  const resolvedAccount: AccountSlug = account || 'prefactor_linkedin';
  if (!ACCOUNT_SLUGS.includes(resolvedAccount)) {
    res.status(400).json({ error: `account must be one of: ${ACCOUNT_SLUGS.join(', ')}` });
    return;
  }

  const resolvedPlatform = getPlatformForAccount(resolvedAccount);

  const { data, error } = await supabase
    .from('posts')
    .insert({
      account: resolvedAccount,
      platform: resolvedPlatform,
      content: content.trim(),
      status: 'draft',
      category: category || null,
      is_reshare: is_reshare || false,
      is_podcast: is_podcast || false,
      guest_name: guest_name || null,
      episode_number: episode_number || null,
      scheduled_at: scheduled_at || null,
    })
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.status(201).json(data);
});

// ─── POST /api/composer/draft/ai ────────────────────────────────────────────
// AI-assisted draft. Returns generated content without saving — caller saves if happy.
router.post('/api/composer/draft/ai', async (req, res) => {
  const {
    account, topic_title, summary, keywords, scheduled_at,
    category, guest_name, episode_number,
  } = req.body;

  const resolvedAccount: AccountSlug = account || 'prefactor_linkedin';
  if (!ACCOUNT_SLUGS.includes(resolvedAccount)) {
    res.status(400).json({ error: `account must be one of: ${ACCOUNT_SLUGS.join(', ')}` });
    return;
  }

  if (!topic_title || typeof topic_title !== 'string') {
    res.status(400).json({ error: 'topic_title is required.' });
    return;
  }

  const post = await draftPost({
    topicId: '',
    topicTitle: topic_title,
    topicSummary: summary || '',
    keywords: keywords || [],
    sourceLinks: [],
    platform: getPlatformForAccount(resolvedAccount),
    account: resolvedAccount,
    category,
    guestName: guest_name,
    episodeNumber: episode_number,
  }, scheduled_at);

  if (!post) {
    res.status(500).json({ error: 'Failed to generate AI draft. Check API key configuration.' });
    return;
  }

  res.status(201).json(post);
});

// ─── GET /api/composer/queue ────────────────────────────────────────────────
// Returns posts in the review queue, ordered by scheduled_at.
router.get('/api/composer/queue', async (req, res) => {
  const accountFilter = req.query.account as string | undefined;

  let query = supabase
    .from('posts')
    .select('*')
    .in('status', ['draft', 'pending_approval', 'approved'])
    .order('scheduled_at', { ascending: true });

  if (accountFilter && ACCOUNT_SLUGS.includes(accountFilter as AccountSlug)) {
    query = query.eq('account', accountFilter);
  }

  const { data, error } = await query;

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

// ─── GET /api/composer/accounts ─────────────────────────────────────────────
// Returns all account configurations for the frontend.
router.get('/api/composer/accounts', (_req, res) => {
  res.json(ACCOUNTS);
});

// ─── GET /api/composer/history ─────────────────────────────────────────────
// Returns published/failed/rejected posts. Filterable by account and limit.
router.get('/api/composer/history', async (req, res) => {
  const accountFilter = req.query.account as string | undefined;
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);

  let query = supabase
    .from('posts')
    .select('*')
    .in('status', ['published', 'failed', 'rejected'])
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (accountFilter && ACCOUNT_SLUGS.includes(accountFilter as AccountSlug)) {
    query = query.eq('account', accountFilter);
  }

  const { data, error } = await query;

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(data);
});

// ─── GET /api/composer/mix ─────────────────────────────────────────────────
// Returns category mix counts for a given account and ISO week.
const ALL_CATEGORIES = [
  'ecosystem', 'governance', 'security', 'enterprise_ai',
  'podcast_events', 'founder', 'direct_value', 'product',
] as const;

router.get('/api/composer/mix', async (req, res) => {
  const account = (req.query.account as string) || '';
  if (!account || !ACCOUNT_SLUGS.includes(account as AccountSlug)) {
    res.status(400).json({ error: `account must be one of: ${ACCOUNT_SLUGS.join(', ')}` });
    return;
  }

  // Parse ISO week (e.g. "2026-W10") or default to current week
  let weekStr = req.query.week as string | undefined;
  let monday: Date;

  if (weekStr && /^\d{4}-W\d{2}$/.test(weekStr)) {
    monday = isoWeekToMonday(weekStr);
  } else {
    // Default to current AEST week
    const now = new Date();
    const todayStr = getSydneyDate(now);
    const todayDate = new Date(todayStr + 'T00:00:00Z');
    // JS getDay: 0=Sun. Shift to Mon-based: Mon=0..Sun=6
    const dayOfWeek = todayDate.getUTCDay();
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    monday = new Date(todayDate.getTime() + mondayOffset * 86400000);
    weekStr = toIsoWeek(monday);
  }

  // Monday 00:00 → Sunday 23:59:59 in AEST (use day bounds for accuracy)
  const mondayStr = monday.toISOString().slice(0, 10);
  const sundayDate = new Date(monday.getTime() + 6 * 86400000);
  const sundayStr = sundayDate.toISOString().slice(0, 10);

  const { startIso } = getSydneyDayBounds(mondayStr);
  // End = start of the day AFTER Sunday (exclusive upper bound)
  const mondayAfter = new Date(monday.getTime() + 7 * 86400000);
  const mondayAfterStr = mondayAfter.toISOString().slice(0, 10);
  const { startIso: endIso } = getSydneyDayBounds(mondayAfterStr);

  const { data, error } = await supabase
    .from('posts')
    .select('category')
    .eq('account', account)
    .gte('scheduled_at', startIso)
    .lt('scheduled_at', endIso)
    .not('status', 'in', '("rejected","failed")');

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Build counts — all categories present, defaulting to 0
  const mix: Record<string, number> = {};
  for (const cat of ALL_CATEGORIES) {
    mix[cat] = 0;
  }
  for (const row of data || []) {
    if (row.category && row.category in mix) {
      mix[row.category]++;
    }
  }

  res.json({
    account,
    week: weekStr,
    mix,
    threshold: 2,
  });
});

/** Convert "2026-W10" to the Monday Date of that ISO week. */
function isoWeekToMonday(isoWeek: string): Date {
  const [yearStr, weekPart] = isoWeek.split('-W');
  const year = Number(yearStr);
  const week = Number(weekPart);
  // Jan 4 is always in ISO week 1
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7; // Convert Sunday=0 to 7
  const week1Monday = new Date(jan4.getTime() - (jan4Day - 1) * 86400000);
  return new Date(week1Monday.getTime() + (week - 1) * 7 * 86400000);
}

/** Convert a Monday Date to "YYYY-Www" ISO week string. */
function toIsoWeek(monday: Date): string {
  // Thursday of the same week determines the year
  const thursday = new Date(monday.getTime() + 3 * 86400000);
  const year = thursday.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const week1Monday = new Date(jan4.getTime() - (jan4Day - 1) * 86400000);
  const weekNum = Math.round((monday.getTime() - week1Monday.getTime()) / (7 * 86400000)) + 1;
  return `${year}-W${String(weekNum).padStart(2, '0')}`;
}

// ─── POST /api/composer/check-duplicate ────────────────────────────────────
// Checks if content is semantically similar to existing published posts.
router.post('/api/composer/check-duplicate', async (req, res) => {
  const { content, account, excludePostId } = req.body;

  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    res.status(400).json({ error: 'content is required.' });
    return;
  }
  if (!account || !ACCOUNT_SLUGS.includes(account as AccountSlug)) {
    res.status(400).json({ error: `account must be one of: ${ACCOUNT_SLUGS.join(', ')}` });
    return;
  }

  let embedding: number[];
  try {
    embedding = await generateEmbedding(content.trim());
  } catch (err) {
    console.error('[check-duplicate] Embedding generation failed:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Failed to generate embedding.' });
    return;
  }

  // Call the Postgres function for vector similarity search
  const { data, error } = await supabase.rpc('match_posts', {
    query_embedding: JSON.stringify(embedding),
    match_account: account,
    match_limit: 3,
    exclude_id: excludePostId ? Number(excludePostId) : -1,
  });

  if (error) {
    console.error('[check-duplicate] Similarity search failed:', error.message);
    res.status(500).json({ error: 'Similarity search failed.' });
    return;
  }

  const matches = (data || [])
    .filter((r: { similarity: number }) => r.similarity >= 0.70)
    .map((r: { id: number; content: string; published_at: string; similarity: number }) => ({
      id: String(r.id),
      content: r.content,
      published_at: r.published_at,
      similarity: Math.round(r.similarity * 1000) / 1000,
    }));

  res.json({
    hasDuplicate: matches.some((m: { similarity: number }) => m.similarity >= 0.85),
    matches,
  });
});

// ─── PATCH /api/composer/:id/submit ─────────────────────────────────────────
// Moves a draft to 'pending_approval'. Runs ordering guards before allowing.
router.patch('/api/composer/:id/submit', async (req, res) => {
  const { id } = req.params;

  // 1. Load the post
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

  // 2. Load existing posts for the same account/day for ordering guards
  const existingPosts = await getPostsForAccountDay(post.account, post.scheduled_at);

  // 3. Run ordering guards
  const validation = validatePost(
    { account: post.account, scheduled_at: post.scheduled_at, is_reshare: post.is_reshare, is_podcast: post.is_podcast },
    existingPosts,
  );

  if (!validation.valid) {
    res.status(422).json({ error: validation.error });
    return;
  }

  // 4. Update status
  const { data, error } = await supabase
    .from('posts')
    .update({ status: 'pending_approval', updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(data);
});

// ─── PATCH /api/composer/:id/approve ────────────────────────────────────────
// Approves a post — only allowed from 'pending_approval'.
router.patch('/api/composer/:id/approve', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('posts')
    .update({
      status: 'approved',
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'pending_approval')
    .select()
    .single();

  if (error) {
    res.status(404).json({ error: 'Post not found or not in pending_approval status.' });
    return;
  }

  res.json(data);
});

// ─── PATCH /api/composer/:id/publish ─────────────────────────────────────────
// Immediately publishes an approved post through its platform adapter.
router.patch('/api/composer/:id/publish', async (req, res) => {
  const { id } = req.params;

  const { data: post, error: loadErr } = await supabase
    .from('posts')
    .select('*')
    .eq('id', id)
    .eq('status', 'approved')
    .single();

  if (loadErr || !post) {
    res.status(404).json({ error: 'Post not found or not in approved status.' });
    return;
  }

  await publishPost(post as ComposerPost);

  const { data: updated, error: fetchErr } = await supabase
    .from('posts')
    .select('*')
    .eq('id', id)
    .single();

  if (fetchErr || !updated) {
    res.status(500).json({ error: 'Published but failed to fetch updated post.' });
    return;
  }

  res.json(updated);
});

// ─── PATCH /api/composer/:id/reject ─────────────────────────────────────────
// Rejects a post. Records rejected_at.
router.patch('/api/composer/:id/reject', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('posts')
    .update({
      status: 'rejected',
      rejected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .in('status', ['draft', 'pending_approval', 'approved'])
    .select()
    .single();

  if (error) {
    res.status(404).json({ error: 'Post not found or not in a rejectable status.' });
    return;
  }

  res.json(data);
});

// ─── PATCH /api/composer/:id/retry ───────────────────────────────────────────
// Moves a failed post back to 'draft' so it can be edited and re-published.
router.patch('/api/composer/:id/retry', async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('posts')
    .update({
      status: 'draft',
      published_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('status', 'failed')
    .select()
    .single();

  if (error) {
    res.status(404).json({ error: 'Post not found or not in failed status.' });
    return;
  }

  res.json(data);
});

// ─── PATCH /api/composer/:id/revise ──────────────────────────────────────────
// Revises a draft with founder feedback. Original is rejected, new draft created.
router.patch('/api/composer/:id/revise', async (req, res) => {
  const { id } = req.params;
  const { feedback } = req.body;

  if (!feedback || typeof feedback !== 'string' || feedback.trim().length === 0) {
    res.status(400).json({ error: 'feedback is required and must be a non-empty string.' });
    return;
  }

  const { data: post, error: loadErr } = await supabase
    .from('posts')
    .select('*')
    .eq('id', id)
    .in('status', ['draft', 'pending_approval'])
    .single();

  if (loadErr || !post) {
    res.status(404).json({ error: 'Post not found or not in draft/pending_approval status.' });
    return;
  }

  const today = getSydneyDate();
  const { data: topicData } = await supabase
    .from('emerging_topics')
    .select('topic_title, summary, keyword, sample_urls')
    .eq('date', today)
    .eq('topic_title', post.source_topic)
    .single();

  const revision = await reviseDraft(
    post.content,
    {
      topicId: '',
      topicTitle: post.source_topic || '',
      topicSummary: topicData?.summary || '',
      keywords: [topicData?.keyword || post.source_keyword || ''],
      sourceLinks: topicData?.sample_urls || [],
      platform: post.platform as Platform,
      account: post.account as AccountSlug,
      category: post.category,
    },
    feedback.trim(),
    post.scheduled_at,
  );

  if (!revision) {
    res.status(500).json({ error: 'Failed to generate revision. Check API key configuration.' });
    return;
  }

  await supabase
    .from('posts')
    .update({ status: 'rejected', rejected_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id);

  res.json({
    rejected: { id: post.id, source_topic: post.source_topic },
    revision,
  });
});

// ─── PATCH /api/composer/:id/edit ───────────────────────────────────────────
// Updates post content and/or schedule. Re-runs ordering guards.
router.patch('/api/composer/:id/edit', async (req, res) => {
  const { id } = req.params;
  const { content, scheduled_at, category, is_podcast, is_reshare, guest_name, episode_number } = req.body;

  // Load the post
  const { data: post, error: loadErr } = await supabase
    .from('posts')
    .select('*')
    .eq('id', id)
    .in('status', ['draft', 'pending_approval', 'approved'])
    .single();

  if (loadErr || !post) {
    res.status(404).json({ error: 'Post not found or not editable.' });
    return;
  }

  // Build the update payload (only set fields that were provided)
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (content !== undefined) updates.content = content.trim();
  if (scheduled_at !== undefined) updates.scheduled_at = scheduled_at;
  if (category !== undefined) updates.category = category;
  if (is_podcast !== undefined) updates.is_podcast = is_podcast;
  if (is_reshare !== undefined) updates.is_reshare = is_reshare;
  if (guest_name !== undefined) updates.guest_name = guest_name;
  if (episode_number !== undefined) updates.episode_number = episode_number;

  // Merge with existing post for validation
  const merged = {
    account: post.account as AccountSlug,
    scheduled_at: (updates.scheduled_at ?? post.scheduled_at) as string | null,
    is_reshare: (updates.is_reshare ?? post.is_reshare) as boolean,
    is_podcast: (updates.is_podcast ?? post.is_podcast) as boolean,
  };

  // Re-run ordering guards with merged values
  const existingPosts = await getPostsForAccountDay(merged.account, merged.scheduled_at);
  const validation = validatePost(merged, existingPosts);

  if (!validation.valid) {
    res.status(422).json({ error: validation.error });
    return;
  }

  const { data, error } = await supabase
    .from('posts')
    .update(updates)
    .eq('id', id)
    .select()
    .single();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(data);
});

// ─── DELETE /api/composer/:id ────────────────────────────────────────────────
router.delete('/api/composer/:id', async (req, res) => {
  const { id } = req.params;

  const { error } = await supabase
    .from('posts')
    .delete()
    .eq('id', id);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json({ deleted: true, id: Number(id) });
});

// ─── Helper: Load posts for the same account on the same day ────────────────
async function getPostsForAccountDay(
  account: string,
  scheduledAt: string | null,
): Promise<Array<{ is_reshare: boolean }>> {
  if (!scheduledAt) return [];

  const date = getSydneyDate(new Date(scheduledAt));
  const { startIso, endIso } = getSydneyDayBounds(date);

  const { data } = await supabase
    .from('posts')
    .select('is_reshare')
    .eq('account', account)
    .gte('scheduled_at', startIso)
    .lt('scheduled_at', endIso)
    .not('status', 'in', '("rejected","failed")');

  return data || [];
}

// ─── POST /api/composer/slack/action ─────────────────────────────────────────
// Slack interactivity webhook. Receives button payloads from the daily digest.
router.post('/api/composer/slack/action', async (req, res) => {
  // Slack sends the payload as a URL-encoded "payload" field
  const rawPayload = req.body?.payload;
  if (!rawPayload) {
    res.status(400).json({ error: 'Missing payload.' });
    return;
  }

  // Verify signature if SLACK_SIGNING_SECRET is configured
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (signingSecret) {
    const signature = req.headers['x-slack-signature'] as string;
    const timestamp = req.headers['x-slack-request-timestamp'] as string;

    if (!signature || !timestamp) {
      res.status(401).json({ error: 'Missing Slack signature headers.' });
      return;
    }

    const rawBody = (req as typeof req & { rawBody?: string }).rawBody
      || (typeof req.body === 'string' ? req.body : `payload=${encodeURIComponent(rawPayload)}`);
    const valid = verifySlackSignature(signingSecret, signature, timestamp, rawBody);
    if (!valid) {
      res.status(401).json({ error: 'Invalid Slack signature.' });
      return;
    }
  }

  try {
    const payload = JSON.parse(rawPayload);

    if (payload.type === 'view_submission') {
      await handleSlackViewSubmission(payload as SlackViewSubmissionPayload);
      // Slack expects an empty 200 to close the modal
      res.status(200).json({ response_action: 'clear' });
    } else {
      await handleSlackAction(payload as SlackActionPayload);
      // Slack expects a 200 OK within 3 seconds
      res.status(200).send();
    }
  } catch (err) {
    console.error('[slack/action] Error handling action:', err instanceof Error ? err.message : err);
    res.status(500).json({ error: 'Internal error processing Slack action.' });
  }
});

// ─── POST /api/composer/auto-draft ────────────────────────────────────────────
// Manual trigger for the daily auto-draft. Useful when the server missed the 6am cron.
router.post('/api/composer/auto-draft', async (_req, res) => {
  autoDraftDailyPosts().catch((err) =>
    console.error('[composer] Manual auto-draft error:', err instanceof Error ? err.message : err),
  );
  res.json({ ok: true, message: 'Auto-draft started for all accounts.' });
});

export default router;
