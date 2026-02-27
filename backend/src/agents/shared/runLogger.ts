import { supabase } from '../../db/supabase.js';
import { getSydneyDate } from '../../utils/sydneyDate.js';

async function notifySlackFailure(functionName: string, errorMsg: string): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  const text =
    `:warning: *Pulse agent failed* — \`${functionName}\`\n` +
    `Error: ${errorMsg}`;

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error('[runLogger] Failed to send Slack failure notification:', err);
  }
}

/**
 * Wraps an agent function with run_log tracking.
 * Records start time, duration, result, and any errors.
 */
export async function withRunLog<T>(
  functionName: string,
  fn: () => Promise<T & { postsFetched?: number; llmTokens?: number }>,
): Promise<T> {
  const startTime = Date.now();
  const today = getSydneyDate();

  try {
    const result = await fn();
    const durationMs = Date.now() - startTime;

    await supabase.from('run_log').insert({
      date: today,
      function_name: functionName,
      status: 'success',
      duration_ms: durationMs,
      posts_fetched: result.postsFetched ?? null,
      llm_tokens: result.llmTokens ?? null,
    });

    console.log(`[${functionName}] Completed in ${durationMs}ms`);
    return result;
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);

    await supabase.from('run_log').insert({
      date: today,
      function_name: functionName,
      status: 'error',
      duration_ms: durationMs,
      error_msg: errorMsg,
    });

    console.error(`[${functionName}] Failed after ${durationMs}ms: ${errorMsg}`);
    await notifySlackFailure(functionName, errorMsg);
    throw err;
  }
}
