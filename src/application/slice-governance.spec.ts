import type { PrismaClient } from '@prisma/client';

import { WorkflowLedger } from './workflow-ledger.js';
import { createTestDatabase, type TestDatabase } from '../infrastructure/db/test-database.js';

describe('slice governance', () => {
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
      key: 'governance',
      name: 'Slice governance',
      rootPath: '/tmp/governance',
    });
    await ledger.createTemplate({
      projectKey: 'governance',
      key: 'sized',
      name: 'Sized slices',
      definition: {
        slicePolicy: {
          maxUseCases: 1,
          maxRequiredCriteria: 1,
          maxTests: 1,
          maxRepositories: 1,
        },
      },
    });
    await ledger.createFeature({
      projectKey: 'governance',
      templateKey: 'sized',
      key: 'F1',
      name: 'Feature governada',
      summary: 'Exceções exigem operador humano',
    });
    await ledger.defineWorkItem({
      projectKey: 'governance',
      featureKey: 'F1',
      key: '01',
      phaseKey: 'G3',
      position: 1,
      title: 'Fatia acima da política',
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
      ],
      tests: [
        { key: 'T-01', name: 'RED', purpose: 'RED', criterionKey: 'AC-01' },
      ],
    });
  });

  afterAll(async () => {
    await database.close();
  });

  it('records a blocking request without approving the oversized slice', async () => {
    const result = await ledger.requestSliceSizeException({
      projectKey: 'governance',
      featureKey: 'F1',
      itemKey: '01',
      actor: 'agent:codex',
      reason: 'O resultado ainda precisa ser replanejado ou justificado.',
    });

    expect(result.assessment.status).toBe('SPLIT_RECOMMENDED');
    expect(result.pending).toMatchObject({
      key: 'SLICE-SIZE-REQUEST-F1-01',
      blocking: true,
      pinned: true,
      resolved: false,
    });
    expect(result.item.state).toBe('DRAFT');
    expect(await client.decision.count({ where: { workItemId: result.item.id } })).toBe(0);
    await expect(ledger.transitionWorkItem({
      projectKey: 'governance',
      featureKey: 'F1',
      itemKey: '01',
      to: 'READY',
    })).rejects.toMatchObject({ code: 'SLICE_SIZE_APPROVAL_REQUIRED' });
  });

  it('rejects agent self-approval and requires a pending request', async () => {
    await expect(ledger.approveSliceSize({
      projectKey: 'governance',
      featureKey: 'F1',
      itemKey: '01',
      actor: 'agent:codex',
      reason: 'Tentativa de autoaprovação',
    })).rejects.toMatchObject({ code: 'SLICE_SIZE_APPROVAL_HUMAN_REQUIRED' });
  });

  it('records human approval only after a request and allows READY', async () => {
    const approval = await ledger.approveSliceSize({
      projectKey: 'governance',
      featureKey: 'F1',
      itemKey: '01',
      actor: 'human:owner',
      reason: 'Gate indivisível aprovado pelo responsável do projeto.',
    });

    expect(approval.decision).toMatchObject({
      title: 'Exceção de granularidade aprovada',
      durable: true,
      pinned: true,
    });
    expect(approval.pending).toMatchObject({
      key: 'SLICE-SIZE-REQUEST-F1-01',
      resolved: true,
    });
    expect(approval.decision.content).toContain('human:owner');

    const ready = await ledger.transitionWorkItem({
      projectKey: 'governance',
      featureKey: 'F1',
      itemKey: '01',
      to: 'READY',
    });
    expect(ready.state).toBe('READY');
  });
});
