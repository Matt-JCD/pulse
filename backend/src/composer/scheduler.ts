import cron from 'node-cron';
import { supabase } from '../db/supabase.js';
import { publishPost } from './index.js';
import type { ComposerPost } from './types.js';

/**
 * Starts a cron job that runs every hour from 6am–11pm AEST.
 * Checks for approved posts whose scheduled_at has arrived and publishes them.
 *
 * Cron: "0 6-23 * * *" = minute 0 of every hour from 6 through 23, AEST.
 * Posts are published sequentially to respect rate limits.
 */
export function startComposerScheduler(): void {
  cron.schedule(
    '0 6-23 * * *',
    async () => {
      try {
        const now = new Date().toISOString();

        const { data: duePosts, error } = await supabase
          .from('posts')
          .select('*')
          .eq('status', 'scheduled')
          .lte('scheduled_at', now)
          .order('scheduled_at', { ascending: true });

        if (error) {
          console.error('[composer-scheduler] Query error:', error.message);
          return;
        }

        if (!duePosts || duePosts.length === 0) return;

        console.log(`[composer-scheduler] ${duePosts.length} post(s) due for publishing.`);

        for (const post of duePosts as ComposerPost[]) {
          await publishPost(post);
        }
      } catch (err) {
        console.error('[composer-scheduler] Error:', err instanceof Error ? err.message : err);
      }
    },
    { timezone: 'Australia/Sydney' },
  );

  console.log('[composer-scheduler] Cron registered: hourly 6am–11pm AEST (Australia/Sydney).');
}
