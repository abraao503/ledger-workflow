import type { PrismaClient } from '@prisma/client';

import { createTestDatabase, type TestDatabase } from '../infrastructure/db/test-database.js';
import { WorkflowLedger } from './workflow-ledger.js';
import type { GitReadPort } from './types.js';

describe('task types', () => {
  let database: TestDatabase;
  let client: PrismaClient;
  let ledger: WorkflowLedger;

  beforeAll(async () => {
    database = createTestDatabase();
    client = database.client;
    const git: GitReadPort = {
      capture: async () => ({
        branch: 'main',
        sha: 'sha-1',
        dirty: false,
        changedFiles: [],
        fingerprint: 'fingerprint-1',
        contentFingerprint: 'content-1',
      }),
    };
    ledger = new WorkflowLedger(client, git);

    await ledger.createProject({
      key: 'tasks',
      name: 'Tasks',
      rootPath: '/tmp/tasks',
    });
    await ledger.addRepository({
      projectKey: 'tasks',
      key: 'app',
      path: '/tmp/tasks/app',
      expectedBranch: 'main',
    });
    await ledger.createTemplate({
      projectKey: 'tasks',
      key: 'feature-template',
      name: 'Feature template',
      definition: {
        phases: ['G0', 'G1', 'G2', 'G3'],
        slicePolicy: {
          maxUseCases: 2,
          maxRequiredCriteria: 4,
          maxTests: 3,
          maxRepositories: 1,
        },
      },
    });
  });

  afterAll(async () => {
    await database.close();
  });

  it('keeps the current FEATURE model and creates a lightweight PATCH task', async () => {
    const feature = await ledger.createFeature({
      projectKey: 'tasks',
      templateKey: 'feature-template',
      key: 'F1',
      name: 'Feature one',
      summary: 'Full feature flow',
    });
    const patch = await ledger.createPointTask({
      projectKey: 'tasks',
      key: 'P1',
      title: 'Corrigir texto',
      summary: 'Ajuste pontual no texto exibido.',
    });

    expect(feature.taskType).toBe('FEATURE');
    expect(patch.feature.taskType).toBe('PATCH');
    expect(patch.item).toMatchObject({
      key: '01',
      taskType: 'PATCH',
      state: 'READY',
      requirementsComplete: true,
      tddPolicy: 'EXEMPT',
    });
    await expect(client.useCase.count({ where: { workItemId: patch.item.id } })).resolves.toBe(0);
    await expect(client.acceptanceCriterion.count({ where: { workItemId: patch.item.id } })).resolves.toBe(0);
    await expect(client.testSpecification.count({ where: { workItemId: patch.item.id } })).resolves.toBe(0);

    const plan = await ledger.checkPlan({ projectKey: 'tasks', featureKey: 'P1' });
    expect(plan.items[0]).toMatchObject({
      status: 'OK',
      semanticStatus: 'OK',
    });
  });

  it('allows a PATCH task to skip TDD ceremony after authorization', async () => {
    const patch = await ledger.createPointTask({
      projectKey: 'tasks',
      key: 'P2',
      title: 'Atualizar rótulo',
      summary: 'Mudança pontual de apresentação.',
    });

    await ledger.authorizeWorkItem({
      projectKey: 'tasks',
      featureKey: patch.feature.key,
      itemKey: patch.item.key,
      instruction: 'Aplicar somente o ajuste descrito.',
      actor: 'human:operator',
      allowedEffects: ['código local'],
      forbiddenEffects: ['mudanças fora do escopo'],
      repositoryKeys: ['app'],
    });
    const claimed = await ledger.claimWorkItem({
      projectKey: 'tasks',
      featureKey: patch.feature.key,
      itemKey: patch.item.key,
      holder: 'agent:test',
      durationSeconds: 3_600,
    });

    const implementing = await ledger.transitionWorkItem({
      projectKey: 'tasks',
      featureKey: patch.feature.key,
      itemKey: patch.item.key,
      to: 'IMPLEMENTING',
      executionFence: claimed.lease.generation,
    });

    expect(implementing.state).toBe('IMPLEMENTING');
  });
});
