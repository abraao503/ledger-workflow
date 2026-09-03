import request from 'supertest';

import type { WorkflowApp } from '../../application/workflow-app.js';
import { createWebServer } from './api.js';

describe('workflow web API', () => {
  const dashboard = {
    getHealth: async () => ({
      ok: true,
      database: 'sqlite' as const,
      journalMode: 'wal',
      serverTime: new Date().toISOString(),
    }),
    getCatalog: async () => [],
    getDashboard: async () => ({
      selection: { projectKey: 'demo', featureKey: 'F1', itemKey: '01', view: 'dashboard' },
      item: { state: 'DRAFT' },
    }),
  };
  const app = {
    dashboard,
    ledger: {
      getValidationLog: async () => ({ text: 'log' }),
    },
  } as unknown as WorkflowApp;
  const server = createWebServer(app);

  it('exposes health and catalog without requiring a browser session', async () => {
    await request(server)
      .get('/api/health')
      .expect(200)
      .expect((response) => expect(response.body.journalMode).toBe('wal'));

    await request(server)
      .get('/api/catalog')
      .expect(200)
      .expect({ projects: [] });
  });

  it('rejects non-local hosts and malformed action payloads', async () => {
    await request(server)
      .get('/api/health')
      .set('Host', 'external.example')
      .expect(403)
      .expect((response) => expect(response.body.code).toBe('LOCAL_ONLY'));

    await request(server)
      .post('/api/actions')
      .send({ action: 'BLOCK' })
      .expect(400)
      .expect((response) => expect(response.body.code).toBe('INVALID_REQUEST'));
  });
});
