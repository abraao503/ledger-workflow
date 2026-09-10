import type { PrismaClient } from '@prisma/client';

import { WorkflowLedger } from './workflow-ledger.js';
import { createTestDatabase, type TestDatabase } from '../infrastructure/db/test-database.js';

describe('effective feature status', () => {
  let database: TestDatabase;
  let client: PrismaClient;
  let ledger: WorkflowLedger;

  beforeEach(async () => {
    database = createTestDatabase();
    client = database.client;
    ledger = new WorkflowLedger(client, {
      capture: async () => ({
        branch: 'main',
        sha: 'sha-1',
        dirty: false,
        changedFiles: [],
        fingerprint: 'fingerprint-1',
        contentFingerprint: 'content-1',
      }),
    });

    await ledger.createProject({
      key: 'effective-status',
      name: 'Effective status',
      rootPath: '/tmp/effective-status',
    });
    await ledger.createTemplate({
      projectKey: 'effective-status',
      key: 'default',
      name: 'Default',
      definition: { slicePolicy: { maxUseCases: 2, maxRequiredCriteria: 4, maxTests: 3, maxRepositories: 1 } },
    });
  });

  afterEach(async () => {
    await database.close();
  });

  const defineSimpleItem = (key: string, position: number, parentItemKey?: string) => ledger.defineWorkItem({
    projectKey: 'effective-status',
    featureKey: 'F1',
    key,
    phaseKey: 'G3',
    position,
    parentItemKey,
    title: `Item ${key}`,
    tddPolicy: 'OPTIONAL',
    useCases: [{
      key: `UC-${key}`,
      title: `Resultado ${key}`,
      actor: 'Agente',
      preconditions: 'Planejamento definido',
      trigger: 'Execução iniciada',
      expectedOutcome: `Resultado ${key} entregue`,
    }],
    criteria: [{ key: `AC-${key}`, statement: `Resultado ${key} correto`, useCaseKey: `UC-${key}` }],
    tests: [],
  });

  it('derives COMPLETED from closed leaves and excludes superseded parents', async () => {
    await ledger.createFeature({
      projectKey: 'effective-status',
      templateKey: 'default',
      key: 'F1',
      name: 'Feature com linhagem',
      summary: 'Feature para status efetivo',
    });
    const parent = await defineSimpleItem('01', 1);
    await client.workItem.update({ where: { id: parent.id }, data: { state: 'SUPERSEDED' } });
    const child = await defineSimpleItem('01a', 2, '01');
    await client.workItem.update({ where: { id: child.id }, data: { state: 'CLOSED' } });

    const result = await ledger.listFeatures('effective-status');

    expect(result.features[0]).toMatchObject({
      key: 'F1',
      executionStatus: 'COMPLETED',
      executionCounts: { totalLeaves: 1, closedLeaves: 1, openLeaves: 0 },
    });
  });

  it('returns OPEN after a new leaf is added without changing feature lifecycle', async () => {
    await ledger.createFeature({
      projectKey: 'effective-status',
      templateKey: 'default',
      key: 'F1',
      name: 'Feature reaberta',
      summary: 'Feature com novo trabalho',
    });
    const item = await defineSimpleItem('01', 1);
    await client.workItem.update({ where: { id: item.id }, data: { state: 'CLOSED' } });
    await defineSimpleItem('02', 2);

    const result = await ledger.listFeatures('effective-status');

    expect(result.features[0]).toMatchObject({
      status: 'ACTIVE',
      executionStatus: 'OPEN',
      executionCounts: { totalLeaves: 2, closedLeaves: 1, openLeaves: 1 },
    });
  });

  it('returns EMPTY for a feature without work items', async () => {
    await ledger.createFeature({
      projectKey: 'effective-status',
      templateKey: 'default',
      key: 'F1',
      name: 'Feature vazia',
      summary: 'Feature sem fatias',
    });

    const result = await ledger.listFeatures('effective-status');

    expect(result.features[0]).toMatchObject({
      executionStatus: 'EMPTY',
      executionCounts: { totalLeaves: 0, closedLeaves: 0, openLeaves: 0 },
    });
  });
});
