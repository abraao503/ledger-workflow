import type { PrismaClient } from '@prisma/client';

import { WorkflowLedger } from './workflow-ledger.js';
import { createTestDatabase, type TestDatabase } from '../infrastructure/db/test-database.js';

describe('WorkflowLedger planned repository scope', () => {
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
      key: 'scope-audit',
      name: 'Scope audit',
      rootPath: '/tmp/scope-audit',
    });
    await ledger.addRepository({
      projectKey: 'scope-audit',
      key: 'workflow',
      path: '/tmp/scope-audit/workflow',
    });
    await ledger.createTemplate({
      projectKey: 'scope-audit',
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
      projectKey: 'scope-audit',
      templateKey: 'sized',
      key: 'F1',
      name: 'Feature com escopo',
      summary: 'Feature usada para validar escopo antecipado',
    });
  });

  afterAll(async () => {
    await database.close();
  });

  it('exposes the declared repository and path scope in plan check', async () => {
    await ledger.defineWorkItem({
      projectKey: 'scope-audit',
      featureKey: 'F1',
      key: '01',
      phaseKey: 'G3',
      position: 1,
      title: 'Fatia com escopo declarado',
      tddPolicy: 'REQUIRED',
      useCases: [{
        key: 'UC-01',
        title: 'Executar resultado',
        actor: 'Agente',
        preconditions: 'Planejamento definido',
        trigger: 'Execução iniciada',
        expectedOutcome: 'Resultado entregue',
      }],
      criteria: [{
        key: 'AC-01',
        statement: 'Resultado correto',
        useCaseKey: 'UC-01',
      }],
      tests: [
        { key: 'T-01', name: 'RED', purpose: 'RED', criterionKey: 'AC-01' },
        { key: 'T-02', name: 'GREEN', purpose: 'GREEN', criterionKey: 'AC-01' },
        { key: 'T-03', name: 'CHECK', purpose: 'CHECK', criterionKey: 'AC-01' },
      ],
      scope: {
        repositories: [{
          repositoryKey: 'workflow',
          paths: ['src/application/**', 'src/interfaces/**'],
        }],
      },
    } as never);

    const result = await ledger.checkPlan({
      projectKey: 'scope-audit',
      featureKey: 'F1',
    });

    expect(result.items[0]).toMatchObject({
      scope: {
        repositories: [{
          repositoryKey: 'workflow',
          paths: ['src/application/**', 'src/interfaces/**'],
        }],
      },
      repositoryScope: 'DECLARED',
    });
  });
});
