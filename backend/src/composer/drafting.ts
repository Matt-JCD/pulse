import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../db/supabase.js';
import { getSydneyDate, getSydneyDayBounds, sydneyLocalToUtcIso } from '../utils/sydneyDate.js';
import { withRunLog } from '../agents/shared/runLogger.js';
import { getAccountPrompt } from './prompts.js';
import { ACCOUNTS, getPlatformForAccount, ACCOUNT_SLUGS } from './accounts.js';
import type { DraftRequest, ComposerPost, Platform, AccountSlug } from './types.js';

// Daily posting slots in Sydney local time.
const SCHEDULED_SLOTS_SYDNEY = ['07:00', '09:00', '11:00', '13:00', '15:00'];

/**
 * Gets the configured model and API key from the config table.
 * Falls back to env var if no key stored in DB.
 */
async function getConfig() {
  const { data } = await supabase
    .from('config')
    .select('llm_model, anthropic_api_key')
    .eq('id', 1)
    .single();

  return {
    model: data?.llm_model || 'claude-haiku-4-5-20251001',
    apiKey: data?.anthropic_api_key || process.env.ANTHROPIC_API_KEY || '',
  };
}

// ─── Editorial Memory ─────────────────────────────────────────────────────────
// Loads past feedback from the founder so future drafts learn his voice.
// Each feedback entry is a triplet: original draft → feedback → revised draft.
// These get injected into the system prompt as few-shot examples.

async function loadEditorialMemory(account: AccountSlug, limit = 15): Promise<string> {
  // Try account-specific feedback first, fall back to platform-level for older entries
  const platform = getPlatformForAccount(account);
  const { data, error } = await supabase
    .from('composer_feedback')
    .select('original_content, feedback, revised_content, topic_title')
    .or(`account.eq.${account},and(account.is.null,platform.eq.${platform})`)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error || !data || data.length === 0) return '';

  const examples = data
    .map((entry, i) => {
      const parts = [`${i + 1}. Original: "${entry.original_content}"`];
      parts.push(`   Feedback: "${entry.feedback}"`);
      if (entry.revised_content) {
        parts.push(`   Revised: "${entry.revised_content}"`);
      }
      return parts.join('\n');
    })
    .join('\n\n');

  return `## Past Editorial Direction
These are corrections the founder has made on previous drafts.
Apply these patterns and preferences to ALL future posts.
The more recent entries (lower numbers) reflect the latest preferences.

${examples}`;
}

// ─── System Prompt ────────────────────────────────────────────────────────────
// Each account has its own voice prompt (defined in prompts.ts).
// Editorial memory is appended so every draft learns from past feedback.

function getSystemPrompt(account: AccountSlug, editorialMemory: string): string {
  const accountPrompt = getAccountPrompt(account);
  const memoryBlock = editorialMemory ? `\n\n${editorialMemory}` : '';
  return `${accountPrompt}${memoryBlock}`;
}

// ─── Topic Curation ───────────────────────────────────────────────────────────
// Instead of just picking the top N topics by post_count, we send ALL today's
// topics to Claude Sonnet in one call. It picks the 5 most relevant topics
// and provides a writing angle for each. The editorial memory is included so
// curation also learns what kind of topics the founder approves/corrects.

interface CuratedTopic {
  topic_title: string;
  angle: string;
  summary: string;
  keyword: string;
  sample_urls: string[];
}

export async function curateTopics(
  topics: Array<{
    topic_title: string;
    summary: string;
    keyword: string;
    sample_urls: string[] | null;
    post_count: number;
  }>,
  editorialMemory: string,
  apiKey: string,
): Promise<CuratedTopic[]> {
  const client = new Anthropic({ apiKey });

  const topicList = topics
    .map((t, i) => `${i + 1}. [${t.keyword}] "${t.topic_title}" (${t.post_count} posts)\n   ${t.summary}`)
    .join('\n');

  const memoryContext = editorialMemory
    ? `\n\nThe founder has given editorial feedback on past posts. Use this to understand what kinds of topics and angles he prefers:\n\n${editorialMemory}`
    : '';

  const systemPrompt = `You are Prefactor's editorial director. Prefactor builds governance and observability infrastructure for AI agent systems.

Your job: select the 5 best topics from today's intelligence feed for social media posts.

Selection criteria:
- 3-4 topics should connect to Prefactor's focus: governance, observability, quality management, compliance, or risk in enterprise agentic workflows. The connection can be indirect — e.g., a new model release matters because it changes what needs to be governed.
- 1-2 topics should be broader AI ecosystem news that an informed technical voice would comment on.
- Prefer topics with genuine news value or industry implications over routine announcements.
- Avoid topics that are too niche to interest a CTO/VP Engineering audience.
- Momentum matters: higher post_count suggests wider relevance.${memoryContext}

For each selected topic, provide a specific WRITING ANGLE — not just "write about this", but the specific take or perspective Prefactor should express. The angle should be slightly contrarian or offer an insight most people aren't saying.

Return valid JSON only. No markdown, no explanation. Format:
[
  {"topic_title": "exact title from the list", "angle": "specific writing angle"},
  ...
]`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: `Today's topics:\n\n${topicList}\n\nSelect 5 topics with writing angles.` }],
  });

  const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';
  if (!text) {
    console.error('[composer/curation] Empty response from Sonnet.');
    return [];
  }

  const totalTokens =
    (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);
  console.log(`[composer/curation] Curated topics (${totalTokens} tokens)`);

  try {
    const parsed = JSON.parse(text) as Array<{ topic_title: string; angle: string }>;

    // Match each curated pick back to the full topic data
    const topicMap = new Map(topics.map((t) => [t.topic_title, t]));
    const curated: CuratedTopic[] = [];

    for (const pick of parsed) {
      const full = topicMap.get(pick.topic_title);
      if (full) {
        curated.push({
          topic_title: full.topic_title,
          angle: pick.angle,
          summary: full.summary,
          keyword: full.keyword,
          sample_urls: full.sample_urls || [],
        });
      }
    }

    return curated.slice(0, 5);
  } catch (err) {
    console.error('[composer/curation] Failed to parse curation response:', err);
    return [];
  }
}

// ─── Draft Post ───────────────────────────────────────────────────────────────
// Generates a single draft post using Claude Haiku, saves to the posts table.
// The prompt now includes the writing angle and anti-restatement instructions.

export async function draftPost(request: DraftRequest, scheduledAt?: string): Promise<ComposerPost | null> {
  const config = await getConfig();
  if (!config.apiKey) {
    console.error('[composer/drafting] No Anthropic API key configured.');
    return null;
  }

  const client = new Anthropic({ apiKey: config.apiKey });
  const account = request.account;
  const platform = getPlatformForAccount(account);

  // Load editorial memory so every draft benefits from past feedback
  const editorialMemory = await loadEditorialMemory(account);

  const sourceLinksText = request.sourceLinks && request.sourceLinks.length > 0
    ? `Source links:\n${request.sourceLinks.join('\n')}`
    : 'No source links available.';

  const angleText = request.angle
    ? `Writing angle: ${request.angle}`
    : '';

  // Build user prompt — include topic context, guest info for podcast accounts
  const podcastContext = request.guestName
    ? `Guest name: ${request.guestName}\nEpisode number: ${request.episodeNumber || 'N/A'}\n`
    : '';

  const userPrompt = `Topic: ${request.topicTitle}
Summary: ${request.topicSummary}
Keywords: ${request.keywords.join(', ')}
Category: ${request.category || 'general'}
${podcastContext}${sourceLinksText}
${angleText}

Write exactly ONE post. Return only the post text, nothing else.`;

  const response = await client.messages.create({
    model: config.model,
    max_tokens: 512,
    system: getSystemPrompt(account, editorialMemory),
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';
  if (!text) {
    console.error('[composer/drafting] Empty response from Haiku.');
    return null;
  }

  const totalTokens =
    (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);
  console.log(`[composer/drafting] Generated ${account} draft (${totalTokens} tokens, ${text.length} chars)`);

  const { data, error } = await supabase
    .from('posts')
    .insert({
      account,
      platform,
      content: text,
      status: 'draft',
      category: request.category || null,
      is_podcast: !!request.guestName,
      guest_name: request.guestName || null,
      episode_number: request.episodeNumber || null,
      scheduled_at: scheduledAt || null,
      source_topic: request.topicTitle,
      source_keyword: request.keywords[0] || null,
    })
    .select()
    .single();

  if (error) {
    console.error('[composer/drafting] DB insert error:', error.message);
    return null;
  }

  return data as ComposerPost;
}

// ─── Revise Draft ─────────────────────────────────────────────────────────────
// Takes an existing draft + the founder's feedback, generates a revised version.
// Saves the feedback triplet (original → feedback → revised) to composer_feedback
// so the system learns from every correction.

export async function reviseDraft(
  originalContent: string,
  request: DraftRequest,
  feedback: string,
  scheduledAt?: string,
): Promise<ComposerPost | null> {
  const config = await getConfig();
  if (!config.apiKey) {
    console.error('[composer/drafting] No Anthropic API key configured.');
    return null;
  }

  const client = new Anthropic({ apiKey: config.apiKey });
  const account = request.account;
  const platform = getPlatformForAccount(account);
  const editorialMemory = await loadEditorialMemory(account);

  const sourceLinksText = request.sourceLinks && request.sourceLinks.length > 0
    ? `Source links:\n${request.sourceLinks.join('\n')}`
    : '';

  const userPrompt = `You wrote this draft post and the founder wants it revised:

ORIGINAL DRAFT:
${originalContent}

FOUNDER'S FEEDBACK:
${feedback}

TOPIC CONTEXT:
Topic: ${request.topicTitle}
Summary: ${request.topicSummary}
Keywords: ${request.keywords.join(', ')}
${sourceLinksText}

Rewrite the post incorporating the founder's feedback. Keep the same topic.
The feedback tells you exactly what to change — follow it precisely.
Return only the revised post text, nothing else.`;

  const response = await client.messages.create({
    model: config.model,
    max_tokens: 512,
    system: getSystemPrompt(account, editorialMemory),
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';
  if (!text) {
    console.error('[composer/drafting] Empty revision response.');
    return null;
  }

  const totalTokens =
    (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);
  console.log(`[composer/drafting] Generated revision (${totalTokens} tokens, ${text.length} chars)`);

  // Save the feedback triplet — this is how the system learns
  const { error: fbError } = await supabase
    .from('composer_feedback')
    .insert({
      original_content: originalContent,
      feedback,
      revised_content: text,
      topic_title: request.topicTitle,
      platform,
      account,
    });

  if (fbError) {
    console.error('[composer/drafting] Failed to save feedback:', fbError.message);
    // Continue anyway — the revision itself still works
  }

  // Save the revised post
  const { data, error } = await supabase
    .from('posts')
    .insert({
      account,
      platform,
      content: text,
      status: 'draft',
      category: request.category || null,
      scheduled_at: scheduledAt || null,
      source_topic: request.topicTitle,
      source_keyword: request.keywords[0] || null,
    })
    .select()
    .single();

  if (error) {
    console.error('[composer/drafting] DB insert error:', error.message);
    return null;
  }

  return data as ComposerPost;
}

// ─── Auto-Draft Daily Posts ───────────────────────────────────────────────────
// Runs at 6:30am AEST Mon-Fri. Instead of grabbing top 6 by raw post_count,
// it now:
// 1. Loads ALL today's topics
// 2. Loads editorial memory (past feedback)
// 3. Calls curateTopics() → Sonnet picks 5 topics with writing angles
// 4. Drafts 5 posts with Haiku using the curated angles
// 5. Assigns each to a time slot

export async function autoDraftDailyPosts(): Promise<void> {
  await withRunLog('composer-auto-draft', async () => {
    const today = getSydneyDate();
    const { startIso: todayStartIso, endIso: todayEndIso } = getSydneyDayBounds(today);
    const config = await getConfig();

    if (!config.apiKey) {
      console.error('[composer/drafting] No Anthropic API key configured.');
      return { llmTokens: 0 };
    }

    // Load ALL today's topics (not just top N)
    const { data: topics, error: topicsError } = await supabase
      .from('emerging_topics')
      .select('topic_title, summary, keyword, sample_urls, post_count')
      .eq('date', today)
      .order('post_count', { ascending: false });

    if (topicsError) {
      console.error('[composer/drafting] Failed loading topics:', topicsError.message);
      return { llmTokens: 0 };
    }

    if (!topics || topics.length === 0) {
      console.log('[composer/drafting] No topics for today. Skipping auto-draft.');
      return { llmTokens: 0 };
    }

    // Draft for each account that has auto-draft enabled.
    // For now: prefactor_x gets the intelligence-driven auto-draft (was the original account).
    // Other accounts get manual drafting only until Phase 2.
    const autoDraftAccounts: AccountSlug[] = [...ACCOUNT_SLUGS];

    for (const account of autoDraftAccounts) {
      console.log(`[composer/drafting] Auto-drafting for ${account}...`);

      // Check which topics already have drafts today for this account
      const { data: existingPosts } = await supabase
        .from('posts')
        .select('source_topic, scheduled_at')
        .eq('account', account)
        .gte('created_at', todayStartIso)
        .lt('created_at', todayEndIso);

      const draftedTopics = new Set((existingPosts || []).map((p) => p.source_topic));
      const draftedSlots = new Set(
        (existingPosts || [])
          .map((p) => (p.scheduled_at ? formatSydneySlotTime(p.scheduled_at) : null))
          .filter((slot): slot is string => !!slot),
      );

      // Filter out already-drafted topics before curation
      const availableTopics = topics.filter((t) => !draftedTopics.has(t.topic_title));

      if (availableTopics.length === 0) {
        console.log(`[composer/drafting] All topics already drafted for ${account}. Skipping.`);
        continue;
      }

      // Load editorial memory for curation context
      const editorialMemory = await loadEditorialMemory(account);

      // Curate: Sonnet picks the 5 best topics with writing angles
      console.log(`[composer/drafting] Curating from ${availableTopics.length} available topics for ${account}...`);
      const curated = await curateTopics(availableTopics, editorialMemory, config.apiKey);

      const topicsToUse = curated.length > 0
        ? curated
        : availableTopics.slice(0, 5).map((t) => ({
            topic_title: t.topic_title,
            angle: '',
            summary: t.summary,
            keyword: t.keyword,
            sample_urls: t.sample_urls || [],
          }));

      if (curated.length === 0) {
        console.error(`[composer/drafting] Curation returned no topics for ${account}. Falling back to top 5.`);
      }

      // Draft a post for each curated topic, assigning to time slots
      let slotIndex = 0;
      for (const topic of topicsToUse) {
        // Find the next available slot
        while (slotIndex < SCHEDULED_SLOTS_SYDNEY.length && draftedSlots.has(SCHEDULED_SLOTS_SYDNEY[slotIndex])) {
          slotIndex++;
        }
        if (slotIndex >= SCHEDULED_SLOTS_SYDNEY.length) break;

        const slotTime = SCHEDULED_SLOTS_SYDNEY[slotIndex];
        const scheduledAt = sydneyLocalToUtcIso(today, slotTime);
        slotIndex++;

        console.log(`[composer/drafting] Drafting ${account} for slot ${slotTime} Sydney: "${topic.topic_title}"`);

        const post = await draftPost(
          {
            topicId: '',
            topicTitle: topic.topic_title,
            topicSummary: topic.summary,
            keywords: [topic.keyword],
            sourceLinks: topic.sample_urls,
            platform: getPlatformForAccount(account),
            account,
            angle: topic.angle,
          },
          scheduledAt,
        );

        if (post) {
          console.log(`[composer/drafting] Created ${account} draft #${post.id} for ${slotTime} Sydney`);
        }
      }
    }

    return { llmTokens: 0 };
  });
}

function formatSydneySlotTime(iso: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}
