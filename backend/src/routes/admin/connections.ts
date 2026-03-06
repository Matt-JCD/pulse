import { Router } from 'express';
import { supabase } from '../../db/supabase.js';

const router = Router();

// GET /api/admin/connections — list all provider connection statuses
router.get('/api/admin/connections', async (_req, res) => {
  const { data, error } = await supabase
    .from('api_connections')
    .select('*')
    .order('id', { ascending: true });

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  res.json(data);
});

// POST /api/admin/connections/test — test all connections and update statuses
router.post('/api/admin/connections/test', async (_req, res) => {
  // Fetch stored API keys from config
  const { data: config, error: configError } = await supabase
    .from('config')
    .select('anthropic_api_key, openai_api_key, scrapebadger_api_key, linkedapi_key')
    .eq('id', 1)
    .single();

  if (configError) {
    res.status(500).json({ error: configError.message });
    return;
  }

  const results: Array<{ provider: string; connected: boolean; error?: string }> = [];

  // Test each provider
  const tests: Array<{ provider: string; test: () => Promise<{ connected: boolean; error?: string }> }> = [
    {
      provider: 'anthropic',
      test: async () => {
        const key = config.anthropic_api_key;
        if (!key) return { connected: false, error: 'API key not configured' };
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
        });
        if (r.ok || r.status === 400) return { connected: true };
        if (r.status === 401) return { connected: false, error: 'Invalid API key' };
        return { connected: false, error: `HTTP ${r.status}` };
      },
    },
    {
      provider: 'openai',
      test: async () => {
        const key = config.openai_api_key;
        if (!key) return { connected: false, error: 'API key not configured' };
        const r = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${key}` },
        });
        return r.ok ? { connected: true } : { connected: false, error: 'Invalid API key' };
      },
    },
    {
      provider: 'scrapebadger',
      test: async () => {
        const key = config.scrapebadger_api_key;
        if (!key) return { connected: false, error: 'API key not configured' };
        return { connected: true };
      },
    },
    {
      provider: 'linkedapi',
      test: async () => {
        const key = config.linkedapi_key;
        if (!key) return { connected: false, error: 'API key not configured' };
        return { connected: true };
      },
    },
    {
      provider: 'x_api',
      test: async () => {
        const token = process.env.X_BEARER_TOKEN;
        if (!token) return { connected: false, error: 'X_BEARER_TOKEN env var not set' };
        const r = await fetch('https://api.twitter.com/2/tweets/search/recent?query=test&max_results=10', {
          headers: { Authorization: `Bearer ${token}` },
        });
        return r.ok ? { connected: true } : { connected: false, error: `HTTP ${r.status}` };
      },
    },
    {
      provider: 'linkedin_api',
      test: async () => {
        const token = process.env.LINKEDIN_MATT_ACCESS_TOKEN || process.env.LINKEDIN_PREFACTOR_ACCESS_TOKEN;
        if (!token) return { connected: false, error: 'LinkedIn access token env vars not set' };
        return { connected: true };
      },
    },
  ];

  for (const { provider, test } of tests) {
    try {
      const result = await test();
      results.push({ provider, ...result });

      await supabase
        .from('api_connections')
        .upsert({
          provider,
          status: result.connected ? 'connected' : 'error',
          last_checked_at: new Date().toISOString(),
          error_message: result.error || null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'provider' });
    } catch (err) {
      const error = err instanceof Error ? err.message : 'Connection test failed';
      results.push({ provider, connected: false, error });

      await supabase
        .from('api_connections')
        .upsert({
          provider,
          status: 'error',
          last_checked_at: new Date().toISOString(),
          error_message: error,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'provider' });
    }
  }

  res.json(results);
});

export default router;
