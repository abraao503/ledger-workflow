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
    await ledger.addRepository({
      projectKey: 'tasks',
      key: 'front',
      path: '/tmp/tasks/front',
      expectedBranch: 'main',
    });
    await ledger.createValidationProfile({
      projectKey: 'tasks', repositoryKey: 'front', key: 'front-ui',
      program: 'npm', args: ['run', 'test:e2e'], parser: 'GENERIC',
      capabilities: ['UI_INTERACTION'],
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

  it('requires a journey and UI evidence for a frontend page PATCH', async () => {
    const scope = {
      repositories: [{ repositoryKey: 'front', paths: ['src/pages/ExamplePage.tsx'] }],
    };
    await expect(ledger.createPointTask({
      projectKey: 'tasks', key: 'P3', title: 'Repaginar tela',
      summary: 'Reformular toda a tela.', scope,
    })).rejects.toMatchObject({ code: 'TASK_UI_CONTRACT_REQUIRED' });

    const patch = await ledger.createPointTask({
      projectKey: 'tasks', key: 'P4', title: 'Repaginar tela',
      summary: 'Reformular toda a tela.', scope,
      riskTags: ['VISUAL_ONLY'],
      useCases: [{
        key: 'UC-01', title: 'Consultar modelos', actor: 'operador',
        preconditions: 'workspace operacional selecionado',
        trigger: 'abre a biblioteca', expectedOutcome: 'encontra o modelo e sua ação principal',
      }],
      criteria: [{
        key: 'AC-01', statement: 'a jornada é utilizável em desktop e mobile',
        useCaseKey: 'UC-01', evidenceKind: 'UI', polarity: 'EXPECTED',
      }],
      tests: [{
        key: 'T-01', name: 'jornada em dois viewports', purpose: 'GREEN',
        runnerProfileKey: 'front-ui', criterionKey: 'AC-01',
      }],
    } as Parameters<typeof ledger.createPointTask>[0]);

    expect(patch.item.state).toBe('READY');
    expect(JSON.parse(patch.item.riskTagsJson)).toEqual(['FRONTEND', 'VISUAL_ONLY']);
    await expect(client.useCase.count({ where: { workItemId: patch.item.id } })).resolves.toBe(1);
    await expect(client.acceptanceCriterion.count({ where: { workItemId: patch.item.id } })).resolves.toBe(1);
    await expect(client.testSpecification.count({ where: { workItemId: patch.item.id } })).resolves.toBe(1);
    const plan = await ledger.checkPlan({ projectKey: 'tasks', featureKey: 'P4' });
    expect(plan.items[0]).toMatchObject({
      semanticStatus: 'OK', validationStatus: 'OK',
      requiredCapabilities: [],
    });

    await client.testSpecification.deleteMany({ where: { workItemId: patch.item.id } });
    await client.acceptanceCriterion.deleteMany({ where: { workItemId: patch.item.id } });
    await client.useCase.deleteMany({ where: { workItemId: patch.item.id } });
    const legacyPlan = await ledger.checkPlan({ projectKey: 'tasks', featureKey: 'P4' });
    expect(legacyPlan.items[0]).toMatchObject({ semanticStatus: 'BLOCKED' });
  });

  it('allows a visual PATCH without requiring a UI interaction profile', async () => {
    const patch = await ledger.createPointTask({
      projectKey: 'tasks', key: 'P7', title: 'Ajustar ação visual',
      summary: 'Ajuste pontual de uma ação visível.',
      scope: { repositories: [{ repositoryKey: 'front', paths: ['src/components/Action.tsx'] }] },
      riskTags: ['VISUAL_ONLY'],
      useCases: [{
        key: 'UC-01', title: 'Usar ação', actor: 'operador',
        preconditions: 'tela aberta', trigger: 'aciona o controle',
        expectedOutcome: 'a ação fica disponível e compreensível',
      }],
      criteria: [{
        key: 'AC-01', statement: 'a ação é apresentada de forma clara',
        useCaseKey: 'UC-01', evidenceKind: 'UI', polarity: 'EXPECTED',
      }],
    });

    const plan = await ledger.checkPlan({ projectKey: 'tasks', featureKey: 'P7' });
    expect(patch.item.state).toBe('READY');
    expect(plan.items[0]).toMatchObject({
      semanticStatus: 'OK', validationStatus: 'OK', requiredCapabilities: [],
    });
  });

  it('rejects an incomplete structured contract outside the UI', async () => {
    await expect(ledger.createPointTask({
      projectKey: 'tasks', key: 'P6', title: 'Corrigir serviço',
      summary: 'Corrigir um caso sem interface.',
      scope: { repositories: [{ repositoryKey: 'app', paths: ['src/service.ts'] }] },
      useCases: [{
        key: 'UC-01', title: 'Executar serviço', actor: 'agente',
        preconditions: 'ambiente pronto', trigger: 'executa serviço',
        expectedOutcome: 'serviço conclui',
      }],
    })).rejects.toMatchObject({ code: 'TASK_CONTRACT_INVALID' });
  });

  it('keeps a scoped documentation PATCH on the short path', async () => {
    const patch = await ledger.createPointTask({
      projectKey: 'tasks', key: 'P5', title: 'Atualizar guia',
      summary: 'Corrigir instruções.', kind: 'DOCUMENTATION',
      scope: { repositories: [{ repositoryKey: 'front', paths: ['docs/agent/README.md'] }] },
    });
    expect(patch.item).toMatchObject({ state: 'READY', tddPolicy: 'EXEMPT' });
  });
});
