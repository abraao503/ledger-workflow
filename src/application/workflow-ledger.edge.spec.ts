import type { PrismaClient } from '@prisma/client';

import type { DefineWorkItemInput, GitReadPort } from './types.js';
import { WorkflowLedger } from './workflow-ledger.js';
import { createTestDatabase, type TestDatabase } from '../infrastructure/db/test-database.js';

describe('WorkflowLedger edge cases', () => {
  let database: TestDatabase;
  let client: PrismaClient;
  let ledger: WorkflowLedger;
  let snapshot: {
    branch: string;
    sha: string;
    dirty: boolean;
    changedFiles: string[];
    fingerprint: string;
  };

  beforeAll(async () => {
    database = createTestDatabase();
    client = database.client;
    snapshot = {
      branch: 'dev', sha: 'sha-1', dirty: false, changedFiles: [], fingerprint: 'fingerprint-1',
    };
    const git: GitReadPort = { capture: async () => snapshot };
    ledger = new WorkflowLedger(client, git);

    await ledger.createProject({
      key: 'edge',
      name: 'Edge cases',
      rootPath: '/tmp/ledger-edge',
    });
    await ledger.addRepository({
      projectKey: 'edge',
      key: 'api',
      path: '/tmp/ledger-edge/api',
      expectedBranch: 'dev',
    });
    await ledger.addRepository({
      projectKey: 'edge',
      key: 'planning',
      path: '/tmp/ledger-edge',
    });
    await ledger.createTemplate({
      projectKey: 'edge',
      key: 'default',
      name: 'Default',
      definition: { phases: ['G0', 'G1'] },
    });
    await ledger.createFeature({
      projectKey: 'edge',
      templateKey: 'default',
      key: 'F1',
      name: 'Edge feature',
      summary: 'Edge cases',
    });

    for (const itemKey of [
      'dirty',
      'branch',
      'duplicate',
      'empty',
      'review',
      'review-changes',
      'review-blocked',
    ]) {
      await defineReadyItem(itemKey);
    }
  });

  afterAll(async () => {
    await database.close();
  });

  it('rejects a repository outside the project root and accepts the root itself', async () => {
    await expect(ledger.addRepository({
      projectKey: 'edge',
      key: 'outside',
      path: '/tmp/outside',
    })).rejects.toMatchObject({ code: 'REPOSITORY_PATH_INVALID' });

    const planning = await client.repository.findFirstOrThrow({ where: { key: 'planning' } });
    expect(planning.path).toBe('/tmp/ledger-edge');
  });

  it('refuses authorization with a dirty baseline', async () => {
    snapshot = {
      branch: 'dev', sha: 'sha-1', dirty: true, changedFiles: ['src/changed.ts'], fingerprint: 'fingerprint-dirty',
    };

    await expect(authorize('dirty')).rejects.toMatchObject({ code: 'DIRTY_BASELINE' });
    expect(await client.authorization.count()).toBe(0);
    snapshot = {
      branch: 'dev', sha: 'sha-1', dirty: false, changedFiles: [], fingerprint: 'fingerprint-1',
    };
  });

  it('refuses an unexpected branch, duplicate repository keys and an empty baseline', async () => {
    snapshot = {
      branch: 'feature', sha: 'sha-1', dirty: false, changedFiles: [], fingerprint: 'fingerprint-branch',
    };
    await expect(authorize('branch')).rejects.toMatchObject({ code: 'EXPECTED_BRANCH_MISMATCH' });
    snapshot = {
      branch: 'dev', sha: 'sha-1', dirty: false, changedFiles: [], fingerprint: 'fingerprint-1',
    };

    await expect(authorize('duplicate', ['api', 'api']))
      .rejects.toMatchObject({ code: 'BASELINE_REPOSITORY_DUPLICATE' });
    await expect(authorize('empty', [])).rejects.toMatchObject({
      code: 'BASELINE_REPOSITORY_REQUIRED',
    });
  });

  it('does not allow a review before the item is ready for review', async () => {
    await expect(ledger.submitReview({
      projectKey: 'edge',
      featureKey: 'F1',
      itemKey: 'review',
      reviewer: 'reviewer',
      verdict: 'APPROVED',
      summary: 'prematuro',
      findings: [],
    })).rejects.toMatchObject({ code: 'REVIEW_STATE_INVALID' });
  });

  it.each([
    ['review-changes', 'CHANGES_REQUIRED', 'CHANGES_REQUIRED'],
    ['review-blocked', 'BLOCKED', 'BLOCKED'],
  ] as const)('applies a %s review verdict without a second transition', async (
    itemKey,
    verdict,
    expectedState,
  ) => {
    await client.workItem.updateMany({
      where: { key: itemKey, feature: { key: 'F1' } },
      data: { state: 'READY_FOR_REVIEW' },
    });

    const result = await ledger.submitReview({
      projectKey: 'edge',
      featureKey: 'F1',
      itemKey,
      reviewer: 'fresh-reviewer',
      reviewMode: 'INDEPENDENT',
      verdict,
      summary: `veredito ${verdict}`,
      findings: verdict === 'CHANGES_REQUIRED'
        ? [{
            severity: 'MEDIUM',
            location: 'src/example.ts:1',
            evidence: 'regra ausente',
            risk: 'comportamento incompleto',
            correction: 'implementar regra',
            testNeeded: 'caminho negativo',
          }]
        : [],
    });

    expect(result).toMatchObject({
      reviewMode: 'INDEPENDENT',
      item: { state: expectedState },
    });
  });

  it('reopens a blocked item at its previous state and records the operator', async () => {
    const reopened = await ledger.reopenWorkItem({
      projectKey: 'edge',
      featureKey: 'F1',
      itemKey: 'review-blocked',
      actor: 'operator',
      reason: 'correção aplicada no branch isolado',
    });

    expect(reopened.state).toBe('READY_FOR_REVIEW');
    const event = await client.workflowEvent.findFirstOrThrow({
      where: { workItemId: reopened.id, type: 'ITEM_REOPENED' },
      orderBy: { createdAt: 'desc' },
    });
    expect(event.payloadJson).toContain('operator');
  });

  it('rejects unsafe or out-of-range validation profiles', async () => {
    await expect(ledger.createValidationProfile({
      projectKey: 'edge',
      repositoryKey: 'api',
      key: 'shell',
      program: 'sh',
      args: [],
      parser: 'GENERIC',
    })).rejects.toMatchObject({ code: 'VALIDATION_PROGRAM_NOT_ALLOWED' });
    await expect(ledger.createValidationProfile({
      projectKey: 'edge',
      repositoryKey: 'api',
      key: 'escape',
      program: 'npm',
      args: [],
      cwd: '../outside',
      parser: 'JEST',
    })).rejects.toMatchObject({ code: 'VALIDATION_CWD_INVALID' });
    await expect(ledger.createValidationProfile({
      projectKey: 'edge',
      repositoryKey: 'api',
      key: 'timeout',
      program: 'npm',
      args: [],
      parser: 'JEST',
      timeoutSeconds: 0,
    })).rejects.toMatchObject({ code: 'VALIDATION_TIMEOUT_INVALID' });
    await expect(ledger.createValidationProfile({
      projectKey: 'edge',
      repositoryKey: 'api',
      key: 'output',
      program: 'npm',
      args: [],
      parser: 'JEST',
      maxOutputBytes: 1_023,
    })).rejects.toMatchObject({ code: 'VALIDATION_OUTPUT_LIMIT_INVALID' });
  });

  it('rejects duplicate or dangling requirement references before persisting an item', async () => {
    const duplicateUseCase = definition('duplicate-use-case');
    duplicateUseCase.useCases = [duplicateUseCase.useCases[0], duplicateUseCase.useCases[0]];
    await expect(ledger.defineWorkItem(duplicateUseCase)).rejects.toMatchObject({
      code: 'DUPLICATE_USE_CASE_KEY',
    });

    const duplicateCriterion = definition('duplicate-criterion');
    duplicateCriterion.criteria = [duplicateCriterion.criteria[0], duplicateCriterion.criteria[0]];
    await expect(ledger.defineWorkItem(duplicateCriterion)).rejects.toMatchObject({
      code: 'DUPLICATE_CRITERION_KEY',
    });

    const missingUseCase = definition('missing-use-case');
    missingUseCase.criteria[0].useCaseKey = 'missing';
    await expect(ledger.defineWorkItem(missingUseCase)).rejects.toMatchObject({
      code: 'CRITERION_USE_CASE_NOT_FOUND',
    });

    const missingCriterion = definition('missing-criterion');
    missingCriterion.tests[0].criterionKey = 'missing';
    await expect(ledger.defineWorkItem(missingCriterion)).rejects.toMatchObject({
      code: 'TEST_CRITERION_NOT_FOUND',
    });
  });

  it('requires tests for coding items but allows a documentation item without TDD tests', async () => {
    const coding = definition('coding-without-tests');
    coding.tests = [];
    await ledger.defineWorkItem(coding);
    await expect(ledger.transitionWorkItem({
      projectKey: 'edge',
      featureKey: 'F1',
      itemKey: 'coding-without-tests',
      to: 'READY',
    })).rejects.toMatchObject({ code: 'REQUIREMENTS_INCOMPLETE' });

    const documentation = definition('documentation-without-tests');
    documentation.kind = 'DOCUMENTATION';
    documentation.tddPolicy = 'OPTIONAL';
    documentation.tests = [];
    await ledger.defineWorkItem(documentation);
    await expect(ledger.transitionWorkItem({
      projectKey: 'edge',
      featureKey: 'F1',
      itemKey: 'documentation-without-tests',
      to: 'READY',
    })).resolves.toMatchObject({ state: 'READY' });
  });

  it('keeps summaries while compacting only old closed details', async () => {
    for (const itemKey of ['dirty', 'branch', 'duplicate']) {
      await client.workItem.updateMany({
        where: { key: itemKey, feature: { key: 'F1' } },
        data: { state: 'CLOSED' },
      });
    }

    const result = await ledger.compactHistory({
      projectKey: 'edge',
      featureKey: 'F1',
      activeItemKey: 'review',
      keepRecent: 1,
    });

    expect(result.compact).toEqual(['dirty', 'branch']);
    expect(result.keepDetailed).toEqual([
      'review-changes',
      'review-blocked',
      'duplicate',
      'empty',
      'review',
      'coding-without-tests',
      'documentation-without-tests',
    ]);
    expect(await client.historySummary.findUnique({
      where: { projectId_scopeKey: {
        projectId: (await client.project.findUniqueOrThrow({ where: { key: 'edge' } })).id,
        scopeKey: 'F1:dirty',
      } },
    })).not.toBeNull();
    expect(await client.useCase.count({
      where: { workItem: { key: 'dirty', feature: { key: 'F1' } } },
    })).toBe(0);
    expect(await client.useCase.count({
      where: { workItem: { key: 'duplicate', feature: { key: 'F1' } } },
    })).toBe(1);
  });

  it('expires raw validation logs without exposing them in the detailed record', async () => {
    await ledger.createValidationProfile({
      projectKey: 'edge',
      repositoryKey: 'api',
      key: 'retention',
      program: 'npm',
      args: ['test'],
      parser: 'GENERIC',
    });
    const validation = await ledger.recordValidation({
      projectKey: 'edge',
      featureKey: 'F1',
      itemKey: 'review',
      repositoryKey: 'api',
      profileKey: 'retention',
      purpose: 'CHECK',
      status: 'COMPLETED',
      resultKind: 'PASS',
      exitCode: 0,
      sha: 'sha-1',
      durationMs: 10,
      summary: { visible: true },
      log: 'raw log must stay out of context',
    });
    const record = await ledger.getRecord({
      projectKey: 'edge',
      featureKey: 'F1',
      itemKey: 'review',
    });
    expect(JSON.stringify(record)).not.toContain('raw log must stay out of context');
    await expect(ledger.getValidationLog({
      projectKey: 'edge',
      featureKey: 'F1',
      itemKey: 'review',
      validationId: validation.id,
    })).resolves.toMatchObject({ text: 'raw log must stay out of context' });

    await client.validationRun.update({
      where: { id: validation.id },
      data: { logExpiresAt: new Date(0) },
    });
    await expect(ledger.getValidationLog({
      projectKey: 'edge',
      featureKey: 'F1',
      itemKey: 'review',
      validationId: validation.id,
    })).rejects.toMatchObject({ code: 'VALIDATION_LOG_EXPIRED' });
    expect(await ledger.purgeExpiredLogs(new Date()).then((result) => result.count)).toBe(1);
    expect((await client.validationRun.findUniqueOrThrow({ where: { id: validation.id } })).logBlob)
      .toBeNull();
  });

  async function defineReadyItem(itemKey: string): Promise<void> {
    await ledger.defineWorkItem({
      projectKey: 'edge',
      featureKey: 'F1',
      key: itemKey,
      phaseKey: 'G1',
      position: itemKey === 'review' ? 5 : itemKey === 'empty' ? 4 : itemKey === 'duplicate' ? 3 : itemKey === 'branch' ? 2 : 1,
      title: itemKey,
      useCases: [{
        key: 'UC-01',
        title: 'Caso',
        actor: 'agent',
        preconditions: 'pre',
        trigger: 'trigger',
        expectedOutcome: 'outcome',
      }],
      criteria: [{ key: 'AC-01', statement: 'critério' }],
      tests: [{ key: 'T-01', name: 'teste', purpose: 'RED' }],
    });
    await ledger.transitionWorkItem({
      projectKey: 'edge',
      featureKey: 'F1',
      itemKey,
      to: 'READY',
    });
  }

  function authorize(itemKey: string, repositoryKeys = ['api']) {
    return ledger.authorizeWorkItem({
      projectKey: 'edge',
      featureKey: 'F1',
      itemKey,
      instruction: 'alterar somente o escopo autorizado',
      actor: 'owner',
      allowedEffects: ['código local'],
      forbiddenEffects: ['externo'],
      repositoryKeys,
    });
  }

  function definition(key: string): DefineWorkItemInput {
    return {
      projectKey: 'edge',
      featureKey: 'F1',
      key,
      phaseKey: 'G1',
      position: 20 + key.length,
      title: key,
      useCases: [{
        key: 'UC-01',
        title: 'Caso',
        actor: 'agent',
        preconditions: 'pre',
        trigger: 'trigger',
        expectedOutcome: 'outcome',
      }],
      criteria: [{ key: 'AC-01', statement: 'critério' }],
      tests: [{ key: 'T-01', name: 'teste', purpose: 'RED' }],
    };
  }
});
