import type { PrismaClient } from '@prisma/client';

import { WorkflowLedger } from './workflow-ledger.js';
import type { GitReadPort } from './types.js';
import { createTestDatabase, type TestDatabase } from '../infrastructure/db/test-database.js';

describe('lease execution fencing', () => {
  let database: TestDatabase;
  let client: PrismaClient;
  let ledger: WorkflowLedger;
  const snapshot = {
    branch: 'main',
    sha: 'sha-1',
    dirty: false,
    changedFiles: [] as string[],
    fingerprint: 'fingerprint-1',
    contentFingerprint: 'content-1',
  };

  beforeEach(async () => {
    database = createTestDatabase();
    client = database.client;
    const git: GitReadPort = { capture: async () => snapshot };
    ledger = new WorkflowLedger(client, git);

    await ledger.createProject({
      key: 'fence',
      name: 'Lease fencing tests',
      rootPath: '/tmp/ledger-fence',
    });
    await ledger.addRepository({
      projectKey: 'fence',
      key: 'workflow',
      path: '/tmp/ledger-fence',
      expectedBranch: 'main',
    });
    await ledger.createTemplate({
      projectKey: 'fence',
      key: 'default',
      name: 'Default',
      definition: { phases: ['G3'] },
    });
    await ledger.createFeature({
      projectKey: 'fence',
      templateKey: 'default',
      key: 'F1',
      name: 'Fencing',
      summary: 'Reject stale execution writers',
    });
    await ledger.defineWorkItem({
      projectKey: 'fence',
      featureKey: 'F1',
      key: '01',
      phaseKey: 'G3',
      position: 1,
      title: 'Fenced execution',
      useCases: [{
        key: 'UC-01',
        title: 'Execute with a lease generation',
        actor: 'Agent',
        preconditions: 'The slice is claimed',
        trigger: 'A mutating execution operation starts',
        expectedOutcome: 'Only the current lease writer can mutate state',
      }],
      criteria: [{
        key: 'AC-01',
        statement: 'Stale generations are rejected',
        useCaseKey: 'UC-01',
      }],
      tests: [{
        key: 'T-01',
        name: 'rejects stale generation',
        purpose: 'GREEN',
        criterionKey: 'AC-01',
      }],
    });
    await ledger.transitionWorkItem({
      projectKey: 'fence',
      featureKey: 'F1',
      itemKey: '01',
      to: 'READY',
    });
    await ledger.authorizeWorkItem({
      projectKey: 'fence',
      featureKey: 'F1',
      itemKey: '01',
      instruction: 'Run only with the current execution fence.',
      actor: 'human:test',
      allowedEffects: ['tests'],
      forbiddenEffects: ['other projects'],
      repositoryKeys: ['workflow'],
    });
    const repository = await client.repository.findFirstOrThrow();
    await client.validationProfile.create({
      data: {
        repositoryId: repository.id,
        key: 'fence-tests',
        program: 'npm',
        argsJson: JSON.stringify(['test']),
        cwd: '.',
        parser: 'JEST',
      },
    });
  });

  afterEach(async () => {
    await database.close();
  });

  async function claim() {
    return ledger.claimWorkItem({
      projectKey: 'fence',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:executor',
      durationSeconds: 60,
    });
  }

  const validationInput = {
    projectKey: 'fence',
    featureKey: 'F1',
    itemKey: '01',
    repositoryKey: 'workflow',
    profileKey: 'fence-tests',
    purpose: 'RED' as const,
    status: 'COMPLETED' as const,
    resultKind: 'TEST_FAILURE' as const,
    exitCode: 1,
    sha: 'sha-1',
    durationMs: 1,
    summary: { redEvidenceKind: 'BEHAVIORAL' },
  };

  it('rejects missing, stale, and expired fences before execution mutations', async () => {
    const claimed = await claim();

    await expect(ledger.transitionWorkItem({
      projectKey: 'fence',
      featureKey: 'F1',
      itemKey: '01',
      to: 'TESTS_DEFINED',
    })).rejects.toMatchObject({ code: 'SLICE_EXECUTION_FENCE_REQUIRED' });

    await expect(ledger.recordValidation(validationInput)).rejects.toMatchObject({
      code: 'SLICE_EXECUTION_FENCE_REQUIRED',
    });
    await expect(ledger.recordValidation({
      ...validationInput,
      executionFence: claimed.lease.generation + 1,
    })).rejects.toMatchObject({ code: 'SLICE_FENCE_STALE' });

    await client.workItemLease.update({
      where: { id: claimed.lease.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await expect(ledger.transitionWorkItem({
      projectKey: 'fence',
      featureKey: 'F1',
      itemKey: '01',
      to: 'TESTS_DEFINED',
      executionFence: claimed.lease.generation,
    })).rejects.toMatchObject({ code: 'SLICE_LEASE_EXPIRED' });
  });

  it('allows an independent reviewer when the generation is current', async () => {
    const claimed = await claim();
    const fence = claimed.lease.generation;

    await ledger.transitionWorkItem({
      projectKey: 'fence',
      featureKey: 'F1',
      itemKey: '01',
      to: 'TESTS_DEFINED',
      executionFence: fence,
    });
    await ledger.recordValidation({ ...validationInput, executionFence: fence });
    await ledger.transitionWorkItem({
      projectKey: 'fence',
      featureKey: 'F1',
      itemKey: '01',
      to: 'RED_CONFIRMED',
      executionFence: fence,
    });
    await ledger.transitionWorkItem({
      projectKey: 'fence',
      featureKey: 'F1',
      itemKey: '01',
      to: 'IMPLEMENTING',
      executionFence: fence,
    });
    await ledger.recordValidation({
      ...validationInput,
      purpose: 'GREEN',
      status: 'COMPLETED',
      resultKind: 'PASS',
      exitCode: 0,
      summary: { fingerprint: snapshot.fingerprint, contentFingerprint: snapshot.contentFingerprint },
      executionFence: fence,
    });
    await ledger.transitionWorkItem({
      projectKey: 'fence',
      featureKey: 'F1',
      itemKey: '01',
      to: 'GREEN_CONFIRMED',
      executionFence: fence,
    });
    await ledger.transitionWorkItem({
      projectKey: 'fence',
      featureKey: 'F1',
      itemKey: '01',
      to: 'READY_FOR_REVIEW',
      executionFence: fence,
    });

    await expect(ledger.submitReview({
      projectKey: 'fence',
      featureKey: 'F1',
      itemKey: '01',
      reviewer: 'human:reviewer',
      reviewMode: 'INDEPENDENT',
      verdict: 'APPROVED',
      summary: 'Evidence is current.',
      findings: [],
    })).rejects.toMatchObject({ code: 'SLICE_EXECUTION_FENCE_REQUIRED' });

    const reviewed = await ledger.submitReview({
      projectKey: 'fence',
      featureKey: 'F1',
      itemKey: '01',
      reviewer: 'human:reviewer',
      reviewMode: 'INDEPENDENT',
      verdict: 'APPROVED',
      summary: 'Evidence is current.',
      findings: [],
      executionFence: fence,
    });
    expect(reviewed.reviewMode).toBe('INDEPENDENT');
    expect(reviewed.item.state).toBe('APPROVED');
  });

  it('requires the current fence before integration preparation', async () => {
    await claim();
    await client.workItem.updateMany({
      where: { key: '01', feature: { key: 'F1' } },
      data: { state: 'APPROVED' },
    });

    await expect(ledger.prepareIntegration({
      projectKey: 'fence',
      featureKey: 'F1',
      itemKey: '01',
    })).rejects.toMatchObject({ code: 'SLICE_EXECUTION_FENCE_REQUIRED' });
  });
});
