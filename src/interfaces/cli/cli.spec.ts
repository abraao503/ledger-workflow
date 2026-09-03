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
});
