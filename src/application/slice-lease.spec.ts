import type { PrismaClient } from '@prisma/client';

import { WorkflowLedger } from './workflow-ledger.js';
import type { GitReadPort } from './types.js';
import { createTestDatabase, type TestDatabase } from '../infrastructure/db/test-database.js';

describe('slice leases', () => {
  let database: TestDatabase;
  let client: PrismaClient;
  let ledger: WorkflowLedger;

  beforeEach(async () => {
    database = createTestDatabase();
    client = database.client;
    const git: GitReadPort = {
      capture: async () => ({
        branch: 'master',
        sha: 'sha-1',
        dirty: false,
        changedFiles: [],
        fingerprint: 'fingerprint-1',
        contentFingerprint: 'content-1',
      }),
    };
    ledger = new WorkflowLedger(client, git);

    await ledger.createProject({
      key: 'leases',
      name: 'Lease tests',
      rootPath: '/tmp/ledger-leases',
    });
    await ledger.addRepository({
      projectKey: 'leases',
      key: 'workflow',
      path: '/tmp/ledger-leases',
      expectedBranch: 'master',
    });
    await ledger.createTemplate({
      projectKey: 'leases',
      key: 'default',
      name: 'Default',
      definition: { phases: ['G3'] },
    });
    await ledger.createFeature({
      projectKey: 'leases',
      templateKey: 'default',
      key: 'F1',
      name: 'Lease feature',
      summary: 'Exclusive slice execution',
    });
    await ledger.defineWorkItem({
      projectKey: 'leases',
      featureKey: 'F1',
      key: '01',
      phaseKey: 'G3',
      position: 1,
      title: 'Reservable slice',
      summary: 'A slice that can be claimed by one agent.',
      useCases: [{
        key: 'UC-01',
        title: 'Claim a slice',
        actor: 'Agent',
        preconditions: 'The slice is ready',
        trigger: 'Execution starts',
        expectedOutcome: 'The slice belongs to one agent',
      }],
      criteria: [{
        key: 'AC-01',
        statement: 'Only one active claim is allowed',
        useCaseKey: 'UC-01',
      }],
      tests: [{
        key: 'T-01',
        name: 'exclusive claim',
        purpose: 'GREEN',
        criterionKey: 'AC-01',
      }],
    });
    await ledger.transitionWorkItem({
      projectKey: 'leases',
      featureKey: 'F1',
      itemKey: '01',
      to: 'READY',
    });
    await ledger.authorizeWorkItem({
      projectKey: 'leases',
      featureKey: 'F1',
      itemKey: '01',
      instruction: 'Authorize exclusive slice claim.',
      actor: 'human:test',
      allowedEffects: ['tests'],
      forbiddenEffects: ['other projects'],
      repositoryKeys: ['workflow'],
    });
  });

  afterEach(async () => {
    await database.close();
  });

  it('claims an authorized slice once and rejects a competing holder', async () => {
    const claimed = await ledger.claimWorkItem({
      projectKey: 'leases',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:one',
      durationSeconds: 60,
    });

    expect(claimed.lease).toMatchObject({
      holder: 'agent:one',
      releasedAt: null,
    });
    expect(claimed.lease.expiresAt.getTime()).toBeGreaterThan(Date.now());

    await expect(ledger.claimWorkItem({
      projectKey: 'leases',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:two',
      durationSeconds: 60,
    })).rejects.toMatchObject({ code: 'SLICE_ALREADY_RESERVED' });

    await expect(client.workItemLease.findMany({
      where: { workItem: { key: '01', feature: { key: 'F1' } } },
    })).resolves.toHaveLength(1);
    await expect(client.workflowEvent.findFirst({
      where: { type: 'SLICE_LEASE_ACQUIRED' },
    })).resolves.toMatchObject({
      payloadJson: expect.stringContaining('agent:one'),
    });
  });

  it('rejects early recovery and replaces an expired lease with lineage', async () => {
    const claimed = await ledger.claimWorkItem({
      projectKey: 'leases',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:one',
      durationSeconds: 60,
    });

    await expect(ledger.recoverWorkItemLease({
      projectKey: 'leases',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:two',
      durationSeconds: 60,
    })).rejects.toMatchObject({ code: 'SLICE_RESERVATION_NOT_EXPIRED' });

    await client.workItemLease.update({
      where: { id: claimed.lease.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const recovered = await ledger.recoverWorkItemLease({
      projectKey: 'leases',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:two',
      durationSeconds: 60,
    });

    expect(recovered.previousLease).toMatchObject({
      id: claimed.lease.id,
      holder: 'agent:one',
    });
    expect(recovered.lease).toMatchObject({
      holder: 'agent:two',
      recoveredFromId: claimed.lease.id,
      releasedAt: null,
    });
    expect(await client.workItemLease.count()).toBe(2);
    await expect(ledger.recoverWorkItemLease({
      projectKey: 'leases',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:three',
      durationSeconds: 60,
    })).rejects.toMatchObject({ code: 'SLICE_RESERVATION_NOT_EXPIRED' });
    await expect(client.workflowEvent.findFirst({
      where: { type: 'SLICE_LEASE_RECOVERED' },
    })).resolves.toMatchObject({
      payloadJson: expect.stringContaining('agent:two'),
    });
  });
});
