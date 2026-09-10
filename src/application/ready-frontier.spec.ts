import type { PrismaClient } from '@prisma/client';

import { WorkflowLedger } from './workflow-ledger.js';
import type { GitReadPort } from './types.js';
import { createTestDatabase, type TestDatabase } from '../infrastructure/db/test-database.js';

describe('ready frontier', () => {
  let database: TestDatabase;
  let client: PrismaClient;
  let ledger: WorkflowLedger;

  beforeEach(async () => {
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
      key: 'frontier',
      name: 'Ready frontier',
      rootPath: '/tmp/ledger-frontier',
    });
    await ledger.addRepository({
      projectKey: 'frontier',
      key: 'workflow',
      path: '/tmp/ledger-frontier',
      expectedBranch: 'main',
    });
    await ledger.createTemplate({
      projectKey: 'frontier',
      key: 'default',
      name: 'Default',
      definition: { phases: ['G3'] },
    });
    await ledger.createFeature({
      projectKey: 'frontier',
      templateKey: 'default',
      key: 'F1',
      name: 'Actionability',
      summary: 'Ready frontier classification',
    });
  });

  afterEach(async () => {
    await database.close();
  });

  it('returns only leaves and classifies human, dependency, lease and block states', async () => {
    const feature = await client.feature.findFirstOrThrow({ where: { key: 'F1' } });
    const createItem = (key: string, state: string, position: number, parentItemId?: string) => client.workItem.create({
      data: {
        featureId: feature.id,
        key,
        phaseKey: 'G3',
        position,
        title: `Item ${key}`,
        state,
        requirementsComplete: true,
        tddPolicy: 'REQUIRED',
        parentItemId,
      },
    });

    const parent = await createItem('01', 'AUTHORIZED', 1);
    await createItem('01a', 'DRAFT', 2, parent.id);
    const dependency = await createItem('dep', 'DRAFT', 3);
    const waiting = await createItem('02', 'AUTHORIZED', 4);
    const actionable = await createItem('03', 'AUTHORIZED', 5);
    const leased = await createItem('04', 'IMPLEMENTING', 6);
    await createItem('05', 'BLOCKED', 7);
    await createItem('06', 'SUPERSEDED', 8);
    await createItem('07', 'CLOSED', 9);
    await client.workItemDependency.create({
      data: { workItemId: waiting.id, dependsOnItemId: dependency.id },
    });
    const lease = await client.workItemLease.create({
      data: {
        workItemId: leased.id,
        holder: 'agent:leased',
        generation: 3,
        acquiredAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    const frontier = await ledger.getReadyFrontier({ projectKey: 'frontier', featureKey: 'F1' });
    const items = frontier.features[0]?.items ?? [];
    const byKey = new Map(items.map((item) => [item.itemKey, item]));

    expect(byKey.has('01')).toBe(false);
    expect(byKey.has('06')).toBe(false);
    expect(byKey.has('07')).toBe(false);
    expect(byKey.get('01a')).toMatchObject({ kind: 'WAITING_HUMAN' });
    expect(byKey.get('02')).toMatchObject({
      kind: 'WAITING_DEPENDENCY',
      dependencies: [{ itemKey: 'dep', state: 'DRAFT' }],
    });
    expect(byKey.get('03')).toMatchObject({ kind: 'ACTIONABLE' });
    expect(byKey.get('04')).toMatchObject({
      kind: 'LEASE_ACTIVE',
      lease: { holder: 'agent:leased', generation: 3, expired: false },
    });
    expect(byKey.get('05')).toMatchObject({ kind: 'BLOCKED' });
    expect(byKey.get('04')?.command).toContain('--fence 3');
    expect(lease.generation).toBe(3);
  });
});
