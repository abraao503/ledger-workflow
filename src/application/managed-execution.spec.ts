import type { PrismaClient } from '@prisma/client';

import { WorkflowLedger } from './workflow-ledger.js';
import type { GitWorkspacePort } from './types.js';
import { createTestDatabase, type TestDatabase } from '../infrastructure/db/test-database.js';

describe('managed worktree execution', () => {
  let database: TestDatabase;
  let client: PrismaClient;
  let ledger: WorkflowLedger;
  let createdWorktrees: Array<{ repositoryPath: string; worktreePath: string; branch: string; sha: string }>;
  let candidateFiles: string[];
  let rebaseChangesContent: boolean;
  let rebaseApplied = false;
  let failWorktreeCreation = false;
  let sharedDirtyFiles: string[] | null = null;

  beforeEach(async () => {
    database = createTestDatabase();
    client = database.client;
    createdWorktrees = [];
    candidateFiles = [];
    rebaseChangesContent = false;
    rebaseApplied = false;
    failWorktreeCreation = false;
    sharedDirtyFiles = null;
    const git: GitWorkspacePort = {
      capture: async (repositoryPath) => ({
        branch: createdWorktrees.find((workspace) => workspace.worktreePath === repositoryPath)?.branch ?? 'master',
        sha: 'sha-1',
        dirty: sharedDirtyFiles !== null,
        changedFiles: sharedDirtyFiles ?? [],
        fingerprint: 'fingerprint-1',
        contentFingerprint: createdWorktrees.some((workspace) => workspace.worktreePath === repositoryPath) && rebaseApplied
          ? 'content-2'
          : 'content-1',
      }),
      createWorktree: async (input) => {
        createdWorktrees.push(input);
        if (failWorktreeCreation) {
          throw new Error('worktree creation failed');
        }
      },
      removeWorktree: async () => undefined,
      deleteBranch: async () => undefined,
      rebaseWorktree: async () => {
        if (rebaseChangesContent) {
          rebaseApplied = true;
        }
      },
      getHead: async () => 'sha-2',
      diffFiles: async () => candidateFiles,
      fastForward: async () => undefined,
    };
    ledger = new WorkflowLedger(client, git);

    await ledger.createProject({
      key: 'managed',
      name: 'Managed execution tests',
      rootPath: '/tmp/ledger-managed',
    });
    await ledger.addRepository({
      projectKey: 'managed',
      key: 'app',
      path: '/tmp/ledger-managed/app',
      expectedBranch: 'master',
    });
    await ledger.createTemplate({
      projectKey: 'managed',
      key: 'default',
      name: 'Default',
      definition: { phases: ['G3'] },
    });
    await ledger.createFeature({
      projectKey: 'managed',
      templateKey: 'default',
      key: 'F1',
      name: 'Managed feature',
      summary: 'Managed execution',
    });
  });

  afterEach(async () => {
    await database.close();
  });

  async function defineItem(
    key: string,
    position: number,
    dependsOn?: { featureKey: string; itemKey: string }[],
    paths = ['src/application/**'],
  ) {
    await ledger.defineWorkItem({
      projectKey: 'managed',
      featureKey: 'F1',
      key,
      phaseKey: 'G3',
      position,
      title: `Item ${key}`,
      summary: 'A managed item',
      scope: { repositories: [{ repositoryKey: 'app', paths }] },
      dependsOn,
      useCases: [{
        key: 'UC-01',
        title: 'Execute',
        actor: 'agent',
        preconditions: 'authorized',
        trigger: 'claim',
        expectedOutcome: 'isolated worktree',
      }],
      criteria: [{ key: 'AC-01', statement: 'The worktree is isolated', useCaseKey: 'UC-01' }],
      tests: [{ key: 'T-01', name: 'managed execution', purpose: 'GREEN', criterionKey: 'AC-01' }],
    });
    await ledger.transitionWorkItem({ projectKey: 'managed', featureKey: 'F1', itemKey: key, to: 'READY' });
    await ledger.authorizeWorkItem({
      projectKey: 'managed',
      featureKey: 'F1',
      itemKey: key,
      instruction: 'Run in an isolated worktree.',
      actor: 'human:test',
      allowedEffects: ['workflow tests'],
      forbiddenEffects: ['other projects'],
      repositoryKeys: ['app'],
      executionMode: 'MANAGED_WORKTREE',
    });
  }

  it('provisions a worktree for every scoped repository on claim', async () => {
    await defineItem('01', 1);

    const claimed = await ledger.claimWorkItem({
      projectKey: 'managed',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:one',
      durationSeconds: 60,
    });

    expect(createdWorktrees).toHaveLength(1);
    expect(createdWorktrees[0]).toMatchObject({ sha: 'sha-1', branch: expect.stringContaining('workflow/managed/F1/01') });
    expect(claimed.workspaces).toEqual([
      expect.objectContaining({ repositoryId: expect.any(String), baseSha: 'sha-1' }),
    ]);
    await expect(client.workItemWorkspace.count({ where: { workItemId: claimed.item.id } })).resolves.toBe(1);
  });

  it('authorizes a managed worktree when the shared dirtiness belongs to an authorized in-flight slice', async () => {
    await defineItem('01', 1);
    sharedDirtyFiles = ['src/application/other.ts'];

    await defineItem('02', 2);

    await expect(client.authorization.count()).resolves.toBe(2);
    const snapshots = await client.repositorySnapshot.findMany({ orderBy: { capturedAt: 'asc' } });
    expect(snapshots).toHaveLength(2);
    expect(snapshots[1]).toMatchObject({ sha: 'sha-1', dirty: true });
  });

  it('refuses managed authorization when the shared dirtiness is not accounted by an authorized slice', async () => {
    await defineItem('01', 1);
    sharedDirtyFiles = ['src/unknown/path.ts'];

    await expect(defineItem('02', 2)).rejects.toMatchObject({ code: 'WORKTREE_BASELINE_DIRTY_UNACCOUNTED' });
    await expect(client.authorization.count()).resolves.toBe(1);
  });

  it('provisions a managed worktree from the documented baseline while the shared checkout is dirty', async () => {
    await defineItem('01', 1);
    sharedDirtyFiles = ['src/application/other.ts'];

    const claimed = await ledger.claimWorkItem({
      projectKey: 'managed',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:one',
    });

    expect(createdWorktrees[0]).toMatchObject({ sha: 'sha-1' });
    expect(claimed.workspaces[0]).toMatchObject({ baseSha: 'sha-1' });
  });

  it('refuses provisioning when the shared dirtiness becomes unaccounted after authorization', async () => {
    await defineItem('01', 1);
    sharedDirtyFiles = ['src/unknown/path.ts'];

    await expect(ledger.claimWorkItem({
      projectKey: 'managed',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:one',
    })).rejects.toMatchObject({ code: 'WORKTREE_BASELINE_DIRTY_UNACCOUNTED' });
    expect(createdWorktrees).toHaveLength(0);
  });

  it('persists failed provisioning for a later cleanup retry', async () => {
    await defineItem('01', 1);
    failWorktreeCreation = true;

    await expect(ledger.claimWorkItem({
      projectKey: 'managed',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:one',
    })).rejects.toThrow('worktree creation failed');

    await expect(client.workItemWorkspace.findMany({ where: { workItem: { key: '01' } } }))
      .resolves.toEqual([expect.objectContaining({ status: 'ABANDONED' })]);
  });

  it('blocks a second managed claim when declared paths overlap', async () => {
    await defineItem('01', 1);
    await defineItem('02', 2);

    await ledger.claimWorkItem({
      projectKey: 'managed',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:one',
    });

    await expect(ledger.claimWorkItem({
      projectKey: 'managed',
      featureKey: 'F1',
      itemKey: '02',
      holder: 'agent:two',
    })).rejects.toMatchObject({ code: 'WORK_ITEM_SCOPE_CONFLICT' });
  });

  it('serializes concurrent claims before checking overlapping scopes', async () => {
    await defineItem('01', 1, undefined, ['src/application/**']);
    await defineItem('02', 2, undefined, ['src/application/**']);

    const results = await Promise.allSettled([
      ledger.claimWorkItem({
        projectKey: 'managed',
        featureKey: 'F1',
        itemKey: '01',
        holder: 'agent:one',
      }),
      ledger.claimWorkItem({
        projectKey: 'managed',
        featureKey: 'F1',
        itemKey: '02',
        holder: 'agent:two',
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'WORK_ITEM_SCOPE_CONFLICT' }),
      }),
    ]);
  });

  it('blocks claim until a dependency is closed', async () => {
    await defineItem('01', 1);
    await defineItem('02', 2, [{ featureKey: 'F1', itemKey: '01' }]);

    await expect(ledger.claimWorkItem({
      projectKey: 'managed',
      featureKey: 'F1',
      itemKey: '02',
      holder: 'agent:two',
    })).rejects.toMatchObject({ code: 'WORK_ITEM_DEPENDENCIES_PENDING' });
  });

  it('requires an integration approval before a managed item can close', async () => {
    await defineItem('01', 1);
    const claimed = await ledger.claimWorkItem({
      projectKey: 'managed',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:one',
    });
    await client.workItem.update({ where: { id: claimed.item.id }, data: { state: 'APPROVED' } });

    await expect(ledger.transitionWorkItem({
      projectKey: 'managed',
      featureKey: 'F1',
      itemKey: '01',
      to: 'CLOSED',
      commitSha: 'sha-2',
    })).rejects.toMatchObject({ code: 'INTEGRATION_APPROVAL_REQUIRED' });
  });

  it('abandons and releases managed worktrees when an item is blocked', async () => {
    await defineItem('01', 1);
    const claimed = await ledger.claimWorkItem({
      projectKey: 'managed',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:one',
    });

    await ledger.transitionWorkItem({
      projectKey: 'managed',
      featureKey: 'F1',
      itemKey: '01',
      to: 'BLOCKED',
      reason: 'Bloqueio para revisão do escopo.',
    });

    await expect(client.workItemLease.findUnique({ where: { id: claimed.lease.id } }))
      .resolves.toMatchObject({ releasedAt: expect.any(Date) });
    await expect(client.workItemWorkspace.findFirst({ where: { leaseId: claimed.lease.id } }))
      .resolves.toMatchObject({ status: 'ABANDONED' });
    await expect(ledger.cleanupWorkItem({ projectKey: 'managed', featureKey: 'F1', itemKey: '01' }))
      .resolves.toEqual([expect.objectContaining({ status: 'REMOVED' })]);
  });

  it('integrates approved candidates by fast-forward and cleans the worktree', async () => {
    await defineItem('01', 1);
    const claimed = await ledger.claimWorkItem({
      projectKey: 'managed',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:one',
    });
    const repository = await client.repository.findFirstOrThrow();
    const profile = await client.validationProfile.create({
      data: {
        repositoryId: repository.id,
        key: 'managed-green',
        program: 'npm',
        argsJson: JSON.stringify(['test']),
        cwd: '.',
        parser: 'JEST',
      },
    });
    await ledger.recordValidation({
      projectKey: 'managed',
      featureKey: 'F1',
      itemKey: '01',
      repositoryKey: 'app',
      profileKey: profile.key,
      purpose: 'GREEN',
      status: 'COMPLETED',
      resultKind: 'PASS',
      exitCode: 0,
      sha: 'sha-2',
      durationMs: 10,
      summary: { contentFingerprint: 'content-1' },
    });
    await client.review.create({
      data: { workItemId: claimed.item.id, reviewer: 'human:reviewer', verdict: 'APPROVED', summary: 'ok' },
    });
    await client.workflowEvent.create({
      data: {
        projectId: claimed.item.feature.projectId,
        featureId: claimed.item.featureId,
        workItemId: claimed.item.id,
        type: 'REVIEW_SUBMITTED',
        payloadJson: JSON.stringify({ reviewMode: 'INDEPENDENT' }),
      },
    });
    await client.workItem.update({ where: { id: claimed.item.id }, data: { state: 'APPROVED' } });
    const prepared = await ledger.prepareIntegration({ projectKey: 'managed', featureKey: 'F1', itemKey: '01' });
    expect(prepared).toMatchObject({ candidates: { app: 'sha-2' }, targetBases: { app: 'sha-1' } });
    const approval = await ledger.authorizeIntegration({
      projectKey: 'managed',
      featureKey: 'F1',
      itemKey: '01',
      actor: 'human:operator',
      candidates: prepared.candidates,
      targetBases: prepared.targetBases,
    });
    const integrated = await ledger.integrateWorkItem({ projectKey: 'managed', featureKey: 'F1', itemKey: '01' });

    expect(integrated.item.state).toBe('CLOSED');
    expect(integrated.integrated).toEqual(['app']);
    expect(integrated.cleanup).toEqual([expect.objectContaining({ status: 'REMOVED' })]);
    await expect(client.workItemIntegrationApproval.findUnique({ where: { id: approval.id } }))
      .resolves.toMatchObject({ status: 'CONSUMED' });
  });

  it('rejects a candidate that changes files outside the declared scope', async () => {
    await defineItem('01', 1);
    const claimed = await ledger.claimWorkItem({
      projectKey: 'managed',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:one',
    });
    candidateFiles = ['src/other.ts'];
    await client.workItem.update({ where: { id: claimed.item.id }, data: { state: 'APPROVED' } });

    await expect(ledger.prepareIntegration({
      projectKey: 'managed',
      featureKey: 'F1',
      itemKey: '01',
    })).rejects.toMatchObject({
      code: 'WORK_ITEM_SCOPE_VIOLATION',
      details: { repositoryKey: 'app', changedFiles: ['src/other.ts'] },
    });
  });

  it('invalidates GREEN when preparing a rebase changes the candidate content', async () => {
    await defineItem('01', 1);
    await ledger.claimWorkItem({
      projectKey: 'managed',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:one',
    });
    const item = await client.workItem.findFirstOrThrow();
    await client.workItem.update({ where: { id: item.id }, data: { state: 'APPROVED' } });
    rebaseChangesContent = true;

    await expect(ledger.prepareIntegration({
      projectKey: 'managed',
      featureKey: 'F1',
      itemKey: '01',
    })).rejects.toMatchObject({ code: 'INTEGRATION_GREEN_REVALIDATION_REQUIRED' });
    await expect(client.workItem.findUnique({ where: { id: item.id } }))
      .resolves.toMatchObject({ state: 'IMPLEMENTING' });
  });

  it('abandons an expired worktree before provisioning a recovered one', async () => {
    await defineItem('01', 1);
    const claimed = await ledger.claimWorkItem({
      projectKey: 'managed',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:one',
      durationSeconds: 1,
    });
    await client.workItemLease.update({
      where: { id: claimed.lease.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    const recovered = await ledger.recoverWorkItemLease({
      projectKey: 'managed',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:two',
    });

    expect(createdWorktrees).toHaveLength(2);
    const oldWorkspace = await client.workItemWorkspace.findFirst({ where: { leaseId: claimed.lease.id } });
    expect(oldWorkspace).not.toBeNull();
    await expect(client.workItemWorkspace.findUnique({ where: { id: oldWorkspace?.id } }))
      .resolves.toMatchObject({ status: 'ABANDONED' });
    await expect(client.workItemWorkspace.findFirst({ where: { leaseId: recovered.lease.id } }))
      .resolves.toMatchObject({ status: 'ACTIVE' });
  });

  it('rejects a dependency cycle', async () => {
    await defineItem('01', 1);
    await defineItem('02', 2);

    await client.workItem.updateMany({ where: { feature: { key: 'F1' } }, data: { state: 'DRAFT' } });

    await ledger.addWorkItemDependency({
      projectKey: 'managed',
      featureKey: 'F1',
      itemKey: '01',
      dependsOn: { featureKey: 'F1', itemKey: '02' },
    });

    await expect(ledger.addWorkItemDependency({
      projectKey: 'managed',
      featureKey: 'F1',
      itemKey: '02',
      dependsOn: { featureKey: 'F1', itemKey: '01' },
    })).rejects.toMatchObject({ code: 'WORK_ITEM_DEPENDENCY_CYCLE' });
  });

  it('serializes concurrent dependency updates before checking cycles', async () => {
    await defineItem('01', 1);
    await defineItem('02', 2);
    await client.workItem.updateMany({ where: { feature: { key: 'F1' } }, data: { state: 'DRAFT' } });

    const results = await Promise.allSettled([
      ledger.addWorkItemDependency({
        projectKey: 'managed',
        featureKey: 'F1',
        itemKey: '01',
        dependsOn: { featureKey: 'F1', itemKey: '02' },
      }),
      ledger.addWorkItemDependency({
        projectKey: 'managed',
        featureKey: 'F1',
        itemKey: '02',
        dependsOn: { featureKey: 'F1', itemKey: '01' },
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'WORK_ITEM_DEPENDENCY_CYCLE' }),
      }),
    ]);
  });
});
