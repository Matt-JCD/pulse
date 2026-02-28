import 'dotenv/config';
import express from 'express';
import { corsMiddleware } from './middleware/cors.js';
import healthRouter from './routes/health.js';
import configRouter from './routes/admin/config.js';
import keywordsRouter from './routes/admin/keywords.js';
import testConnectionRouter from './routes/admin/testConnection.js';
import intelligenceRouter from './routes/intelligence.js';
import composerRouter from './routes/composer.js';
import { startScheduler } from './scheduler.js';
import { startComposerScheduler } from './composer/scheduler.js';

const app = express();
const port = parseInt(process.env.PORT || '3001', 10);

// Middleware
app.use(corsMiddleware);
app.use(express.json());

// Routes
app.use(healthRouter);
app.use(configRouter);
app.use(keywordsRouter);
app.use(testConnectionRouter);
app.use(intelligenceRouter);
app.use(composerRouter);

// Start
app.listen(port, () => {
  console.log(`[Pulse] Backend running on http://localhost:${port}`);
  startScheduler();
  startComposerScheduler();
});
