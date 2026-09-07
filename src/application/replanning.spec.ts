import type { PrismaClient } from '@prisma/client';

import { WorkflowLedger } from './workflow-ledger.js';
import { createTestDatabase, type TestDatabase } from '../infrastructure/db/test-database.js';

describe('slice replanning', () => {
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
      key: 'replanning',
      name: 'Slice replanning',
      rootPath: '/tmp/replanning',
    });
    await ledger.createTemplate({
      projectKey: 'replanning',
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
      projectKey: 'replanning',
      templateKey: 'sized',
      key: 'F1',
      name: 'Feature replanejada',
      summary: 'Linhagem entre fatias',
    });
    await ledger.defineWorkItem({
      projectKey: 'replanning',
      featureKey: 'F1',
      key: '01',
      phaseKey: 'G3',
      position: 1,
      title: 'Fatia grande original',
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

  it('blocks the oversized original and attaches a smaller child to it', async () => {
    await ledger.requestSliceSizeException({
      projectKey: 'replanning',
      featureKey: 'F1',
      itemKey: '01',
      actor: 'agent:codex',
      reason: 'A fatia contém dois resultados primários e precisa ser dividida.',
    });

    const replanned = await ledger.replanWorkItem({
      projectKey: 'replanning',
      featureKey: 'F1',
      itemKey: '01',
      actor: 'agent:codex',
      reason: 'Replanejar por resultado primário antes de implementar.',
    });
    expect(replanned.item.state).toBe('BLOCKED');
    expect(replanned.pending).toMatchObject({ resolved: true });

    const child = await ledger.defineWorkItem({
      projectKey: 'replanning',
      featureKey: 'F1',
      key: '02',
      phaseKey: 'G3',
      position: 2,
      parentItemKey: '01',
      title: 'Resultado A replanejado',
      tddPolicy: 'REQUIRED',
      useCases: [{
        key: 'UC-01',
        title: 'Resultado A',
        actor: 'Agente',
        preconditions: 'Planejamento definido',
        trigger: 'Execução iniciada',
        expectedOutcome: 'Resultado A entregue',
      }],
      criteria: [{ key: 'AC-01', statement: 'Resultado A correto', useCaseKey: 'UC-01' }],
      tests: [{ key: 'T-01', name: 'RED A', purpose: 'RED', criterionKey: 'AC-01' }],
    });

    expect(child.state).toBe('DRAFT');
    const record = await ledger.getRecord({
      projectKey: 'replanning',
      featureKey: 'F1',
      itemKey: '02',
    });
    expect(record.lineage).toEqual({
      parent: { key: '01', title: 'Fatia grande original', state: 'BLOCKED' },
      children: [],
    });

    const context = await ledger.getContext({
      projectKey: 'replanning',
      featureKey: 'F1',
      itemKey: '01',
    });
    expect(context.lineage).toEqual({
      parent: undefined,
      children: [{ key: '02', title: 'Resultado A replanejado', state: 'DRAFT' }],
    });

    const plan = await ledger.checkPlan({ projectKey: 'replanning', featureKey: 'F1' });
    expect(plan.items.find((item) => item.key === '02')).toMatchObject({
      status: 'OK',
      parentItemKey: '01',
    });
  });

  it('rejects a child without a replan event on its parent', async () => {
    await ledger.defineWorkItem({
      projectKey: 'replanning',
      featureKey: 'F1',
      key: '04',
      phaseKey: 'G3',
      position: 4,
      title: 'Fatia bloqueada sem replanejamento',
      tddPolicy: 'REQUIRED',
      useCases: [{
        key: 'UC-01',
        title: 'Resultado',
        actor: 'Agente',
        preconditions: 'Planejamento definido',
        trigger: 'Execução iniciada',
        expectedOutcome: 'Resultado entregue',
      }],
      criteria: [{ key: 'AC-01', statement: 'Resultado correto', useCaseKey: 'UC-01' }],
      tests: [{ key: 'T-01', name: 'RED', purpose: 'RED', criterionKey: 'AC-01' }],
    });
    await ledger.transitionWorkItem({
      projectKey: 'replanning',
      featureKey: 'F1',
      itemKey: '04',
      to: 'BLOCKED',
      reason: 'Bloqueio sem relação com replanejamento.',
    });

    await expect(ledger.defineWorkItem({
      projectKey: 'replanning',
      featureKey: 'F1',
      key: '05',
      phaseKey: 'G3',
      position: 5,
      parentItemKey: '04',
      title: 'Filho inválido',
      tddPolicy: 'REQUIRED',
      useCases: [{
        key: 'UC-01',
        title: 'Resultado',
        actor: 'Agente',
        preconditions: 'Planejamento definido',
        trigger: 'Execução iniciada',
        expectedOutcome: 'Resultado entregue',
      }],
      criteria: [{ key: 'AC-01', statement: 'Resultado correto', useCaseKey: 'UC-01' }],
      tests: [{ key: 'T-01', name: 'RED', purpose: 'RED', criterionKey: 'AC-01' }],
    })).rejects.toMatchObject({ code: 'PARENT_ITEM_NOT_REPLANNED' });
  });
});
