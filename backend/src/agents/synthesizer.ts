import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../db/supabase.js';
import { getSydneyDate, getSydneyDateOffset, getSydneyDayOfWeek } from '../utils/sydneyDate.js';
import { withRunLog } from './shared/runLogger.js';
import {
  extractFirstTextContent,
  sentimentDirection,
  sentimentLabel,
  sentimentToScore,
  urlLabel,
} from './synthesizerUtils.js';

const MAX_SIGNALS_PER_TRACK = 10;
const MAX_TOPICS_PER_TRACK = 8;
const MAX_SUMMARY_CHARS = 220;
const MAX_PROMPT_CHARS = 9000;
const SYNTH_MAX_TOKENS = 700;
const RATE_LIMIT_RETRY_MS = 22_000;
const MAX_ATTEMPTS_PER_MODEL = 2;

// --- API key helper ---

async function getAnthropicConfig(): Promise<{ apiKey: string; llmModel: string }> {
  const { data } = await supabase
    .from('config')
    .select('anthropic_api_key, llm_model')
    .eq('id', 1)
    .single();

  return {
    apiKey: data?.anthropic_api_key || process.env.ANTHROPIC_API_KEY || '',
    llmModel: data?.llm_model || 'claude-sonnet-4-6',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimPrompt(prompt: string, maxChars = MAX_PROMPT_CHARS): string {
  if (prompt.length <= maxChars) return prompt;
  return `${prompt.slice(0, maxChars - 64)}\n\n[truncated to fit token budget]`;
}

function shorten(text: string, maxChars = MAX_SUMMARY_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 3)}...`;
}

function isRateLimitError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('rate_limit_error') || message.includes('429');
}

async function callWithBudgetedRetry(
  client: Anthropic,
  prompt: string,
  preferredModel: string
) {
  const models = Array.from(new Set([preferredModel, 'claude-haiku-4-5-20251001']));
  let lastError: unknown = null;

  for (const model of models) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      try {
        const response = await client.messages.create({
          model,
          max_tokens: SYNTH_MAX_TOKENS,
          messages: [{ role: 'user', content: trimPrompt(prompt) }],
        });
        return response;
      } catch (err) {
        lastError = err;
        if (!isRateLimitError(err)) throw err;
        if (attempt < MAX_ATTEMPTS_PER_MODEL) {
          console.warn(`[synthesizer] Rate limited on ${model}, retrying in ${RATE_LIMIT_RETRY_MS / 1000}s...`);
          await sleep(RATE_LIMIT_RETRY_MS);
        }
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// --- Main synthesizer ---

export async function synthesizer() {
  return withRunLog('synthesizer', async () => {
    const today = getSydneyDate();
    const yesterday = getSydneyDateOffset(-1);
    const dayOfWeek = getSydneyDayOfWeek(); // Sunday=0 ... Saturday=6
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    const { apiKey, llmModel } = await getAnthropicConfig();
    if (!apiKey) throw new Error('No Anthropic API key configured. Add it in Admin -> Config.');

    const client = new Anthropic({ apiKey });

    // --- Load today's signals and topics ---
    const { data: signals, error: signalsError } = await supabase
      .from('keyword_signals')
      .select('keyword, sentiment, post_count, category')
      .eq('date', today);
    if (signalsError) throw new Error(`Failed loading keyword_signals: ${signalsError.message}`);

    const { data: topics, error: topicsError } = await supabase
      .from('emerging_topics')
      .select('keyword, topic_title, summary, post_count, sample_urls, category')
      .eq('date', today);
    if (topicsError) throw new Error(`Failed loading emerging_topics: ${topicsError.message}`);

    if (!signals || signals.length === 0) {
      console.log('[synthesizer] No signals found for today. Has the collector run yet?');
      return { llmTokens: 0 };
    }

    // --- Split by track ---
    const ecosystemSignals = signals.filter((s) => s.category === 'ecosystem');
    const enterpriseSignals = signals.filter((s) => s.category === 'enterprise');
    const ecosystemTopics = (topics || []).filter((t) => t.category === 'ecosystem');
    const enterpriseTopics = (topics || []).filter((t) => t.category === 'enterprise');

    // --- Calculate today's sentiment score ---
    const allScores = signals.map((s) => sentimentToScore(s.sentiment));
    const todayScore = allScores.length > 0
      ? Math.round((allScores.reduce((a, b) => a + b, 0) / allScores.length) * 1000) / 1000
      : 0;

    // --- Load yesterday's score for direction comparison ---
    const { data: yesterdayReport, error: yesterdayError } = await supabase
      .from('daily_report')
      .select('sentiment_score')
      .eq('date', yesterday)
      .single();
    if (yesterdayError && yesterdayError.code !== 'PGRST116') {
      throw new Error(`Failed loading yesterday report: ${yesterdayError.message}`);
    }

    const direction = sentimentDirection(todayScore, yesterdayReport?.sentiment_score ?? null);
    const label = sentimentLabel(todayScore);
    // No topics means nothing concrete to synthesize or post.
    if (!topics || topics.length === 0) {
      console.log('[synthesizer] No topics found for today. Skipping synthesis and Slack post.');
      await supabase
        .from('daily_report')
        .upsert(
          {
            date: today,
            ecosystem_synthesis: null,
            enterprise_synthesis: null,
            sentiment_score: todayScore,
            sentiment_direction: direction.direction,
            sentiment_label: label,
            slack_post_text: null,
          },
          { onConflict: 'date' },
        );
      return { llmTokens: 0 };
    }

    // Format topics: embed URL labels and enforce input budget before LLM call.
    const formatTopics = (topicList: typeof ecosystemTopics) =>
      topicList
        .sort((a, b) => b.post_count - a.post_count)
        .slice(0, MAX_TOPICS_PER_TRACK)
        .map((t) => {
          const urls = (t.sample_urls || []).slice(0, 2);
          const linkLine = urls.map((u: string) => `${u} [label: ${urlLabel(u)}]`).join(' | ');
          return `- ${t.topic_title} (${t.post_count} posts)\n  Links: ${linkLine || 'none'}\n  ${shorten(t.summary)}`;
        })
        .join('\n') || 'None identified today.';

    const formatSignals = (trackSignals: typeof ecosystemSignals) =>
      trackSignals
        .sort((a, b) => b.post_count - a.post_count)
        .slice(0, MAX_SIGNALS_PER_TRACK)
        .map((s) => `- ${s.keyword}: ${s.post_count} posts, ${s.sentiment}`)
        .join('\n') || 'No signals today.';

    // --- Ecosystem synthesis (Sonnet call 1) ---
    const ecosystemPrompt = `You are writing a daily AI industry digest for a technical founding team. Report facts - do not give strategic advice or tell the reader what they should do.

Today's ecosystem signals (developer tools, models, open source, coding assistants):

Signal volume:
${formatSignals(ecosystemSignals)}

Emerging topics with source URLs:
${formatTopics(ecosystemTopics)}

Output format - write each topic as a Slack-formatted entry. Use this exact structure:

*Topic title* · N posts
<URL1|LABEL1> · <URL2|LABEL2>
One or two sentences of factual summary. Name the products, people, or events involved.

Use the [label: ...] provided for each URL as the anchor text - e.g. [label: Reddit thread] -> <https://reddit.com/...|Reddit thread>
If only one URL is available, show one link. If no URLs, skip the topic.

Rules:
- Slack bold: *text* (single asterisks only)
- Links: <https://example.com|anchor text>
- Skip topics with no URLs
- No conclusions or recommendations
- Maximum 4 topics
- Plain, direct language`;

    console.log('[synthesizer] Calling Anthropic for ecosystem synthesis...');
    const ecosystemResponse = await callWithBudgetedRetry(client, ecosystemPrompt, llmModel);
    const ecosystemSynthesis = extractFirstTextContent(ecosystemResponse.content);

    // --- Enterprise synthesis (Sonnet call 2) ---
    const enterprisePrompt = `You are writing a daily AI industry digest for a technical founding team. Report facts - do not give strategic advice or tell the reader what they should do.

Today's enterprise AI signals (governance, compliance, deployment, shadow AI, observability):

Signal volume:
${formatSignals(enterpriseSignals)}

Emerging topics with source URLs:
${formatTopics(enterpriseTopics)}

Output format - write each topic as a Slack-formatted entry. Use this exact structure:

*Topic title* · N posts
<URL1|LABEL1> · <URL2|LABEL2>
One or two sentences of factual summary. Name the products, companies, regulations, or incidents involved.

Use the [label: ...] provided for each URL as the anchor text - e.g. [label: Reddit thread] -> <https://reddit.com/...|Reddit thread>
If only one URL is available, show one link. If no URLs, skip the topic.

Rules:
- Slack bold: *text* (single asterisks only)
- Links: <https://example.com|anchor text>
- Skip topics with no URLs
- No conclusions or recommendations
- Maximum 4 topics
- Plain, direct language`;

    // Small delay to avoid hitting minute-level throughput limits on back-to-back calls.
    await sleep(1200);
    console.log('[synthesizer] Calling Anthropic for enterprise synthesis...');
    const enterpriseResponse = await callWithBudgetedRetry(client, enterprisePrompt, llmModel);
    const enterpriseSynthesis = extractFirstTextContent(enterpriseResponse.content);

    const totalTokens =
      (ecosystemResponse.usage?.input_tokens ?? 0) +
      (ecosystemResponse.usage?.output_tokens ?? 0) +
      (enterpriseResponse.usage?.input_tokens ?? 0) +
      (enterpriseResponse.usage?.output_tokens ?? 0);

    // --- Build Slack post ---
    const slackText =
      `*Ecosystem*\n${ecosystemSynthesis}\n\n` +
      `*Enterprise AI*\n${enterpriseSynthesis}\n\n` +
      `*Sentiment* - ${label} · ${direction.direction} ${direction.label} vs yesterday`;

    // --- Write to DB (always, even if Slack fails) ---
    const { error: dbError } = await supabase
      .from('daily_report')
      .upsert(
        {
          date: today,
          ecosystem_synthesis: ecosystemSynthesis,
          enterprise_synthesis: enterpriseSynthesis,
          sentiment_score: todayScore,
          sentiment_direction: direction.direction,
          sentiment_label: label,
          slack_post_text: slackText,
        },
        { onConflict: 'date' },
      );

    if (dbError) {
      console.error('[synthesizer] DB write error:', dbError.message);
    } else {
      console.log('[synthesizer] Written to daily_report.');
    }

    // --- Post to Slack ---
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (webhookUrl && !isWeekend) {
      try {
        const slackRes = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: slackText }),
        });

        if (slackRes.ok) {
          await supabase
            .from('daily_report')
            .update({ posted_at: new Date().toISOString() })
            .eq('date', today);
          console.log('[synthesizer] Posted to Slack.');
        } else {
          console.warn('[synthesizer] Slack post failed:', slackRes.status, await slackRes.text());
        }
      } catch (err) {
        console.warn('[synthesizer] Slack webhook error:', err);
      }
    } else if (isWeekend) {
      console.log('[synthesizer] Weekend (Sydney) - skipping Slack post.');
    } else {
      console.log('[synthesizer] No SLACK_WEBHOOK_URL set - skipping Slack post.');
    }

    console.log(`[synthesizer] Sentiment: ${todayScore} (${label}) ${direction.direction} ${direction.label}`);
    return { llmTokens: totalTokens };
  });
}

