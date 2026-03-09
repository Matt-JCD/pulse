import { Router } from 'express';
import { supabase } from '../../db/supabase.js';
import { hnCollector } from '../../agents/hnCollector.js';
import { redditCollector } from '../../agents/redditCollector.js';
import { twitterCollector } from '../../agents/twitterCollector.js';
import { synthesizer } from '../../agents/synthesizer.js';
import { autoDraftDailyPosts } from '../../composer/drafting.js';
import { refreshEngagement } from '../../scheduler/engagement.js';
import { sendDailyDigest, sendNudge } from '../../composer/slack.js';

const router = Router();

// Known pipeline functions and their trigger implementations
const PIPELINE_FUNCTIONS: Record<string, () => Promise<unknown>> = {
  'hn-collector': () => hnCollector(false),
  'reddit-collector': () => redditCollector(false),
  'twitter-collector': () => twitterCollector(false),
  'synthesizer': () => synthesizer(),
  'composer-auto-draft': () => autoDraftDailyPosts(),
  'engagement-refresh': () => refreshEngagement(),
  'slack-digest': () => sendDailyDigest(),
  'slack-nudge': () => sendNudge(),
};

// GET /api/admin/pipeline/status — latest run per function
router.get('/api/admin/pipeline/status', async (_req, res) => {
  // Get the most recent run_log entry for each function_name
  const { data, error } = await supabase
    .from('run_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Group by function_name, take most recent
  const latestByFunction: Record<string, typeof data[0]> = {};
  for (const row of data) {
    if (!latestByFunction[row.function_name]) {
      latestByFunction[row.function_name] = row;
    }
  }

  res.json(Object.values(latestByFunction));
});

// POST /api/admin/pipeline/trigger — trigger a full collection run (same sequence as cron)
router.post('/api/admin/pipeline/trigger', async (_req, res) => {
  const runAll = async () => {
    try {
      console.log('[pipeline] Manual full run starting...');
      await hnCollector(false);
      await redditCollector(false);
      await twitterCollector(false);
      await synthesizer();
      console.log('[pipeline] Manual full run complete.');
    } catch (err) {
      console.error('[pipeline] Manual full run failed:', err instanceof Error ? err.message : err);
    }
  };

  // Fire-and-forget
  runAll();
  res.json({ ok: true, message: 'Full collection run triggered.' });
});

// POST /api/admin/pipeline/trigger/:fn — manually trigger a single pipeline function
router.post('/api/admin/pipeline/trigger/:fn', async (req, res) => {
  const { fn } = req.params;
  const trigger = PIPELINE_FUNCTIONS[fn];

  if (!trigger) {
    res.status(400).json({ error: `Unknown function: ${fn}. Valid: ${Object.keys(PIPELINE_FUNCTIONS).join(', ')}` });
    return;
  }

  // Fire-and-forget
  trigger().catch((err) =>
    console.error(`[pipeline] Manual trigger of ${fn} failed:`, err instanceof Error ? err.message : err),
  );

  res.json({ ok: true, message: `${fn} triggered.` });
});

export default router;
