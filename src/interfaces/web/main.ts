import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import express from 'express';

import { createWorkflowApp } from '../../application/workflow-app.js';
import { configureDatabase } from '../../infrastructure/db/client.js';
import { createWebServer } from './api.js';

const app = createWorkflowApp();
await configureDatabase(app.db);

const server = createWebServer(app);
const isDevelopment = process.env.NODE_ENV !== 'production';
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public');

if (isDevelopment) {
  const { createServer: createViteServer } = await import('vite');
  const vite = await createViteServer({
    root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web'),
    server: { middlewareMode: true, hmr: true },
    appType: 'spa',
  });
  server.use(vite.middlewares);
} else {
  server.use(express.static(webRoot));
  server.get(/.*/, (_request, response) => {
    const indexPath = path.join(webRoot, 'index.html');
    if (!existsSync(indexPath)) {
      response.status(503).send('Frontend ainda não compilado. Execute npm run build:web.');
      return;
    }
    response.sendFile(indexPath);
  });
}

const port = Number(process.env.WORKFLOW_WEB_PORT ?? 4117);
const listener = server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`Workflow Ledger web em http://127.0.0.1:${port}\n`);
});

const shutdown = async () => {
  listener.close();
  await app.db.$disconnect();
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
