import type { WorkflowApp } from '../../application/workflow-app.js';
import { WorkflowApplicationError } from '../../application/errors.js';
import { createCli } from './cli.js';

describe('workflow CLI', () => {
  it('routes a quick change start without creating a task', async () => {
    const calls: unknown[] = [];
    const app = { quickChanges: { start: async (input: unknown) => {
      calls.push(input);
      return { key: 'Q-01', status: 'OPEN' };
    } } } as unknown as WorkflowApp;
    const cli = createCli({ app, stdout: { write: () => true } });
    cli.commands.find((command) => command.name() === 'quick')
      ?.commands.find((command) => command.name() === 'start')?.exitOverride();

    await cli.parseAsync([
      'node', 'workflow', 'quick', 'start', '--project', 'carara', '--key', 'Q-01',
      '--title', 'Ajustar card', '--summary', 'Mostrar somente para gestores',
      '--requested-by', 'human:owner', '--reason', 'Mudança local e reversível',
      '--repository', 'front', '--paths', '["src/components/Card.tsx"]',
      '--risk-tags', '["ROLE_VISIBILITY"]', '--guard', 'canManageWorkspace',
    ]);

    expect(calls).toEqual([{
      projectKey: 'carara', key: 'Q-01', title: 'Ajustar card',
      summary: 'Mostrar somente para gestores', requestedBy: 'human:owner',
      eligibilityReason: 'Mudança local e reversível', repositoryKey: 'front',
      paths: ['src/components/Card.tsx'], riskTags: ['ROLE_VISIBILITY'],
      guardReference: 'canManageWorkspace',
    }]);
  });

  it('passes a visual PATCH contract to the ledger', async () => {
    const calls: unknown[] = [];
    const app = { ledger: { createTask: async (input: unknown) => {
      calls.push(input);
      return { item: { state: 'READY' } };
    } } } as unknown as WorkflowApp;
    const cli = createCli({ app, stdout: { write: () => true } });
    cli.commands.find((command) => command.name() === 'task')
      ?.commands.find((command) => command.name() === 'create')?.exitOverride();
    await cli.parseAsync([
      'node', 'workflow', 'task', 'create', '--project', 'carara',
      '--type', 'PATCH', '--key', 'UI-01', '--title', 'Repaginar tela',
      '--summary', 'Alterar a biblioteca',
      '--scope', '{"repositories":[{"repositoryKey":"front","paths":["src/pages/Example.tsx"]}]}',
      '--risk-tags', '["VISUAL_ONLY"]',
      '--use-cases', '[{"key":"UC-01","title":"Consultar","actor":"operador","preconditions":"workspace selecionado","trigger":"abre a tela","expectedOutcome":"encontra o modelo"}]',
      '--criteria', '[{"key":"AC-01","statement":"tela utilizável","useCaseKey":"UC-01","evidenceKind":"UI"}]',
      '--tests', '[{"key":"T-01","name":"jornada UI","purpose":"GREEN","runnerProfileKey":"front-ui","criterionKey":"AC-01"}]',
    ]);
    expect(calls[0]).toMatchObject({
      riskTags: ['VISUAL_ONLY'],
      useCases: [{ actor: 'operador' }],
      criteria: [{ evidenceKind: 'UI' }],
      tests: [{ runnerProfileKey: 'front-ui' }],
    });
  });

  it('routes validation-plan amendments with parsed risk tags and tests', async () => {
    const calls: unknown[] = [];
    const app = { ledger: { amendDraftValidationPlan: async (input: unknown) => {
      calls.push(input);
      return { key: '01', state: 'DRAFT' };
    } } } as unknown as WorkflowApp;
    const cli = createCli({ app, stdout: { write: () => true } });
    cli.commands.find((command) => command.name() === 'item')
      ?.commands.find((command) => command.name() === 'amend-validation-plan')?.exitOverride();

    await cli.parseAsync([
      'node', 'workflow', 'item', 'amend-validation-plan',
      '--project', 'carara', '--feature', 'E28', '--item', '01A',
      '--risk-tags', '["API_WRITE"]',
      '--tests', '[{"key":"T-01","name":"integra API","purpose":"GREEN","runnerProfileKey":"e28-api-checklist-tests","criterionKey":"AC-01"}]',
    ]);

    expect(calls).toEqual([{
      projectKey: 'carara',
      featureKey: 'E28',
      itemKey: '01A',
      riskTags: ['API_WRITE'],
      tests: [{
        key: 'T-01',
        name: 'integra API',
        purpose: 'GREEN',
        runnerProfileKey: 'e28-api-checklist-tests',
        criterionKey: 'AC-01',
      }],
    }]);
  });

  it('binds runner selectors to planned tests with the active execution fence', async () => {
    const calls: unknown[] = [];
    const app = { ledger: { bindTestSelectors: async (input: unknown) => {
      calls.push(input);
      return { key: '01' };
    } } } as unknown as WorkflowApp;
    const cli = createCli({ app, stdout: { write: () => true } });
    cli.commands.find((command) => command.name() === 'item')
      ?.commands.find((command) => command.name() === 'bind-test-selectors')?.exitOverride();

    await cli.parseAsync([
      'node', 'workflow', 'item', 'bind-test-selectors',
      '--project', 'workflow', '--feature', 'P9', '--item', '01',
      '--tests', '[{"key":"T-01","testSelector":"src/example.spec.ts::example behavior","runnerProfileKey":"workflow-json"}]',
      '--fence', '7',
    ]);

    expect(calls).toEqual([{
      projectKey: 'workflow',
      featureKey: 'P9',
      itemKey: '01',
      tests: [{
        key: 'T-01',
        testSelector: 'src/example.spec.ts::example behavior',
        runnerProfileKey: 'workflow-json',
      }],
      executionFence: 7,
    }]);
  });

  it('passes structured arguments to the ledger and supports compact JSON output', async () => {
    const calls: unknown[] = [];
    const result = { id: 'project-1', key: 'carara' };
    const app = {
      ledger: {
        createProject: async (input: unknown) => {
          calls.push(input);
          return result;
        },
      },
    } as unknown as WorkflowApp;
    const output: string[] = [];
    const cli = createCli({
      app,
      stdout: { write: (value) => {
        output.push(value);
        return true;
      } },
    });

    await cli.parseAsync([
      'node',
      'workflow',
      '--json',
      'project',
      'create',
      '--key',
      'carara',
      '--name',
      'Carará',
      '--root',
      '/tmp/carara',
    ]);

    expect(calls).toEqual([
      { key: 'carara', name: 'Carará', rootPath: '/tmp/carara' },
    ]);
    expect(output).toEqual(['{"id":"project-1","key":"carara"}\n']);
  });

  it('routes metrics and read-only E2E preflight commands', async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const app = {
      ledger: {
        getCycleMetrics: async (input: unknown) => {
          calls.push({ operation: 'metrics', input });
          return { source: 'LIVE', validations: { attempts: 2 } };
        },
      },
    } as unknown as WorkflowApp;
    const output: string[] = [];
    const cli = createCli({
      app,
      stdout: { write: (value) => {
        output.push(value);
        return true;
      } },
    });

    await cli.parseAsync([
      'node', 'workflow', 'metrics', '--project', 'workflow', '--feature', 'P9', '--item', '03',
    ]);
    await cli.parseAsync([
      'node', 'workflow', 'preflight', 'e2e', '--target', 'chat checklist',
    ]);

    expect(calls).toEqual([{
      operation: 'metrics',
      input: { projectKey: 'workflow', featureKey: 'P9', itemKey: '03' },
    }]);
    expect(JSON.parse(output[0])).toMatchObject({ source: 'LIVE' });
    expect(JSON.parse(output[1])).toMatchObject({
      target: 'chat checklist',
      safety: { automaticMigrations: false, destructiveOperations: false },
    });
  });

  it('rejects malformed JSON before invoking a write operation', async () => {
    let called = false;
    const app = {
      ledger: {
        createTemplate: async () => {
          called = true;
          return {};
        },
      },
    } as unknown as WorkflowApp;
    const cli = createCli({ app, stdout: { write: () => true } });

    await expect(cli.parseAsync([
      'node',
      'workflow',
      'template',
      'create',
      '--project',
      'carara',
      '--key',
      'default',
      '--name',
      'Default',
      '--definition',
      '{invalid',
    ])).rejects.toBeInstanceOf(WorkflowApplicationError);
    expect(called).toBe(false);
  });

  it('prints a failure excerpt and points to confirmation without rerunning it', async () => {
    const app = {
      ledger: {
        getValidationLog: async () => ({
          id: 'validation-1',
          purpose: 'RED',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          expiresAt: new Date('2026-01-08T00:00:00.000Z'),
          text: 'Cannot find module ./missing',
        }),
      },
      validation: {
        run: async () => ({
          validation: {
            id: 'validation-1',
            status: 'COMPLETED',
            resultKind: 'TEST_FAILURE',
            sha: 'sha-1',
            durationMs: 25,
            logBlob: new Uint8Array([1]),
          },
          classification: {
            status: 'COMPLETED',
            resultKind: 'TEST_FAILURE',
            redEvidenceKind: 'STRUCTURAL',
          },
          reused: false,
          itemState: 'TESTS_DEFINED',
          actionRequired: 'STRUCTURAL_RED_REASON_REQUIRED',
        }),
      },
    } as unknown as WorkflowApp;
    const output: string[] = [];
    const cli = createCli({
      app,
      stdout: { write: (value) => {
        output.push(value);
        return true;
      } },
    });

    await cli.parseAsync([
      'node',
      'workflow',
      '--json',
      'validate',
      'run',
      '--project',
      'carara',
      '--feature',
      'E6',
      '--item',
      '01',
      '--repository',
      'api',
      '--profile',
      'related',
      '--purpose',
      'RED',
    ]);

    const result = JSON.parse(output[0]) as Record<string, unknown>;
    expect(result.logExcerpt).toBe('Cannot find module ./missing');
    expect(result.nextAction).toMatchObject({
      command: 'validate confirm-red',
      validationId: 'validation-1',
      rerunRequired: false,
    });
  });

  it('reads a retained log and confirms structural RED through explicit commands', async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const app = {
      ledger: {
        getValidationLog: async (input: unknown) => {
          calls.push({ operation: 'log', input });
          return { id: 'validation-1', purpose: 'RED', text: 'raw output' };
        },
        confirmStructuralRed: async (input: unknown) => {
          calls.push({ operation: 'confirm', input });
          return { id: 'item-1', state: 'RED_CONFIRMED' };
        },
      },
    } as unknown as WorkflowApp;
    const output: string[] = [];
    const cli = createCli({
      app,
      stdout: { write: (value) => {
        output.push(value);
        return true;
      } },
    });

    await cli.parseAsync([
      'node',
      'workflow',
      'validate',
      'log',
      '--project',
      'carara',
      '--feature',
      'E6',
      '--item',
      '01',
      '--validation',
      'validation-1',
      '--raw',
    ]);
    await cli.parseAsync([
      'node',
      'workflow',
      'validate',
      'confirm-red',
      '--project',
      'carara',
      '--feature',
      'E6',
      '--item',
      '01',
      '--validation',
      'validation-1',
      '--reason',
      'módulo ainda não existe',
    ]);

    expect(output[0]).toBe('raw output\n');
    expect(JSON.parse(output[1])).toEqual({ id: 'item-1', state: 'RED_CONFIRMED' });
    expect(calls).toEqual([
      {
        operation: 'log',
        input: {
          projectKey: 'carara',
          featureKey: 'E6',
          itemKey: '01',
          validationId: 'validation-1',
        },
      },
      {
        operation: 'confirm',
        input: {
          projectKey: 'carara',
          featureKey: 'E6',
          itemKey: '01',
          validationId: 'validation-1',
          reason: 'módulo ainda não existe',
        },
      },
    ]);
  });

  it('routes inspection commands to the ledger read operations', async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const app = {
      ledger: {
        listValidations: async (input: unknown) => {
          calls.push({ operation: 'listValidations', input });
          return { validations: [{ id: 'validation-1', purpose: 'GREEN' }] };
        },
        getRecord: async (input: unknown) => {
          calls.push({ operation: 'getRecord', input });
          return { item: { key: '01', state: 'IMPLEMENTING' } };
        },
        listRepositories: async (input: unknown) => {
          calls.push({ operation: 'listRepositories', input });
          return { repositories: [] };
        },
      },
    } as unknown as WorkflowApp;
    const output: string[] = [];
    const cli = createCli({
      app,
      stdout: { write: (value) => {
        output.push(value);
        return true;
      } },
    });

    await cli.parseAsync([
      'node',
      'workflow',
      'validate',
      'list',
      '--project',
      'carara',
      '--feature',
      'E6',
      '--item',
      '01',
      '--purpose',
      'GREEN',
    ]);
    await cli.parseAsync([
      'node',
      'workflow',
      'item',
      'record',
      '--project',
      'carara',
      '--feature',
      'E6',
      '--item',
      '01',
    ]);
    await cli.parseAsync([
      'node',
      'workflow',
      'repository',
      'list',
      '--project',
      'carara',
    ]);

    expect(calls).toEqual([
      {
        operation: 'listValidations',
        input: { projectKey: 'carara', featureKey: 'E6', itemKey: '01', purpose: 'GREEN' },
      },
      {
        operation: 'getRecord',
        input: { projectKey: 'carara', featureKey: 'E6', itemKey: '01' },
      },
      {
        operation: 'listRepositories',
        input: { projectKey: 'carara', includeProfiles: false },
      },
    ]);
    expect(JSON.parse(output[0])).toMatchObject({ validations: [{ id: 'validation-1' }] });
    expect(JSON.parse(output[1])).toMatchObject({ item: { key: '01' } });
  });

  it('routes plan check to the read-only planning audit', async () => {
    const calls: unknown[] = [];
    const app = {
      ledger: {
        checkPlan: async (input: unknown) => {
          calls.push(input);
          return { project: 'workflow', feature: { key: 'P1' }, items: [] };
        },
      },
    } as unknown as WorkflowApp;
    const output: string[] = [];
    const cli = createCli({
      app,
      stdout: { write: (value) => {
        output.push(value);
        return true;
      } },
    });

    await cli.parseAsync([
      'node',
      'workflow',
      '--json',
      'plan',
      'check',
      '--project',
      'workflow',
      '--feature',
      'P1',
    ]);

    expect(calls).toEqual([{ projectKey: 'workflow', featureKey: 'P1' }]);
    expect(JSON.parse(output[0])).toMatchObject({ project: 'workflow', feature: { key: 'P1' } });
  });

  it('routes slice-size exception requests without approving them', async () => {
    const calls: unknown[] = [];
    const app = {
      ledger: {
        requestSliceSizeException: async (input: unknown) => {
          calls.push(input);
          return { pending: { key: 'SIZE-REQUEST' }, item: { state: 'DRAFT' } };
        },
      },
    } as unknown as WorkflowApp;
    const output: string[] = [];
    const cli = createCli({
      app,
      stdout: { write: (value) => {
        output.push(value);
        return true;
      } },
    });

    await cli.parseAsync([
      'node',
      'workflow',
      '--json',
      'item',
      'request-size-exception',
      '--project',
      'workflow',
      '--feature',
      'P1',
      '--item',
      '01',
      '--actor',
      'planner',
      '--reason',
      'gate indivisível',
    ]);

    expect(calls).toEqual([{
      projectKey: 'workflow',
      featureKey: 'P1',
      itemKey: '01',
      actor: 'planner',
      reason: 'gate indivisível',
    }]);
    expect(JSON.parse(output[0])).toMatchObject({ pending: { key: 'SIZE-REQUEST' } });
  });

  it('maps decision and pending commands to the ledger with scope and flags', async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const app = {
      ledger: {
        recordDecision: async (input: unknown) => {
          calls.push({ operation: 'recordDecision', input });
          return { key: 'DEC-01' };
        },
        listDecisions: async (input: unknown) => {
          calls.push({ operation: 'listDecisions', input });
          return { decisions: [] };
        },
        recordPendingItem: async (input: unknown) => {
          calls.push({ operation: 'recordPendingItem', input });
          return { key: 'PEND-01' };
        },
        listPendingItems: async (input: unknown) => {
          calls.push({ operation: 'listPendingItems', input });
          return { pendingItems: [] };
        },
        resolvePendingItem: async (input: unknown) => {
          calls.push({ operation: 'resolvePendingItem', input });
          return { key: 'PEND-01', resolved: true };
        },
      },
    } as unknown as WorkflowApp;
    const output: string[] = [];
    const cli = createCli({
      app,
      stdout: { write: (value) => {
        output.push(value);
        return true;
      } },
    });

    await cli.parseAsync([
      'node',
      'workflow',
      'decision',
      'add',
      '--project',
      'carara',
      '--feature',
      'E6',
      '--item',
      '01',
      '--key',
      'DEC-01',
      '--title',
      'Fonte única',
      '--content',
      'O ledger é a fonte',
      '--pin',
    ]);
    await cli.parseAsync([
      'node',
      'workflow',
      'decision',
      'list',
      '--project',
      'carara',
    ]);
    await cli.parseAsync([
      'node',
      'workflow',
      'pending',
      'add',
      '--project',
      'carara',
      '--feature',
      'E6',
      '--key',
      'PEND-01',
      '--description',
      'Definir perfil',
      '--blocking',
    ]);
    await cli.parseAsync([
      'node',
      'workflow',
      'pending',
      'list',
      '--project',
      'carara',
    ]);
    await cli.parseAsync([
      'node',
      'workflow',
      'pending',
      'resolve',
      '--project',
      'carara',
      '--key',
      'PEND-01',
      '--reason',
      'perfil registrado',
    ]);

    expect(calls).toEqual([
      {
        operation: 'recordDecision',
        input: {
          projectKey: 'carara',
          featureKey: 'E6',
          itemKey: '01',
          key: 'DEC-01',
          title: 'Fonte única',
          content: 'O ledger é a fonte',
          durable: true,
          pinned: true,
        },
      },
      {
        operation: 'listDecisions',
        input: { projectKey: 'carara', includeContent: false },
      },
      {
        operation: 'recordPendingItem',
        input: {
          projectKey: 'carara',
          featureKey: 'E6',
          itemKey: undefined,
          key: 'PEND-01',
          description: 'Definir perfil',
          blocking: true,
          pinned: false,
        },
      },
      {
        operation: 'listPendingItems',
        input: { projectKey: 'carara', resolution: 'OPEN' },
      },
      {
        operation: 'resolvePendingItem',
        input: { projectKey: 'carara', key: 'PEND-01', reason: 'perfil registrado' },
      },
    ]);
    expect(JSON.parse(output[4])).toEqual({ key: 'PEND-01', resolved: true });
  });

  it('defaults review findings to an empty array when the flag is omitted', async () => {
    let received: { findings?: unknown } | undefined;
    const app = {
      ledger: {
        submitReview: async (input: { findings?: unknown }) => {
          received = input;
          return { id: 'review-1', verdict: 'APPROVED' };
        },
      },
    } as unknown as WorkflowApp;
    const cli = createCli({ app, stdout: { write: () => true } });

    await cli.parseAsync([
      'node',
      'workflow',
      'review',
      'submit',
      '--project',
      'carara',
      '--feature',
      'E6',
      '--item',
      '01',
      '--reviewer',
      'reviewer',
      '--verdict',
      'APPROVED',
      '--summary',
      'Critérios atendidos',
    ]);

    expect(received?.findings).toEqual([]);
  });

  it('uses compact, scoped discovery commands by default', async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const app = {
      ledger: {
        listFeatures: async (input: unknown) => {
          calls.push({ operation: 'listFeatures', input });
          return { project: 'carara', features: [] };
        },
        listRepositories: async (input: unknown) => {
          calls.push({ operation: 'listRepositories', input });
          return { project: 'carara', repositories: [] };
        },
        listDecisions: async (input: unknown) => {
          calls.push({ operation: 'listDecisions', input });
          return { project: 'carara', decisions: [] };
        },
        listPendingItems: async (input: unknown) => {
          calls.push({ operation: 'listPendingItems', input });
          return { project: 'carara', pendingItems: [] };
        },
        getReadyFrontier: async (input: unknown) => {
          calls.push({ operation: 'getReadyFrontier', input });
          return { project: 'carara', features: [] };
        },
      },
    } as unknown as WorkflowApp;
    const cli = createCli({ app, stdout: { write: () => true } });

    await cli.parseAsync(['node', 'workflow', 'feature', 'list', '--project', 'carara']);
    await cli.parseAsync(['node', 'workflow', 'repository', 'list', '--project', 'carara']);
    await cli.parseAsync(['node', 'workflow', 'decision', 'list', '--project', 'carara']);
    await cli.parseAsync(['node', 'workflow', 'pending', 'list', '--project', 'carara']);
    await cli.parseAsync(['node', 'workflow', 'frontier', '--project', 'carara']);
    await cli.parseAsync([
      'node', 'workflow', 'feature', 'show', '--project', 'carara', '--feature', 'E18',
    ]);
    await cli.parseAsync([
      'node', 'workflow', 'repository', 'list', '--project', 'carara',
      '--repository', 'api', '--include-profiles',
    ]);
    await cli.parseAsync([
      'node', 'workflow', 'decision', 'list', '--project', 'carara',
      '--feature', 'E18', '--item', '08A', '--include-content',
    ]);
    await cli.parseAsync([
      'node', 'workflow', 'pending', 'list', '--project', 'carara',
      '--feature', 'E18', '--item', '08A', '--status', 'RESOLVED',
    ]);

    expect(calls).toEqual([
      {
        operation: 'listFeatures',
        input: { projectKey: 'carara', includeItems: false },
      },
      {
        operation: 'listRepositories',
        input: { projectKey: 'carara', includeProfiles: false },
      },
      {
        operation: 'listDecisions',
        input: { projectKey: 'carara', includeContent: false },
      },
      {
        operation: 'listPendingItems',
        input: { projectKey: 'carara', resolution: 'OPEN' },
      },
      {
        operation: 'getReadyFrontier',
        input: {
          projectKey: 'carara',
          includeEmptyFeatures: false,
          includeClosedDependencies: false,
        },
      },
      {
        operation: 'listFeatures',
        input: { projectKey: 'carara', featureKey: 'E18', includeItems: true },
      },
      {
        operation: 'listRepositories',
        input: { projectKey: 'carara', repositoryKey: 'api', includeProfiles: true },
      },
      {
        operation: 'listDecisions',
        input: {
          projectKey: 'carara',
          featureKey: 'E18',
          itemKey: '08A',
          includeContent: true,
        },
      },
      {
        operation: 'listPendingItems',
        input: {
          projectKey: 'carara',
          featureKey: 'E18',
          itemKey: '08A',
          resolution: 'RESOLVED',
        },
      },
    ]);
  });
});
