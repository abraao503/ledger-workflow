import { WorkflowImporter, parseWorkflowImport } from './workflow-importer.js';
import { WorkflowLedger } from './workflow-ledger.js';
import { createTestDatabase, type TestDatabase } from '../infrastructure/db/test-database.js';

describe('WorkflowImporter', () => {
  let database: TestDatabase;
  let importer: WorkflowImporter;

  beforeAll(() => {
    database = createTestDatabase();
    importer = new WorkflowImporter(database.client);
  });

  afterAll(async () => {
    await database.close();
  });

  it('imports a structured workflow idempotently and leaves old history as summaries', async () => {
    const input = parseWorkflowImport({
      schemaVersion: 1,
      importKey: 'legacy-1',
      project: { key: 'carara', name: 'Carará', rootPath: '/tmp/carara' },
      repositories: [{ key: 'api', path: '/tmp/carara/api', expectedBranch: 'dev' }],
      templates: [{
        key: 'carara-gates',
        name: 'G0-G7',
        definition: { phases: ['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'] },
      }],
      features: [{
        key: 'E6',
        templateKey: 'carara-gates',
        name: 'Assistentes',
        summary: 'Runtime operacional',
        currentPhaseKey: 'G3',
        items: [{
          key: '05',
          phaseKey: 'G3',
          position: 5,
          title: 'Tools',
          state: 'READY',
          tddPolicy: 'REQUIRED',
          useCases: [{
            key: 'UC-01',
            title: 'Executar',
            actor: 'Assistant',
            preconditions: 'autorizado',
            trigger: 'lote',
            expectedOutcome: 'resultado',
          }],
          criteria: [{ key: 'AC-01', statement: 'Sem vazamento' }],
          tests: [{ key: 'T-01', name: 'falha', purpose: 'RED', criterionKey: 'AC-01' }],
        }],
      }],
      summaries: [{
        featureKey: 'E6',
        scopeKey: 'legacy:E5.1',
        state: 'CLOSED',
        result: 'PASS',
        delivered: { summary: 'Estação operacional entregue' },
        commits: ['abc123'],
        validations: [{ result: 'PASS' }],
        limitations: [],
      }],
    });

    await expect(importer.import(input)).resolves.toMatchObject({ imported: true });
    await expect(importer.import(input)).resolves.toMatchObject({ imported: false });

    expect(await database.client.project.count()).toBe(1);
    expect(await database.client.repository.count()).toBe(1);
    expect(await database.client.feature.count()).toBe(1);
    expect(await database.client.workItem.count()).toBe(1);
    expect(await database.client.useCase.count()).toBe(1);
    expect(await database.client.historySummary.count()).toBe(1);
    expect(await database.client.workflowEvent.count({ where: { type: 'IMPORT_APPLIED' } })).toBe(1);

    const context = await new WorkflowLedger(database.client).getContext({
      projectKey: 'carara',
      featureKey: 'E6',
    });
    expect(context.current.itemKey).toBe('05');
    expect(context.olderSummaries[0]).toEqual({
      key: 'legacy:E5.1',
      summary: 'Estação operacional entregue',
    });
  });

  it('rejects a repository outside the project root', async () => {
    const input = parseWorkflowImport({
      schemaVersion: 1,
      importKey: 'invalid-1',
      project: { key: 'invalid', name: 'Invalid', rootPath: '/tmp/project' },
      repositories: [{ key: 'outside', path: '/tmp/outside' }],
    });

    await expect(importer.import(input)).rejects.toMatchObject({
      code: 'REPOSITORY_PATH_INVALID',
    });
    expect(await database.client.project.findUnique({ where: { key: 'invalid' } })).toBeNull();
  });

  it('imports validation evidence with its profile without duplicating it on replay', async () => {
    const input = parseWorkflowImport({
      schemaVersion: 1,
      importKey: 'runs-1',
      project: { key: 'runs', name: 'Runs', rootPath: '/tmp/runs' },
      repositories: [{ key: 'api', path: '/tmp/runs/api' }],
      templates: [{ key: 'default', name: 'Default', definition: {} }],
      validationProfiles: [{
        repositoryKey: 'api',
        key: 'related',
        program: 'npm',
        args: ['run', 'test:modified'],
        parser: 'JEST',
      }],
      features: [{
        key: 'F1',
        templateKey: 'default',
        name: 'Feature',
        summary: 'Feature',
        items: [{
          key: '01',
          phaseKey: 'G1',
          position: 1,
          title: 'Item',
          state: 'CLOSED',
          requirementsComplete: true,
          validations: [{
            repositoryKey: 'api',
            profileKey: 'related',
            purpose: 'CHECK',
            status: 'COMPLETED',
            resultKind: 'PASS',
            exitCode: 0,
            sha: 'sha-1',
            durationMs: 10,
            summary: { imported: true },
          }],
        }],
      }],
    });

    await expect(importer.import(input)).resolves.toMatchObject({ imported: true });
    await expect(importer.import(input)).resolves.toMatchObject({ imported: false });
    expect(await database.client.validationProfile.count({
      where: { repository: { project: { key: 'runs' } } },
    })).toBe(1);
    expect(await database.client.validationRun.count({
      where: { workItem: { feature: { project: { key: 'runs' } } } },
    })).toBe(1);
  });

  it('rolls back the entire import when a child reference is invalid', async () => {
    const input = parseWorkflowImport({
      schemaVersion: 1,
      importKey: 'invalid-reference-1',
      project: { key: 'invalid-reference', name: 'Invalid reference', rootPath: '/tmp/invalid-reference' },
      templates: [{ key: 'default', name: 'Default', definition: {} }],
      features: [{
        key: 'F1',
        templateKey: 'default',
        name: 'Feature',
        summary: 'Feature',
        items: [{
          key: '01',
          phaseKey: 'G1',
          position: 1,
          title: 'Item',
          useCases: [{
            key: 'UC-01',
            title: 'Caso',
            actor: 'agent',
            preconditions: 'pre',
            trigger: 'trigger',
            expectedOutcome: 'outcome',
          }],
          criteria: [{ key: 'AC-01', statement: 'critério', useCaseKey: 'missing' }],
        }],
      }],
    });

    await expect(importer.import(input)).rejects.toMatchObject({
      code: 'CRITERION_USE_CASE_NOT_FOUND',
    });
    expect(await database.client.project.findUnique({ where: { key: 'invalid-reference' } })).toBeNull();
  });
});
