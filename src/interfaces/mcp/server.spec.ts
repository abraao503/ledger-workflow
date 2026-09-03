import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { WorkflowApplicationError } from '../../application/errors.js';
import type { WorkflowApp } from '../../application/workflow-app.js';
import { createMcpServer } from './server.js';

describe('workflow MCP server', () => {
  it('exposes the short context through the MCP protocol', async () => {
    const app = {
      ledger: {
        getContext: async (input: { projectKey: string }) => {
          if (input.projectKey === 'missing') {
            throw new WorkflowApplicationError('PROJECT_NOT_FOUND');
          }
          return {
            current: {
              projectKey: 'carara',
              featureKey: 'E6',
              phaseKey: 'G3',
              itemKey: '05',
              state: 'IMPLEMENTING',
            },
            baselines: [],
            acceptanceCriteria: [],
            durableDecisions: [],
            unresolvedItems: [],
            recentSlices: [],
            olderSummaries: [],
            requiredChecks: [],
          };
        },
      },
    } as unknown as WorkflowApp;
    const server = createMcpServer(app);
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      'workflow_authorize',
      'workflow_compact_history',
      'workflow_define_item',
      'workflow_record',
      'workflow_reopen',
      'workflow_review',
      'workflow_transition',
      'workflow_validate',
      'workflow_context',
    ].sort());
    const result = await client.callTool({
      name: 'workflow_context',
      arguments: { projectKey: 'carara', featureKey: 'E6', itemKey: '05' },
    });

    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('"itemKey":"05"'),
      },
    ]);

    const errorResult = await client.callTool({
      name: 'workflow_context',
      arguments: { projectKey: 'missing' },
    });
    expect(errorResult.isError).toBe(true);
    expect(errorResult.content).toEqual([
      { type: 'text', text: '[PROJECT_NOT_FOUND] PROJECT_NOT_FOUND' },
    ]);

    await client.close();
    await server.close();
  });
});
