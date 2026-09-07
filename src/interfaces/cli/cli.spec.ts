import type { WorkflowApp } from '../../application/workflow-app.js';
import { WorkflowApplicationError } from '../../application/errors.js';
import { createCli } from './cli.js';

describe('workflow CLI', () => {
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
      { operation: 'listRepositories', input: 'carara' },
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
      { operation: 'listDecisions', input: 'carara' },
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
      { operation: 'listPendingItems', input: 'carara' },
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
});
