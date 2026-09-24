import type { PrismaClient } from '@prisma/client';

import { createTestDatabase, type TestDatabase } from '../infrastructure/db/test-database.js';
import type { GitReadPort, GitWorkspacePort } from './types.js';
import { QuickChangeService } from './quick-changes.js';
import { WorkflowLedger } from './workflow-ledger.js';

describe('quick changes', () => {
  let database: TestDatabase;
  let client: PrismaClient;
  let service: QuickChangeService;
  let ledger: WorkflowLedger;
  let snapshot = {
    branch: 'main',
    sha: 'base-sha',
    dirty: false,
    changedFiles: [] as string[],
    fingerprint: 'base-fingerprint',
    contentFingerprint: 'base-content',
  };
  let diffFiles = ['src/components/Card.tsx'];

  beforeEach(async () => {
    database = createTestDatabase();
    client = database.client;
    snapshot = {
      branch: 'main',
      sha: 'base-sha',
      dirty: false,
      changedFiles: [],
      fingerprint: 'base-fingerprint',
      contentFingerprint: 'base-content',
    };
    diffFiles = ['src/components/Card.tsx'];
    const git: GitReadPort & Pick<GitWorkspacePort, 'diffFiles'> = {
      capture: async () => snapshot,
      diffFiles: async () => diffFiles,
    };
    service = new QuickChangeService(client, git);
    ledger = new WorkflowLedger(client, git);
    await ledger.createProject({ key: 'quick', name: 'Quick', rootPath: '/tmp/quick' });
    await ledger.addRepository({
      projectKey: 'quick', key: 'front', path: '/tmp/quick/front', expectedBranch: 'main',
    });
  });

  afterEach(async () => {
    await database.close();
  });

  const startInput = {
    projectKey: 'quick',
    key: 'Q-01',
    title: 'Ocultar card',
    summary: 'Mostrar o card somente para gestores usando a permissão existente.',
    requestedBy: 'human:owner',
    eligibilityReason: 'Mudança localizada, reversível e sem alteração de autorização.',
    repositoryKey: 'front',
    paths: ['src/components/Card.tsx'],
    riskTags: ['FRONTEND', 'ROLE_VISIBILITY'] as const,
    guardReference: 'canManageWorkspace',
  };

  it('opens and closes a quick change without creating a feature or work item', async () => {
    const opened = await service.start(startInput);
    expect(opened).toMatchObject({
      key: 'Q-01', status: 'OPEN', requestedBy: 'human:owner',
      repositoryKey: 'front', paths: ['src/components/Card.tsx'],
    });

    snapshot = {
      ...snapshot,
      sha: 'commit-sha',
      fingerprint: 'commit-fingerprint',
      contentFingerprint: 'commit-content',
    };
    const closed = await service.finish({
      projectKey: 'quick',
      key: 'Q-01',
      completedBy: 'agent:codex',
      verificationKind: 'COMMAND',
      verificationSummary: 'Teste direcionado por role passou.',
    });

    expect(closed).toMatchObject({
      status: 'CLOSED', commitSha: 'commit-sha',
      changedFiles: ['src/components/Card.tsx'],
      verification: { kind: 'COMMAND' },
    });
    await expect(client.feature.count()).resolves.toBe(0);
    await expect(client.workItem.count()).resolves.toBe(0);
  });

  it('requires human authorization and an existing guard for role visibility', async () => {
    await expect(service.start({
      ...startInput,
      key: 'Q-AGENT',
      requestedBy: 'agent:codex',
    })).rejects.toMatchObject({ code: 'QUICK_CHANGE_HUMAN_AUTHORIZATION_REQUIRED' });

    await expect(service.start({
      ...startInput,
      key: 'Q-NO-GUARD',
      guardReference: undefined,
    })).rejects.toMatchObject({ code: 'QUICK_CHANGE_GUARD_REFERENCE_REQUIRED' });
  });

  it('rejects governed risks and promotes an expanded diff instead of closing it', async () => {
    await expect(service.start({
      ...startInput,
      key: 'Q-AUTH',
      riskTags: ['AUTHORIZATION'],
      guardReference: undefined,
    })).rejects.toMatchObject({ code: 'QUICK_CHANGE_REQUIRES_GOVERNED_FLOW' });

    await service.start(startInput);
    snapshot = { ...snapshot, sha: 'expanded-commit', fingerprint: 'expanded' };
    diffFiles = ['src/components/Card.tsx', 'src/services/access.ts'];
    await expect(service.finish({
      projectKey: 'quick', key: 'Q-01', completedBy: 'agent:codex',
      verificationKind: 'DIFF', verificationSummary: 'Diff conferido.',
    })).rejects.toMatchObject({
      code: 'QUICK_CHANGE_REQUIRES_PROMOTION',
      details: { changedFiles: ['src/services/access.ts'] },
    });
  });

  it('links an open quick change to an existing governed PATCH', async () => {
    await service.start({ ...startInput, riskTags: ['FRONTEND'] });
    await ledger.createPointTask({
      projectKey: 'quick', key: 'PATCH-Q-01', title: 'Mudança ampliada',
      summary: 'Executar a mudança pelo fluxo governado.',
    });

    const promoted = await service.promote({
      projectKey: 'quick', key: 'Q-01', patchKey: 'PATCH-Q-01',
      actor: 'agent:codex', reason: 'O diff passou a alterar a regra de acesso.',
    });
    expect(promoted).toMatchObject({ status: 'PROMOTED', promotedTaskKey: 'PATCH-Q-01' });
  });
});
