import type { PrismaClient } from '@prisma/client';

import { WorkflowLedger } from './workflow-ledger.js';
import type { GitReadPort } from './types.js';
import { createTestDatabase, type TestDatabase } from '../infrastructure/db/test-database.js';

describe('lease renewal and reconciliation', () => {
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
      key: 'lease-cycles',
      name: 'Lease cycles',
      rootPath: '/tmp/ledger-cycles',
    });
    await ledger.addRepository({
      projectKey: 'lease-cycles',
      key: 'workflow',
      path: '/tmp/ledger-cycles',
      expectedBranch: 'main',
    });
    await ledger.createTemplate({
      projectKey: 'lease-cycles',
      key: 'default',
      name: 'Default',
      definition: { phases: ['G3'] },
    });
    await ledger.createFeature({
      projectKey: 'lease-cycles',
      templateKey: 'default',
      key: 'F1',
      name: 'Lease cycles',
      summary: 'Renew and reconcile leases safely',
    });
    await ledger.defineWorkItem({
      projectKey: 'lease-cycles',
      featureKey: 'F1',
      key: '01',
      phaseKey: 'G3',
      position: 1,
      title: 'Lease cycle',
      useCases: [{
        key: 'UC-01',
        title: 'Keep one execution lease safe',
        actor: 'Agent',
        preconditions: 'The slice is authorized',
        trigger: 'The lease is renewed or expires',
        expectedOutcome: 'Only current leases remain active',
      }],
      criteria: [{
        key: 'AC-01',
        statement: 'Lease lifecycle is idempotent',
        useCaseKey: 'UC-01',
      }],
      tests: [{
        key: 'T-01',
        name: 'renews and reconciles leases',
        purpose: 'GREEN',
        criterionKey: 'AC-01',
      }],
    });
    await ledger.transitionWorkItem({
      projectKey: 'lease-cycles',
      featureKey: 'F1',
      itemKey: '01',
      to: 'READY',
    });
    await ledger.authorizeWorkItem({
      projectKey: 'lease-cycles',
      featureKey: 'F1',
      itemKey: '01',
      instruction: 'Use renew, release and reconcile with a current fence.',
      actor: 'human:test',
      allowedEffects: ['tests'],
      forbiddenEffects: ['other projects'],
      repositoryKeys: ['workflow'],
    });
  });

  afterEach(async () => {
    await database.close();
  });

  async function claim(holder = 'agent:one', durationSeconds = 60) {
    return ledger.claimWorkItem({
      projectKey: 'lease-cycles',
      featureKey: 'F1',
      itemKey: '01',
      holder,
      durationSeconds,
    });
  }

  it('renews only with holder and current fence', async () => {
    const claimed = await claim('agent:one', 10);
    const before = claimed.lease.expiresAt.getTime();

    await expect(ledger.renewWorkItemLease({
      projectKey: 'lease-cycles',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:one',
    })).rejects.toMatchObject({ code: 'SLICE_EXECUTION_FENCE_REQUIRED' });
    await expect(ledger.renewWorkItemLease({
      projectKey: 'lease-cycles',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:one',
      executionFence: claimed.lease.generation + 1,
    })).rejects.toMatchObject({ code: 'SLICE_FENCE_STALE' });
    await expect(ledger.renewWorkItemLease({
      projectKey: 'lease-cycles',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:two',
      executionFence: claimed.lease.generation,
    })).rejects.toMatchObject({ code: 'SLICE_LEASE_HOLDER_MISMATCH' });

    const renewed = await ledger.renewWorkItemLease({
      projectKey: 'lease-cycles',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:one',
      executionFence: claimed.lease.generation,
      durationSeconds: 120,
    });
    expect(renewed.lease.expiresAt.getTime()).toBeGreaterThan(before);
    expect(renewed.lease.lastRenewedAt).toEqual(expect.any(Date));
    await expect(client.workflowEvent.findFirst({ where: { type: 'SLICE_LEASE_RENEWED' } }))
      .resolves.toMatchObject({ payloadJson: expect.stringContaining('"generation":1') });
  });

  it('releases a lease once and records the explicit reason', async () => {
    const claimed = await claim();

    await expect(ledger.releaseWorkItemLease({
      projectKey: 'lease-cycles',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:two',
      executionFence: claimed.lease.generation,
    })).rejects.toMatchObject({ code: 'SLICE_LEASE_HOLDER_MISMATCH' });

    const released = await ledger.releaseWorkItemLease({
      projectKey: 'lease-cycles',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:one',
      executionFence: claimed.lease.generation,
      reason: 'handoff',
    });
    expect(released.lease).toMatchObject({ releasedAt: expect.any(Date), endReason: 'handoff' });
    await expect(ledger.releaseWorkItemLease({
      projectKey: 'lease-cycles',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:one',
      executionFence: claimed.lease.generation,
    })).rejects.toMatchObject({ code: 'SLICE_CLAIM_REQUIRED' });
  });

  it('reconciles an expired lease and is idempotent, then recovers with a higher generation', async () => {
    const claimed = await claim('agent:one', 60);
    const repository = await client.repository.findFirstOrThrow();
    const expiredAt = new Date(Date.now() - 1_000);
    await client.workItemLease.update({
      where: { id: claimed.lease.id },
      data: { expiresAt: expiredAt },
    });
    const recovered = await ledger.recoverWorkItemLease({
      projectKey: 'lease-cycles',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:two',
      durationSeconds: 60,
    });
    expect(recovered.lease.generation).toBe(2);
    expect(recovered.previousLease).toMatchObject({ endReason: 'RECOVERED' });

    await client.workItemWorkspace.create({
      data: {
        workItemId: recovered.item.id,
        leaseId: recovered.lease.id,
        repositoryId: repository.id,
        path: '/tmp/ledger-cycles-worktree',
        branch: 'agent-two',
        baseSha: 'sha-1',
        status: 'ACTIVE',
      },
    });
    const now = new Date();
    await client.workItemLease.update({
      where: { id: recovered.lease.id },
      data: { expiresAt: new Date(now.getTime() - 1_000) },
    });

    await expect(ledger.reconcileWorkItemLeases({
      projectKey: 'lease-cycles',
      featureKey: 'F1',
      itemKey: '01',
    }, now)).resolves.toMatchObject({ reconciled: 1 });
    await expect(client.workItemWorkspace.findFirst({ where: { leaseId: recovered.lease.id } }))
      .resolves.toMatchObject({ status: 'ABANDONED' });
    await expect(ledger.reconcileWorkItemLeases({ projectKey: 'lease-cycles' }, now))
      .resolves.toMatchObject({ reconciled: 0 });

  });
});
