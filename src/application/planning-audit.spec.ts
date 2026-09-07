import type { PrismaClient } from '@prisma/client';

import { WorkflowLedger } from './workflow-ledger.js';
import { createTestDatabase, type TestDatabase } from '../infrastructure/db/test-database.js';

describe('WorkflowLedger planning audit', () => {
  let database: TestDatabase;
  let client: PrismaClient;
  let ledger: WorkflowLedger;

  beforeAll(async () => {
    database = createTestDatabase();
    client = database.client;
    ledger = new WorkflowLedger(client, {
      capture: async () => ({
        branch: 'master',
        sha: 'sha-1',
        dirty: false,
        changedFiles: [],
        fingerprint: 'fingerprint-1',
        contentFingerprint: 'content-1',
      }),
    });

    await ledger.createProject({
      key: 'audit',
      name: 'Planning audit',
      rootPath: '/tmp/audit',
    });
    await ledger.addRepository({
      projectKey: 'audit',
      key: 'workflow',
      path: '/tmp/audit/workflow',
    });
    await ledger.createTemplate({
      projectKey: 'audit',
      key: 'sized',
      name: 'Sized slices',
      definition: {
        slicePolicy: {
          maxUseCases: 1,
          maxRequiredCriteria: 2,
          maxTests: 2,
          maxRepositories: 1,
        },
      },
    });
    await ledger.createFeature({
      projectKey: 'audit',
      templateKey: 'sized',
      key: 'F1',
      name: 'Feature auditada',
      summary: 'Feature com fatias de tamanhos diferentes',
    });
    await ledger.defineWorkItem({
      projectKey: 'audit',
      featureKey: 'F1',
      key: '01',
      phaseKey: 'G3',
      position: 1,
      title: 'Fatia pequena',
      tddPolicy: 'REQUIRED',
      useCases: [{
        key: 'UC-01',
        title: 'Executar resultado',
        actor: 'Agente',
        preconditions: 'Planejamento definido',
        trigger: 'Execução iniciada',
        expectedOutcome: 'Resultado entregue',
      }],
      criteria: [
        { key: 'AC-01', statement: 'Resultado correto', useCaseKey: 'UC-01' },
      ],
      tests: [
        { key: 'T-01', name: 'RED', purpose: 'RED', criterionKey: 'AC-01' },
        { key: 'T-02', name: 'GREEN', purpose: 'GREEN', criterionKey: 'AC-01' },
      ],
    });
    await ledger.defineWorkItem({
      projectKey: 'audit',
      featureKey: 'F1',
      key: '02',
      phaseKey: 'G3',
      position: 2,
      title: 'Fatia grande',
      tddPolicy: 'REQUIRED',
      useCases: [
        {
          key: 'UC-01',
          title: 'Executar resultado A',
          actor: 'Agente',
          preconditions: 'Planejamento definido',
          trigger: 'Execução iniciada',
          expectedOutcome: 'Resultado A entregue',
        },
        {
          key: 'UC-02',
          title: 'Executar resultado B',
          actor: 'Agente',
          preconditions: 'Planejamento definido',
          trigger: 'Execução iniciada',
          expectedOutcome: 'Resultado B entregue',
        },
      ],
      criteria: [
        { key: 'AC-01', statement: 'Resultado A correto', useCaseKey: 'UC-01' },
        { key: 'AC-02', statement: 'Resultado B correto', useCaseKey: 'UC-02' },
        { key: 'AC-03', statement: 'Regressão preservada' },
      ],
      tests: [
        { key: 'T-01', name: 'RED A', purpose: 'RED', criterionKey: 'AC-01' },
        { key: 'T-02', name: 'GREEN A', purpose: 'GREEN', criterionKey: 'AC-01' },
        { key: 'T-03', name: 'CHECK amplo', purpose: 'CHECK', criterionKey: 'AC-03' },
      ],
    });
    await ledger.createFeature({
      projectKey: 'audit',
      templateKey: 'sized',
      key: 'F3',
      name: 'Feature com exceção',
      summary: 'Feature usada para validar aprovação explícita',
    });
    await ledger.defineWorkItem({
      projectKey: 'audit',
      featureKey: 'F3',
      key: '01',
      phaseKey: 'G3',
      position: 1,
      title: 'Fatia acima do orçamento',
      tddPolicy: 'REQUIRED',
      useCases: [
        {
          key: 'UC-01',
          title: 'Resultado A',
          actor: 'Agente',
          preconditions: 'Planejamento definido',
          trigger: 'Execução iniciada',
          expectedOutcome: 'Resultado A entregue',
        },
        {
          key: 'UC-02',
          title: 'Resultado B',
          actor: 'Agente',
          preconditions: 'Planejamento definido',
          trigger: 'Execução iniciada',
          expectedOutcome: 'Resultado B entregue',
        },
      ],
      criteria: [
        { key: 'AC-01', statement: 'Resultado A correto', useCaseKey: 'UC-01' },
        { key: 'AC-02', statement: 'Resultado B correto', useCaseKey: 'UC-02' },
      ],
      tests: [
        { key: 'T-01', name: 'RED A', purpose: 'RED', criterionKey: 'AC-01' },
        { key: 'T-02', name: 'GREEN A', purpose: 'GREEN', criterionKey: 'AC-01' },
        { key: 'T-03', name: 'CHECK B', purpose: 'CHECK', criterionKey: 'AC-02' },
      ],
    });
  });

  afterAll(async () => {
    await database.close();
  });

  it('returns deterministic metrics and summary without mutating items', async () => {
    const result = await ledger.checkPlan({ projectKey: 'audit', featureKey: 'F1' });

    expect(result).toMatchObject({
      project: 'audit',
      feature: { key: 'F1', name: 'Feature auditada' },
      policy: {
        maxUseCases: 1,
        maxRequiredCriteria: 2,
        maxTests: 2,
        maxRepositories: 1,
      },
      summary: {
        total: 2,
        ok: 1,
        splitRecommended: 1,
        exceptionRequired: 0,
      },
      items: [
        { key: '01', status: 'OK', score: 0 },
        { key: '02', status: 'SPLIT_RECOMMENDED', score: 3 },
      ],
    });
    expect(result.items[1].metrics).toEqual({
      useCases: 2,
      requiredCriteria: 3,
      tests: 3,
      repositories: 0,
    });
    expect(await client.workItem.count({ where: { feature: { key: 'F1' } } })).toBe(2);
    expect(await client.workflowEvent.count({ where: { feature: { key: 'F1' } } })).toBe(2);
  });

  it('uses the default policy when the template has no slice policy', async () => {
    await ledger.createTemplate({
      projectKey: 'audit',
      key: 'without-policy',
      name: 'Without policy',
      definition: {},
    });
    await ledger.createFeature({
      projectKey: 'audit',
      templateKey: 'without-policy',
      key: 'F2',
      name: 'Sem política',
      summary: 'Usa os limites padrão',
    });

    const result = await ledger.checkPlan({ projectKey: 'audit', featureKey: 'F2' });

    expect(result.policy).toEqual({
      maxUseCases: 2,
      maxRequiredCriteria: 4,
      maxTests: 3,
      maxRepositories: 1,
    });
    expect(result.summary).toEqual({
      total: 0,
      ok: 0,
      splitRecommended: 0,
      exceptionRequired: 0,
    });
  });

  it('blocks an oversized slice until an explicit durable approval exists', async () => {
    await expect(ledger.transitionWorkItem({
      projectKey: 'audit',
      featureKey: 'F3',
      itemKey: '01',
      to: 'READY',
    })).rejects.toMatchObject({ code: 'SLICE_SIZE_APPROVAL_REQUIRED' });

    const approval = await ledger.approveSliceSize({
      projectKey: 'audit',
      featureKey: 'F3',
      itemKey: '01',
      actor: 'responsável',
      reason: 'A fatia mantém um gate indivisível com evidência única.',
    });

    expect(approval.decision).toMatchObject({
      title: 'Exceção de granularidade aprovada',
      durable: true,
      pinned: true,
    });
    const ready = await ledger.transitionWorkItem({
      projectKey: 'audit',
      featureKey: 'F3',
      itemKey: '01',
      to: 'READY',
    });
    expect(ready.state).toBe('READY');
    expect(approval.decision.content).toContain('responsável');
  });
});
