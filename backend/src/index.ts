import 'dotenv/config';
import express from 'express';
// eslint-disable-next-line @typescript-eslint/no-require-imports -- next's CJS types don't expose a callable default for ESM
import createNextApp from 'next';
const next = createNextApp as unknown as typeof createNextApp.default;
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { corsMiddleware } from './middleware/cors.js';
import healthRouter from './routes/health.js';
import configRouter from './routes/admin/config.js';
import keywordsRouter from './routes/admin/keywords.js';
import testConnectionRouter from './routes/admin/testConnection.js';
import connectionsRouter from './routes/admin/connections.js';
import pipelineRouter from './routes/admin/pipeline.js';
import intelligenceRouter from './routes/intelligence.js';
import composerRouter from './routes/composer.js';
import mediaRouter from './routes/media/index.js';
import analyticsRouter from './routes/analytics/index.js';
import { startScheduler } from './scheduler.js';
import { startComposerScheduler } from './composer/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dev = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT || '3001', 10);

// Point Next.js at the frontend directory.
// Compiled: __dirname = backend/dist/ → ../../frontend
// Dev:     __dirname = backend/src/  → ../../frontend
const frontendDir = path.resolve(__dirname, '../../frontend');

const nextApp = next({ dev, dir: frontendDir });
const nextHandler = nextApp.getRequestHandler();

async function main(): Promise<void> {
  await nextApp.prepare();

  const app = express();

  // ── API-only middleware (scoped to /api paths) ──
  const captureRawBody = (req: express.Request, _res: express.Response, buf: Buffer): void => {
    if (buf.length > 0) {
      (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
    }
  };
  app.use('/api', corsMiddleware);
  app.use('/api', express.json({ verify: captureRawBody }));
  app.use('/api', express.urlencoded({ extended: true, verify: captureRawBody }));

  // ── API routes (all paths already include /api/ prefix) ──
  app.use(healthRouter);
  app.use(configRouter);
  app.use(keywordsRouter);
  app.use(testConnectionRouter);
  app.use(connectionsRouter);
  app.use(pipelineRouter);
  app.use(intelligenceRouter);
  app.use(composerRouter);
  app.use(mediaRouter);
  app.use(analyticsRouter);

  // ── Next.js catch-all (pages, _next/static, _next/image, public/) ──
  app.all('/{*path}', (req, res) => {
    return nextHandler(req, res);
  });

  app.listen(port, () => {
    console.log(`[Pulse] Server running on http://localhost:${port}`);
    startScheduler();
    startComposerScheduler();
  });
}

main().catch((err) => {
  console.error('[Pulse] Failed to start:', err);
  process.exit(1);
});
