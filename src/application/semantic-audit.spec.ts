import type { PrismaClient } from '@prisma/client';

import { WorkflowLedger } from './workflow-ledger.js';
import { createTestDatabase, type TestDatabase } from '../infrastructure/db/test-database.js';

describe('WorkflowLedger semantic planning audit', () => {
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
      key: 'semantic-audit',
      name: 'Semantic audit',
      rootPath: '/tmp/semantic-audit',
    });
    await ledger.createTemplate({
      projectKey: 'semantic-audit',
      key: 'sized',
      name: 'Sized slices',
      definition: {
        slicePolicy: {
          maxUseCases: 2,
          maxRequiredCriteria: 4,
          maxTests: 3,
          maxRepositories: 1,
        },
      },
    });
    await ledger.createFeature({
      projectKey: 'semantic-audit',
      templateKey: 'sized',
      key: 'F1',
      name: 'Feature semanticamente auditada',
      summary: 'Feature usada para validar coerência do plano',
    });

    await ledger.defineWorkItem({
      projectKey: 'semantic-audit',
      featureKey: 'F1',
      key: '01',
      phaseKey: 'G3',
      position: 1,
      title: 'Fatia com dois resultados',
      tddPolicy: 'REQUIRED',
      useCases: [
        {
          key: 'UC-01',
          title: 'Persistir resultado',
          actor: 'Agente',
          preconditions: 'Plano definido',
          trigger: 'Execução iniciada',
          expectedOutcome: 'Persistência concluída',
        },
        {
          key: 'UC-02',
          title: 'Notificar resultado',
          actor: 'Agente',
          preconditions: 'Plano definido',
          trigger: 'Execução iniciada',
          expectedOutcome: 'Notificação concluída',
        },
      ],
      criteria: [
        { key: 'AC-01', statement: 'Persistência correta', useCaseKey: 'UC-01' },
        { key: 'AC-02', statement: 'Notificação correta', useCaseKey: 'UC-02' },
      ],
      tests: [
        { key: 'T-01', name: 'RED', purpose: 'RED', criterionKey: 'AC-01' },
        { key: 'T-02', name: 'GREEN', purpose: 'GREEN', criterionKey: 'AC-01' },
        { key: 'T-03', name: 'CHECK', purpose: 'CHECK', criterionKey: 'AC-02' },
      ],
    });

    await ledger.defineWorkItem({
      projectKey: 'semantic-audit',
      featureKey: 'F1',
      key: '03',
      phaseKey: 'G3',
      position: 3,
      title: 'Fatia sem rastreabilidade',
      tddPolicy: 'REQUIRED',
      useCases: [{
        key: 'UC-01',
        title: 'Executar resultado',
        actor: 'Agente',
        preconditions: 'Plano definido',
        trigger: 'Execução iniciada',
        expectedOutcome: 'Resultado concluído',
      }],
      criteria: [{ key: 'AC-01', statement: 'Resultado correto' }],
      tests: [],
    });

    await ledger.defineWorkItem({
      projectKey: 'semantic-audit',
      featureKey: 'F1',
      key: '04',
      phaseKey: 'G3',
      position: 4,
      title: 'Fatia sem jornada observável',
      tddPolicy: 'REQUIRED',
      useCases: [{
        key: 'UC-01',
        title: 'Impedir efeito proibido',
        actor: 'Agente',
        preconditions: 'Plano definido',
        trigger: '  ',
        expectedOutcome: '  ',
      }],
      criteria: [{
        key: 'AC-01',
        statement: 'O efeito proibido não ocorre',
        useCaseKey: 'UC-01',
        evidenceKind: 'UI',
        polarity: 'FORBIDDEN',
      }],
      tests: [{ key: 'T-01', name: 'RED', purpose: 'RED', criterionKey: 'AC-01' }],
    });

    await ledger.defineWorkItem({
      projectKey: 'semantic-audit',
      featureKey: 'F1',
      key: '02',
      phaseKey: 'G3',
      position: 2,
      title: 'Fatia com resultado único',
      tddPolicy: 'REQUIRED',
      useCases: [{
        key: 'UC-01',
        title: 'Persistir resultado',
        actor: 'Agente',
        preconditions: 'Plano definido',
        trigger: 'Execução iniciada',
        expectedOutcome: 'Persistência concluída',
      }],
      criteria: [
        { key: 'AC-01', statement: 'Persistência correta', useCaseKey: 'UC-01' },
        { key: 'AC-02', statement: 'Isolamento correto', useCaseKey: 'UC-01' },
      ],
      tests: [
        { key: 'T-01', name: 'RED', purpose: 'RED', criterionKey: 'AC-01' },
        { key: 'T-02', name: 'GREEN', purpose: 'GREEN', criterionKey: 'AC-01' },
        { key: 'T-03', name: 'CHECK', purpose: 'CHECK', criterionKey: 'AC-02' },
      ],
    });
  });

  afterAll(async () => {
    await database.close();
  });

  it('blocks multiple primary outcomes and releases a coherent slice', async () => {
    const result = await ledger.checkPlan({
      projectKey: 'semantic-audit',
      featureKey: 'F1',
    });

    expect(result.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: '01',
        semanticStatus: 'BLOCKED',
        semanticIssues: expect.arrayContaining([
          expect.objectContaining({ code: 'MULTIPLE_PRIMARY_OUTCOMES' }),
        ]),
      }),
      expect.objectContaining({
        key: '02',
        semanticStatus: 'OK',
        semanticIssues: [],
      }),
    ]));

  });

  it('reports missing traceability and test coverage as actionable errors', async () => {
    const result = await ledger.checkPlan({
      projectKey: 'semantic-audit',
      featureKey: 'F1',
    });
    const item = result.items.find((candidate) => candidate.key === '03');

    expect(item).toMatchObject({
      semanticStatus: 'BLOCKED',
      semanticIssues: expect.arrayContaining([
        expect.objectContaining({ code: 'CRITERION_NOT_TRACEABLE', severity: 'ERROR' }),
        expect.objectContaining({ code: 'CRITERION_WITHOUT_TEST', severity: 'ERROR' }),
      ]),
    });
  });

  it('blocks non-observable journeys and explains forbidden-only outcomes', async () => {
    const result = await ledger.checkPlan({
      projectKey: 'semantic-audit',
      featureKey: 'F1',
    });
    const item = result.items.find((candidate) => candidate.key === '04');

    expect(item).toMatchObject({
      semanticStatus: 'BLOCKED',
      semanticIssues: expect.arrayContaining([
        expect.objectContaining({ code: 'NO_ACTION_TRIGGER', severity: 'ERROR' }),
        expect.objectContaining({ code: 'NO_PRIMARY_OUTCOME', severity: 'ERROR' }),
        expect.objectContaining({ code: 'NO_OBSERVABLE_CRITERION', severity: 'ERROR' }),
        expect.objectContaining({ code: 'FORBIDDEN_OUTCOME_WITHOUT_EXPECTED', severity: 'ERROR' }),
      ]),
    });
  });
});
