import type { PrismaClient } from '@prisma/client';

import { WorkflowLedger } from './workflow-ledger.js';
import type { GitReadPort } from './types.js';
import { createTestDatabase, type TestDatabase } from '../infrastructure/db/test-database.js';

describe('WorkflowLedger', () => {
  let database: TestDatabase;
  let client: PrismaClient;
  let ledger: WorkflowLedger;

  beforeAll(() => {
    database = createTestDatabase();
    client = database.client;
    const fakeGit: GitReadPort = {
      capture: async () => ({
        branch: 'dev',
        sha: 'sha-1',
        dirty: false,
        changedFiles: [],
      }),
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
    await ledger.transitionWorkItem({
      projectKey: 'carara',
      featureKey: 'E6',
      itemKey: '05',
      to: 'TESTS_DEFINED',
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
    });
    await ledger.transitionWorkItem({
      projectKey: 'carara',
      featureKey: 'E6',
      itemKey: '05',
      to: 'RED_CONFIRMED',
    });
    await ledger.transitionWorkItem({
      projectKey: 'carara',
      featureKey: 'E6',
      itemKey: '05',
      to: 'IMPLEMENTING',
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
      summary: { suites: 1, tests: 2 },
    });
    await ledger.transitionWorkItem({
      projectKey: 'carara',
      featureKey: 'E6',
      itemKey: '05',
      to: 'GREEN_CONFIRMED',
    });
    await ledger.transitionWorkItem({
      projectKey: 'carara',
      featureKey: 'E6',
      itemKey: '05',
      to: 'READY_FOR_REVIEW',
    });
    await ledger.submitReview({
      projectKey: 'carara',
      featureKey: 'E6',
      itemKey: '05',
      reviewer: 'reviewer',
      verdict: 'APPROVED',
      summary: 'Critérios atendidos',
      findings: [],
    });
    await ledger.transitionWorkItem({
      projectKey: 'carara',
      featureKey: 'E6',
      itemKey: '05',
      to: 'APPROVED',
    });
    const closed = await ledger.transitionWorkItem({
      projectKey: 'carara',
      featureKey: 'E6',
      itemKey: '05',
      to: 'CLOSED',
      commitSha: 'sha-2',
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
  });
});
