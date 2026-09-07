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
  const calls: Array<{ method: string; input: unknown }> = [];
  const recording = <T,>(method: string, result: () => T) => async (input: unknown): Promise<T> => {
    calls.push({ method, input });
    return result();
  };
  const ledger = {
    getValidationLog: async () => ({ text: 'log' }),
    checkPlan: recording('checkPlan', () => ({
      policy: { maxUseCases: 3, maxRequiredCriteria: 9, maxTests: 4 },
      summary: { total: 1, ok: 0 },
      items: [{ key: '01', status: 'SPLIT_RECOMMENDED' }],
    })),
    requestSliceSizeException: recording('requestSliceSizeException', () => ({ pending: { key: 'SLICE-SIZE-REQUEST-F1-01' } })),
    approveSliceSize: recording('approveSliceSize', () => ({ decision: { id: 'decision-1' } })),
    replanWorkItem: recording('replanWorkItem', () => ({ item: { key: '02', state: 'DRAFT' } })),
  };
  const app = {
    dashboard,
    ledger,
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

  it('serves the planning audit report', async () => {
    await request(server)
      .get('/api/plan-check?projectKey=demo&featureKey=F1')
      .expect(200)
      .expect((response) => {
        expect(response.body.summary).toEqual({ total: 1, ok: 0 });
        expect(response.body.items[0].status).toBe('SPLIT_RECOMMENDED');
      });
    expect(calls).toEqual(expect.arrayContaining([
      { method: 'checkPlan', input: { projectKey: 'demo', featureKey: 'F1' } },
    ]));
  });

  it('dispatches size exception, approval and replanning actions', async () => {
    calls.length = 0;
    await request(server)
      .post('/api/actions')
      .send({
        action: 'REQUEST_SIZE_EXCEPTION',
        projectKey: 'demo', featureKey: 'F1', itemKey: '01',
        actor: 'agent:codex', reason: 'Resultado indivisível',
      })
      .expect(200)
      .expect((response) => expect(response.body.result.pending.key).toBe('SLICE-SIZE-REQUEST-F1-01'));
    expect(calls).toEqual(expect.arrayContaining([
      {
        method: 'requestSliceSizeException',
        input: { projectKey: 'demo', featureKey: 'F1', itemKey: '01', actor: 'agent:codex', reason: 'Resultado indivisível' },
      },
    ]));

    await request(server)
      .post('/api/actions')
      .send({
        action: 'APPROVE_SIZE',
        projectKey: 'demo', featureKey: 'F1', itemKey: '01',
        actor: 'human:owner', reason: 'Escopo justificado',
      })
      .expect(200)
      .expect((response) => expect(response.body.result.decision.id).toBe('decision-1'));
    expect(calls.at(-1)).toEqual({
      method: 'approveSliceSize',
      input: { projectKey: 'demo', featureKey: 'F1', itemKey: '01', actor: 'human:owner', reason: 'Escopo justificado' },
    });

    await request(server)
      .post('/api/actions')
      .send({
        action: 'REPLAN',
        projectKey: 'demo', featureKey: 'F1', itemKey: '01',
        actor: 'human:owner', reason: 'Separar resultado B',
      })
      .expect(200)
      .expect((response) => expect(response.body.result.item.key).toBe('02'));
    expect(calls.at(-1)).toEqual({
      method: 'replanWorkItem',
      input: { projectKey: 'demo', featureKey: 'F1', itemKey: '01', actor: 'human:owner', reason: 'Separar resultado B' },
    });

    await request(server)
      .post('/api/actions')
      .send({ action: 'APPROVE_SIZE', projectKey: 'demo', featureKey: 'F1', itemKey: '01' })
      .expect(400)
      .expect((response) => expect(response.body.code).toBe('FIELD_REQUIRED'));
    expect(calls.at(-1)?.method).toBe('replanWorkItem');
  });
});
