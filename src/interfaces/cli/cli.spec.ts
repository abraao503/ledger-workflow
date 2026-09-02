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
});
