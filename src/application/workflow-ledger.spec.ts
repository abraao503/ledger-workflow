import type { PrismaClient } from '@prisma/client';

import { WorkflowLedger } from './workflow-ledger.js';
import type { GitReadPort, SubmitReviewInput } from './types.js';
import { createTestDatabase, type TestDatabase } from '../infrastructure/db/test-database.js';

describe('WorkflowLedger', () => {
  let database: TestDatabase;
  let client: PrismaClient;
  let ledger: WorkflowLedger;
  let snapshot = {
    branch: 'dev',
    sha: 'sha-1',
    dirty: false,
    changedFiles: [] as string[],
    fingerprint: 'fingerprint-1',
    contentFingerprint: 'content-1',
  };

  beforeAll(() => {
    database = createTestDatabase();
    client = database.client;
    const fakeGit: GitReadPort = {
      capture: async () => snapshot,
    };
    ledger = new WorkflowLedger(client, fakeGit);
  });

  afterAll(async () => {
    await database.close();
  });

  it('runs a coding item from definition through review and closure', async () => {
    await ledger.createProject({
      key: 'carara',
      name: 'Carará',
      rootPath: '/tmp/carara',
    });
    await ledger.addRepository({
      projectKey: 'carara',
      key: 'api',
      path: '/tmp/carara/api',
      expectedBranch: 'dev',
    });
    await ledger.createTemplate({
      projectKey: 'carara',
      key: 'carara-gates',
      name: 'Carará G0-G7',
      definition: { phases: ['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'] },
    });
    await ledger.createFeature({
      projectKey: 'carara',
      templateKey: 'carara-gates',
      key: 'E6',
      name: 'Assistentes de IA',
      summary: 'Runtime operacional',
    });
    await ledger.defineWorkItem({
      projectKey: 'carara',
      featureKey: 'E6',
      key: '05',
      phaseKey: 'G3',
      position: 5,
      title: 'Tools do núcleo',
      useCases: [
        {
          key: 'UC-01',
          title: 'Executar tool autorizada',
          actor: 'Assistant',
          preconditions: 'Attendance ativo',
          trigger: 'Execution processada',
          expectedOutcome: 'Resultado controlado',
        },
      ],
      criteria: [
        {
          key: 'AC-01',
          statement: 'Ownership e versão são revalidados',
          useCaseKey: 'UC-01',
        },
      ],
      tests: [
        {
          key: 'T-01',
          name: 'rejeita versão stale',
          purpose: 'RED',
          criterionKey: 'AC-01',
        },
        {
          key: 'T-02',
          name: 'executa tool autorizada',
          purpose: 'GREEN',
          criterionKey: 'AC-01',
        },
      ],
    });

    await ledger.transitionWorkItem({
      projectKey: 'carara',
      featureKey: 'E6',
      itemKey: '05',
      to: 'READY',
    });
    await ledger.authorizeWorkItem({
      projectKey: 'carara',
      featureKey: 'E6',
      itemKey: '05',
      instruction: 'implementar a fatia 05',
      actor: 'owner',
      allowedEffects: ['código local'],
      forbiddenEffects: ['provider real'],
      repositoryKeys: ['api'],
    });
    const claimed = await ledger.claimWorkItem({
      projectKey: 'carara',
      featureKey: 'E6',
      itemKey: '05',
      holder: 'agent:test',
      durationSeconds: 3_600,
    });
    const executionFence = claimed.lease.generation;
    await ledger.transitionWorkItem({
      projectKey: 'carara',
      featureKey: 'E6',
      itemKey: '05',
      to: 'TESTS_DEFINED',
      executionFence,
    });

    const repository = await client.repository.findFirstOrThrow();
    await client.validationProfile.create({
      data: {
        repositoryId: repository.id,
        key: 'related-tests',
        program: 'npm',
        argsJson: JSON.stringify(['test']),
        cwd: '.',
        parser: 'JEST',
      },
    });
    await ledger.recordValidation({
      projectKey: 'carara',
      featureKey: 'E6',
      itemKey: '05',
      repositoryKey: 'api',
      profileKey: 'related-tests',
      purpose: 'RED',
      status: 'COMPLETED',
      resultKind: 'TEST_FAILURE',
      exitCode: 1,
      sha: 'sha-1',
      durationMs: 100,
      summary: { suites: 1, tests: 1 },
      log: 'expected failing test',
      executionFence,
    });
    await ledger.transitionWorkItem({
      projectKey: 'carara',
      featureKey: 'E6',
      itemKey: '05',
      to: 'RED_CONFIRMED',
      executionFence,
    });
    await ledger.transitionWorkItem({
      projectKey: 'carara',
      featureKey: 'E6',
      itemKey: '05',
      to: 'IMPLEMENTING',
      executionFence,
    });
    await ledger.recordValidation({
      projectKey: 'carara',
      featureKey: 'E6',
      itemKey: '05',
      repositoryKey: 'api',
      profileKey: 'related-tests',
      purpose: 'GREEN',
      status: 'COMPLETED',
      resultKind: 'PASS',
      exitCode: 0,
      sha: 'sha-1',
      durationMs: 200,
      summary: { suites: 1, tests: 2, contentFingerprint: 'content-1' },
      executionFence,
    });
    await ledger.transitionWorkItem({
      projectKey: 'carara',
      featureKey: 'E6',
      itemKey: '05',
      to: 'GREEN_CONFIRMED',
      executionFence,
    });
    await ledger.transitionWorkItem({
      projectKey: 'carara',
      featureKey: 'E6',
      itemKey: '05',
      to: 'READY_FOR_REVIEW',
      executionFence,
    });
    const reviewInput: SubmitReviewInput = {
      projectKey: 'carara',
      featureKey: 'E6',
      itemKey: '05',
      reviewer: 'reviewer',
      reviewMode: 'SELF',
      verdict: 'APPROVED',
      summary: 'Critérios atendidos',
      findings: [],
      executionFence,
    };
    snapshot = {
      ...snapshot,
      fingerprint: 'fingerprint-2',
      contentFingerprint: 'content-2',
    };
    await expect(ledger.submitReview(reviewInput)).rejects.toMatchObject({
      code: 'GREEN_EVIDENCE_STALE',
    });
    snapshot = {
      ...snapshot,
      fingerprint: 'fingerprint-1',
      contentFingerprint: 'content-1',
    };
    const reviewed = await ledger.submitReview(reviewInput);
    expect(reviewed.item.state).toBe('APPROVED');
    snapshot = {
      ...snapshot,
      fingerprint: 'fingerprint-2',
      contentFingerprint: 'content-2',
    };
    await expect(ledger.transitionWorkItem({
      projectKey: 'carara',
      featureKey: 'E6',
      itemKey: '05',
      to: 'CLOSED',
      commitSha: 'sha-2',
      executionFence,
    })).rejects.toMatchObject({ code: 'GREEN_EVIDENCE_STALE' });
    snapshot = {
      ...snapshot,
      sha: 'sha-2',
      fingerprint: 'fingerprint-3',
      contentFingerprint: 'content-1',
    };
    const closed = await ledger.transitionWorkItem({
      projectKey: 'carara',
      featureKey: 'E6',
      itemKey: '05',
      to: 'CLOSED',
      commitSha: 'sha-2',
      executionFence,
    });

    expect(closed.state).toBe('CLOSED');
    const context = await ledger.getContext({
      projectKey: 'carara',
      featureKey: 'E6',
      itemKey: '05',
    });
    expect(context.current.state).toBe('CLOSED');
    expect(context.acceptanceCriteria).toEqual([
      { key: 'AC-01', statement: 'Ownership e versão são revalidados' },
    ]);
    expect(context.currentEvidence).toMatchObject({
      outcome: expect.any(String),
      commitRef: 'sha-2',
      review: {
        verdict: 'APPROVED',
        mode: 'SELF',
        reviewer: 'reviewer',
      },
    });
  });

  it('lists projects, features, repositories, validations and manages decisions and pending items', async () => {
    await ledger.createProject({
      key: 'studio',
      name: 'Studio',
      rootPath: '/tmp/studio',
    });
    await ledger.addRepository({
      projectKey: 'studio',
      key: 'web',
      path: '/tmp/studio/web',
    });
    await ledger.createTemplate({
      projectKey: 'studio',
      key: 'studio-gates',
      name: 'Studio Gates',
      definition: { phases: ['G0', 'G1'] },
    });
    await ledger.createFeature({
      projectKey: 'studio',
      templateKey: 'studio-gates',
      key: 'F1',
      name: 'Painel',
      summary: 'Painel web',
    });
    await ledger.defineWorkItem({
      projectKey: 'studio',
      featureKey: 'F1',
      key: '01',
      phaseKey: 'G1',
      position: 1,
      title: 'Base do painel',
      tddPolicy: 'OPTIONAL',
      useCases: [
        {
          key: 'UC-01',
          title: 'Consultar estado do ledger',
          actor: 'Operador',
          preconditions: 'Ledger acessível',
          trigger: 'Abertura do painel',
          expectedOutcome: 'Estado exibido',
        },
      ],
      criteria: [
        { key: 'AC-01', statement: 'Painel carrega estado do ledger', useCaseKey: 'UC-01' },
      ],
      tests: [],
    });

    const projects = await ledger.listProjects();
    expect(projects.projects.map((project) => project.key)).toContain('studio');

    const features = await ledger.listFeatures('studio');
    expect(features.features).toHaveLength(1);
    expect(features.features[0]).toMatchObject({ key: 'F1', items: [{ key: '01', state: 'DRAFT' }] });

    await expect(ledger.listFeatures('missing')).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });

    const repository = await client.repository.findFirstOrThrow({ where: { key: 'web' } });
    await client.validationProfile.create({
      data: {
        repositoryId: repository.id,
        key: 'typecheck',
        program: 'npm',
        argsJson: JSON.stringify(['run', 'typecheck']),
        cwd: '.',
        parser: 'GENERIC',
      },
    });
    const repositories = await ledger.listRepositories('studio');
    expect(repositories.repositories).toEqual([
      {
        key: 'web',
        path: '/tmp/studio/web',
        expectedBranch: null,
        profiles: [{
          key: 'typecheck',
          program: 'npm',
          args: ['run', 'typecheck'],
          parser: 'GENERIC',
          cwd: '.',
          timeoutSeconds: 60,
        }],
      },
    ]);

    await ledger.transitionWorkItem({ projectKey: 'studio', featureKey: 'F1', itemKey: '01', to: 'READY' });
    await ledger.authorizeWorkItem({
      projectKey: 'studio',
      featureKey: 'F1',
      itemKey: '01',
      instruction: 'registrar validação do painel',
      actor: 'owner',
      allowedEffects: ['teste local'],
      forbiddenEffects: ['produção'],
      repositoryKeys: ['web'],
    });
    const studioLease = await ledger.claimWorkItem({
      projectKey: 'studio',
      featureKey: 'F1',
      itemKey: '01',
      holder: 'agent:test',
      durationSeconds: 3_600,
    });
    await ledger.recordValidation({
      projectKey: 'studio',
      featureKey: 'F1',
      itemKey: '01',
      repositoryKey: 'web',
      profileKey: 'typecheck',
      purpose: 'GREEN',
      status: 'COMPLETED',
      resultKind: 'PASS',
      exitCode: 0,
      sha: 'sha-1',
      durationMs: 50,
      summary: { suites: 1 },
      executionFence: studioLease.lease.generation,
    });
    const validations = await ledger.listValidations({
      projectKey: 'studio',
      featureKey: 'F1',
      itemKey: '01',
    });
    expect(validations.validations).toHaveLength(1);
    expect(validations.validations[0]).toMatchObject({
      purpose: 'GREEN',
      repositoryKey: 'web',
      profileKey: 'typecheck',
      resultKind: 'PASS',
      logAvailable: false,
    });
    expect(await ledger.listValidations({
      projectKey: 'studio',
      featureKey: 'F1',
      itemKey: '01',
      purpose: 'RED',
    })).toMatchObject({ validations: [] });

    const decision = await ledger.recordDecision({
      projectKey: 'studio',
      featureKey: 'F1',
      itemKey: '01',
      key: 'DEC-01',
      title: 'Fonte única de estado',
      content: 'O painel lê apenas do ledger',
    });
    expect(decision).toMatchObject({ key: 'DEC-01', durable: true });
    await ledger.recordDecision({
      projectKey: 'studio',
      key: 'DEC-01',
      title: 'Fonte única de estado',
      content: 'Atualizado: o painel lê apenas do ledger',
    });
    const decisions = await ledger.listDecisions('studio');
    expect(decisions.decisions).toHaveLength(1);
    expect(decisions.decisions[0]).toMatchObject({ content: 'Atualizado: o painel lê apenas do ledger', itemKey: '01' });

    const pending = await ledger.recordPendingItem({
      projectKey: 'studio',
      featureKey: 'F1',
      key: 'PEND-01',
      description: 'Definir perfil de build',
      blocking: true,
    });
    expect(pending).toMatchObject({ key: 'PEND-01', blocking: true, resolved: false });
    await expect(ledger.recordPendingItem({
      projectKey: 'studio',
      key: 'PEND-01',
      description: 'duplicada',
    })).rejects.toMatchObject({ code: 'PENDING_ITEM_EXISTS' });
    await expect(ledger.resolvePendingItem({
      projectKey: 'studio',
      key: 'PEND-01',
      reason: 'perfil registrado',
    })).resolves.toMatchObject({ resolved: true });
    await expect(ledger.resolvePendingItem({
      projectKey: 'studio',
      key: 'PEND-01',
    })).rejects.toMatchObject({ code: 'PENDING_ITEM_ALREADY_RESOLVED' });
    await expect(ledger.resolvePendingItem({
      projectKey: 'studio',
      key: 'PEND-MISSING',
    })).rejects.toMatchObject({ code: 'PENDING_ITEM_NOT_FOUND' });
    await expect(ledger.recordPendingItem({
      projectKey: 'studio',
      itemKey: '01',
      key: 'PEND-02',
      description: 'sem feature',
    })).rejects.toMatchObject({ code: 'ITEM_REQUIRES_FEATURE' });

    const pendingItems = await ledger.listPendingItems('studio');
    expect(pendingItems.pendingItems).toHaveLength(1);
    expect(pendingItems.pendingItems[0]).toMatchObject({ key: 'PEND-01', resolved: true, featureKey: 'F1' });

    const itemContext = await ledger.getContext({
      projectKey: 'studio',
      featureKey: 'F1',
      itemKey: '01',
    });
    expect(itemContext.durableDecisions).toEqual([
      { key: 'DEC-01', title: 'Fonte única de estado' },
    ]);
  });

  it('resolves context to the latest closed item when the feature has no active slice', async () => {
    const context = await ledger.getContext({
      projectKey: 'carara',
      featureKey: 'E6',
    });
    expect(context.current).toMatchObject({
      featureKey: 'E6',
      itemKey: '05',
      state: 'CLOSED',
    });
  });

  it('amends validation risks and test profiles only for a valid DRAFT plan', async () => {
    await ledger.createProject({
      key: 'draft-validation-plan',
      name: 'Draft validation plan',
      rootPath: '/tmp/draft-validation-plan',
    });
    await ledger.addRepository({
      projectKey: 'draft-validation-plan',
      key: 'api',
      path: '/tmp/draft-validation-plan/api',
      expectedBranch: 'main',
    });
    await ledger.createValidationProfile({
      projectKey: 'draft-validation-plan',
      repositoryKey: 'api',
      key: 'api-incomplete',
      program: 'npm',
      args: ['test'],
      parser: 'JEST',
    });
    await ledger.createValidationProfile({
      projectKey: 'draft-validation-plan',
      repositoryKey: 'api',
      key: 'api-complete',
      program: 'npm',
      args: ['test'],
      parser: 'JEST',
      capabilities: ['API_INTEGRATION', 'READ_AFTER_WRITE'],
    });
    await ledger.createTemplate({
      projectKey: 'draft-validation-plan',
      key: 'gates',
      name: 'Gates',
      definition: { phases: ['G3'] },
    });
    await ledger.createFeature({
      projectKey: 'draft-validation-plan',
      templateKey: 'gates',
      key: 'E1',
      name: 'Validation plan amendment',
      summary: 'Correct draft validation coverage',
    });
    const item = await ledger.defineWorkItem({
      projectKey: 'draft-validation-plan',
      featureKey: 'E1',
      key: '01',
      phaseKey: 'G3',
      position: 1,
      title: 'Draft item',
      summary: 'Item for validation-plan amendment',
      scope: { repositories: [{ repositoryKey: 'api', paths: ['src/**'] }] },
      useCases: [{
        key: 'UC-01',
        title: 'Run the API behavior',
        actor: 'operator',
        preconditions: 'A draft item exists',
        trigger: 'The plan is amended',
        expectedOutcome: 'The plan keeps valid test coverage',
      }],
      criteria: [{
        key: 'AC-01',
        statement: 'The required API behavior is tested',
        useCaseKey: 'UC-01',
        evidenceKind: 'HTTP_RESPONSE',
      }],
      tests: [{
        key: 'T-OLD',
        name: 'old profile',
        purpose: 'GREEN',
        runnerProfileKey: 'api-incomplete',
        criterionKey: 'AC-01',
      }],
    });

    await expect(ledger.amendDraftValidationPlan({
      projectKey: 'draft-validation-plan',
      featureKey: 'E1',
      itemKey: '01',
      riskTags: ['API_WRITE'],
      tests: [{
        key: 'T-NEW',
        name: 'incomplete profile',
        purpose: 'GREEN',
        runnerProfileKey: 'api-incomplete',
        criterionKey: 'AC-01',
      }],
    })).rejects.toMatchObject({ code: 'VALIDATION_PLAN_INCOMPLETE' });
    expect(await client.workItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({
      riskTagsJson: '[]',
    });
    expect(await client.testSpecification.findMany({ where: { workItemId: item.id } }))
      .toMatchObject([{ key: 'T-OLD', runnerProfileKey: 'api-incomplete' }]);

    const amended = await ledger.amendDraftValidationPlan({
      projectKey: 'draft-validation-plan',
      featureKey: 'E1',
      itemKey: '01',
      riskTags: ['API_WRITE'],
      tests: [{
        key: 'T-NEW',
        name: 'covered profile',
        purpose: 'GREEN',
        runnerProfileKey: 'api-complete',
        criterionKey: 'AC-01',
      }],
    });
    expect(amended).toMatchObject({
      riskTagsJson: '["API_WRITE"]',
      tests: [{ key: 'T-NEW', runnerProfileKey: 'api-complete' }],
    });
    expect(await client.workflowEvent.findFirst({
      where: { workItemId: item.id, type: 'DRAFT_VALIDATION_PLAN_AMENDED' },
    })).not.toBeNull();

    await client.workItem.update({ where: { id: item.id }, data: { state: 'READY' } });
    await expect(ledger.amendDraftValidationPlan({
      projectKey: 'draft-validation-plan',
      featureKey: 'E1',
      itemKey: '01',
      riskTags: [],
      tests: [{ key: 'T-LATE', name: 'late change', purpose: 'GREEN' }],
    })).rejects.toMatchObject({ code: 'VALIDATION_PLAN_DRAFT_ONLY' });
    expect(await client.workItem.findUniqueOrThrow({ where: { id: item.id } })).toMatchObject({
      riskTagsJson: '["API_WRITE"]',
    });
    expect(await client.testSpecification.findMany({ where: { workItemId: item.id } }))
      .toMatchObject([{ key: 'T-NEW', runnerProfileKey: 'api-complete' }]);
  });
});
