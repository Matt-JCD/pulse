import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../db/supabase.js';
import { getSydneyDate } from '../utils/sydneyDate.js';
import { withRunLog } from '../agents/shared/runLogger.js';
import type { DraftRequest, ComposerPost, Platform } from './types.js';

// 6 fixed time slots in AEST → stored as UTC (AEST = UTC+10).
// 07:00 AEST = 21:00 UTC (prev day), 09:00 = 23:00, 11:00 = 01:00,
// 13:00 = 03:00, 15:00 = 05:00, 22:00 = 12:00
const SCHEDULED_SLOTS_UTC = ['21:00', '23:00', '01:00', '03:00', '05:00', '12:00'];

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

/**
 * Brand voice system prompt for Prefactor.
 * Encodes the 4 voice pillars and platform-specific constraints.
 */
function getSystemPrompt(platform: Platform): string {
  const baseVoice = `You are writing social media posts for Prefactor, an AI governance company. You are Prefactor the company — not a person.

## The Four Prefactor Voice Pillars

1. **Human Directness** — Talk to people, not personas. Acknowledge reality including limitations. Communicate with humans solving hard problems.
2. **Earned Authority** — Speak from experience. Authority comes from what we ship, not claims we make.
3. **Engineering Clarity** — Logical, specific, unambiguous. If there's a simpler way to say it without losing precision, take it. Don't assume the audience knows the jargon.
4. **Favour Simplicity** — Clarity over complexity. Simplicity isn't lack of depth — it's disciplined thinking. Complexity hides risk; simplicity exposes what matters.

## Rules
- Only use facts from the topic title, summary, keywords, and source links provided — never invent claims.
- Could this be defended to a skeptical CTO?
- Would an engineer know exactly what to do next?
- Is any jargon explained?
- Does it sound human, not like a press release?
- If you removed all adjectives, does the substance still stand?

## Do NOT
- Say "game-changer", "revolutionize", "disrupt", "magic", or "one-click"
- Make vague claims like "Agents need secure access" — be specific
- Use hype language or superlatives
- Invent facts, statistics, or capabilities not in the provided topic data

## Do
- Be specific: name the product, version, company
- Be direct: say what it does, not what it promises
- Be practical: give engineers something they can act on`;

  if (platform === 'twitter') {
    return `${baseVoice}

## Platform: X (Twitter)
- HARD LIMIT: Maximum 280 characters. Count carefully. Do not exceed 280.
- Strong hook in the first line.
- No hashtags.
- Punchy, specific, one clear point per post.
- Single tweet only — no threads.

Produce the tweet text only. No quotes, no labels, no explanation.`;
  }

  // LinkedIn
  return `${baseVoice}

## Platform: LinkedIn
- Up to 3,000 characters. Use line breaks for readability.
- 3–5 relevant hashtags at the end.
- More context is allowed but no fluff.
- Professional tone. Address founders, CTOs, VPs of Engineering.

Produce the post text only. No quotes, no labels, no explanation.`;
}

/**
 * Generates a single draft post using Claude Haiku, saves to the posts table.
 * Returns the saved post, or null if generation fails.
 */
export async function draftPost(request: DraftRequest, scheduledAt?: string): Promise<ComposerPost | null> {
  const config = await getConfig();
  if (!config.apiKey) {
    console.error('[composer/drafting] No Anthropic API key configured.');
    return null;
  }

  const client = new Anthropic({ apiKey: config.apiKey });

  const sourceLinksText = request.sourceLinks && request.sourceLinks.length > 0
    ? `Source links:\n${request.sourceLinks.join('\n')}`
    : 'No source links available.';

  const userPrompt = `Write a social media post about this topic:

Topic: ${request.topicTitle}
Summary: ${request.topicSummary}
Keywords: ${request.keywords.join(', ')}
${sourceLinksText}

Write exactly ONE post. Return only the post text, nothing else.`;

  const response = await client.messages.create({
    model: config.model,
    max_tokens: 512,
    system: getSystemPrompt(request.platform),
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';
  if (!text) {
    console.error('[composer/drafting] Empty response from Haiku.');
    return null;
  }

  const totalTokens =
    (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);
  console.log(`[composer/drafting] Generated draft (${totalTokens} tokens, ${text.length} chars)`);

  const { data, error } = await supabase
    .from('posts')
    .insert({
      platform: request.platform,
      content: text,
      status: 'draft',
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

/**
 * Auto-drafts 6 posts for today's top emerging topics.
 * Called by the main scheduler after the synthesizer completes.
 *
 * 1. Queries today's top 6 topics by post_count (momentum)
 * 2. Drafts an X post for each using Claude Haiku + brand voice
 * 3. Assigns each to a fixed time slot (AEST)
 * 4. Saves with status='draft' — enters the review queue
 */
export async function autoDraftDailyPosts(): Promise<void> {
  await withRunLog('composer-auto-draft', async () => {
    const today = getSydneyDate();

    // Top topics by engagement/momentum
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

    // Check which topics already have drafts today to avoid duplicates
    const { data: existingPosts } = await supabase
      .from('posts')
      .select('source_topic, scheduled_at')
      .eq('platform', 'twitter')
      .gte('created_at', `${today}T00:00:00Z`);

    const draftedTopics = new Set((existingPosts || []).map((p) => p.source_topic));
    const draftedSlots = new Set(
      (existingPosts || []).map((p) => p.scheduled_at?.slice(11, 16)),
    );

    const availableTopics = topics.filter((t) => !draftedTopics.has(t.topic_title));
    let topicIndex = 0;
    let totalTokens = 0;

    for (const slotTime of SCHEDULED_SLOTS_UTC) {
      if (draftedSlots.has(slotTime)) continue; // slot already filled
      if (topicIndex >= availableTopics.length) break; // no more topics
      if (topicIndex >= 6) break; // max 6 drafts

      const topic = availableTopics[topicIndex++];

      // For slots 21:00 and 23:00 UTC, these are the previous day in UTC
      // (07:00 AEST and 09:00 AEST on "today" = 21:00 and 23:00 UTC on "yesterday")
      // But we store them as tomorrow's date since the intelligence run happens at 6am AEST.
      // The scheduler will pick them up when scheduled_at <= NOW().
      const scheduledAt = `${today}T${slotTime}:00Z`;

      console.log(`[composer/drafting] Drafting for slot ${slotTime} UTC: "${topic.topic_title}"`);

      const post = await draftPost(
        {
          topicId: '',
          topicTitle: topic.topic_title,
          topicSummary: topic.summary,
          keywords: [topic.keyword],
          sourceLinks: topic.sample_urls || [],
          platform: 'twitter',
        },
        scheduledAt,
      );

      if (post) {
        console.log(`[composer/drafting] Created draft #${post.id} for ${slotTime} UTC`);
      }
    }

    return { llmTokens: totalTokens };
  });
}
