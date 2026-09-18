import type { WorkflowApp } from '../../application/workflow-app.js';
import { createCli } from './cli.js';

describe('planning contract CLI inputs', () => {
  it('passes risk, evidence, polarity, and validation capabilities to the ledger', async () => {
    const calls: Array<{ operation: string; input: unknown }> = [];
    const app = {
      ledger: {
        defineWorkItem: async (input: unknown) => {
          calls.push({ operation: 'defineWorkItem', input });
          return { item: { key: '01' } };
        },
        createValidationProfile: async (input: unknown) => {
          calls.push({ operation: 'createValidationProfile', input });
          return { key: 'workflow-integration' };
        },
      },
    } as unknown as WorkflowApp;
    const cli = createCli({ app, stdout: { write: () => true } });
    cli.exitOverride();
    cli.commands
      .flatMap((command) => [command, ...command.commands])
      .forEach((command) => command.exitOverride());

    await cli.parseAsync([
      'node',
      'workflow',
      'item',
      'define',
      '--project',
      'workflow',
      '--feature',
      'P7',
      '--key',
      '01',
      '--phase',
      'G3',
      '--position',
      '1',
      '--title',
      'Contratos',
      '--risk-tags',
      '["API_WRITE","PRIVATE_DATA"]',
      '--use-cases',
      '[{"key":"UC-01","title":"Planejar","actor":"agent","preconditions":"projeto","trigger":"definição","expectedOutcome":"resultado"}]',
      '--criteria',
      '[{"key":"AC-01","statement":"persiste","useCaseKey":"UC-01","evidenceKind":"PERSISTENCE","polarity":"EXPECTED"}]',
      '--tests',
      '[{"key":"T-01","name":"teste","purpose":"GREEN","criterionKey":"AC-01"}]',
    ]);

    await cli.parseAsync([
      'node',
      'workflow',
      'validation-profile',
      'add',
      '--project',
      'workflow',
      '--repository',
      'workflow',
      '--key',
      'workflow-integration',
      '--program',
      'npm',
      '--args',
      '["test"]',
      '--capabilities',
      '["API_INTEGRATION","READ_AFTER_WRITE"]',
    ]);

    expect(calls).toEqual([
      {
        operation: 'defineWorkItem',
        input: expect.objectContaining({
          riskTags: ['API_WRITE', 'PRIVATE_DATA'],
          criteria: [{
            key: 'AC-01',
            statement: 'persiste',
            useCaseKey: 'UC-01',
            evidenceKind: 'PERSISTENCE',
            polarity: 'EXPECTED',
          }],
        }),
      },
      {
        operation: 'createValidationProfile',
        input: expect.objectContaining({
          capabilities: ['API_INTEGRATION', 'READ_AFTER_WRITE'],
        }),
      },
    ]);
  });
});
