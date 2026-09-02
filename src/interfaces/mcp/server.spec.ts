import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { WorkflowApp } from '../../application/workflow-app.js';
import { createMcpServer } from './server.js';

describe('workflow MCP server', () => {
  it('exposes the short context through the MCP protocol', async () => {
    const app = {
      ledger: {
        getContext: async () => ({
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
        }),
      },
    } as unknown as WorkflowApp;
    const server = createMcpServer(app);
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
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

    await client.close();
    await server.close();
  });
});
