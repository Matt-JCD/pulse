import cron from 'node-cron';
import { supabase } from '../db/supabase.js';
import { publishPost } from './index.js';
import { autoDraftDailyPosts } from './drafting.js';
import { refreshEngagement } from '../scheduler/engagement.js';
import type { ComposerPost } from './types.js';

// Slack functions are imported lazily to avoid circular deps and missing env vars
let slackModule: typeof import('./slack.js') | null = null;
async function getSlack() {
  if (!slackModule) {
    slackModule = await import('./slack.js');
  }
  return slackModule;
}

/**
 * Starts the composer's cron jobs — fully independent of the intelligence pipeline.
 *
 * Jobs:
 * 1. Auto-draft: 6:00am AEST Mon–Fri. Reads emerging_topics and drafts posts.
 * 2. Slack digest: 6:30am AEST daily. Sends approval digest to Matt.
 * 3. Slack nudge: 7:15am AEST daily. Pings Matt about unapproved posts.
 * 4. Publisher: every 30min 7:30am–11pm AEST. Fires approved posts whose scheduled_at has arrived.
 */
export function startComposerScheduler(): void {
  // ── Auto-draft: 7:00am AEST, Mon–Fri ──
  // Runs after the intelligence pipeline (6am) so emerging_topics exist.
  cron.schedule(
    '0 7 * * 1-5',
    async () => {
      console.log('[composer-scheduler] Auto-draft starting...');
      try {
        await autoDraftDailyPosts();
        console.log('[composer-scheduler] Auto-draft complete.');
      } catch (err) {
        console.error('[composer-scheduler] Auto-draft failed:', err instanceof Error ? err.message : err);
      }
    },
    { timezone: 'Australia/Sydney' },
  );

  // ── Slack daily digest: 7:15am AEST, every day ──
  // Runs after auto-draft (7am) so posts exist to review.
  cron.schedule(
    '15 7 * * *',
    async () => {
      console.log('[composer-scheduler] Sending daily digest...');
      try {
        const slack = await getSlack();
        await slack.sendDailyDigest();
        console.log('[composer-scheduler] Daily digest sent.');
      } catch (err) {
        console.error('[composer-scheduler] Digest failed:', err instanceof Error ? err.message : err);
      }
    },
    { timezone: 'Australia/Sydney' },
  );

  // ── Slack nudge: 7:45am AEST, every day ──
  // Gives 30 minutes after digest to review before nudging.
  cron.schedule(
    '45 7 * * *',
    async () => {
      try {
        const slack = await getSlack();
        await slack.sendNudge();
      } catch (err) {
        console.error('[composer-scheduler] Nudge failed:', err instanceof Error ? err.message : err);
      }
    },
    { timezone: 'Australia/Sydney' },
  );

  // ── Publisher: every 30 minutes, 7:30am–11pm AEST ──
  // Only fires posts with status 'approved' whose scheduled_at has arrived.
  cron.schedule(
    '0,30 7-23 * * *',
    async () => {
      try {
        const now = new Date().toISOString();

        const { data: duePosts, error } = await supabase
          .from('posts')
          .select('*')
          .eq('status', 'approved')
          .lte('scheduled_at', now)
          .order('scheduled_at', { ascending: true });

        if (error) {
          console.error('[composer-scheduler] Publisher query error:', error.message);
          return;
        }

        if (!duePosts || duePosts.length === 0) return;

        console.log(`[composer-scheduler] ${duePosts.length} post(s) due for publishing.`);

        for (const post of duePosts as ComposerPost[]) {
          await publishPost(post);
        }
      } catch (err) {
        console.error('[composer-scheduler] Publisher error:', err instanceof Error ? err.message : err);
      }
    },
    { timezone: 'Australia/Sydney' },
  );

  // ── Engagement refresh: midnight AEST daily (14:00 UTC) ──
  cron.schedule(
    '0 0 * * *',
    async () => {
      console.log('[composer-scheduler] Engagement refresh starting...');
      try {
        await refreshEngagement();
        console.log('[composer-scheduler] Engagement refresh complete.');
      } catch (err) {
        console.error('[composer-scheduler] Engagement refresh failed:', err instanceof Error ? err.message : err);
      }
    },
    { timezone: 'Australia/Sydney' },
  );

  console.log('[composer-scheduler] Crons registered: auto-draft 7am, digest 7:15am, nudge 7:45am, publisher 7:30am–11pm, engagement midnight AEST.');
}
