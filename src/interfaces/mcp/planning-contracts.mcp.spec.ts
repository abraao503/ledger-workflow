import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import type { WorkflowApp } from '../../application/workflow-app.js';
import { createMcpServer } from './server.js';

describe('planning contract MCP inputs', () => {
  it('accepts structured risk and evidence metadata when defining an item', async () => {
    const calls: unknown[] = [];
    const app = {
      ledger: {
        defineWorkItem: async (input: unknown) => {
          calls.push(input);
          return { item: { key: '01' } };
        },
      },
    } as unknown as WorkflowApp;
    const server = createMcpServer(app);
    const client = new Client({ name: 'planning-contract-test', version: '0.1.0' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: 'workflow_define_item',
      arguments: {
        projectKey: 'workflow',
        featureKey: 'P7',
        key: '01',
        phaseKey: 'G3',
        position: 1,
        title: 'Contratos',
        riskTags: ['API_WRITE', 'PRIVATE_DATA'],
        useCases: [{
          key: 'UC-01',
          title: 'Planejar',
          actor: 'agent',
          preconditions: 'projeto',
          trigger: 'definição',
          expectedOutcome: 'resultado',
        }],
        criteria: [{
          key: 'AC-01',
          statement: 'persiste',
          useCaseKey: 'UC-01',
          evidenceKind: 'PERSISTENCE',
          polarity: 'EXPECTED',
        }],
        tests: [{
          key: 'T-01',
          name: 'teste',
          purpose: 'GREEN',
          criterionKey: 'AC-01',
        }],
      },
    });

    expect(result.isError).not.toBe(true);
    expect(calls).toEqual([expect.objectContaining({
      riskTags: ['API_WRITE', 'PRIVATE_DATA'],
      criteria: [expect.objectContaining({
        evidenceKind: 'PERSISTENCE',
        polarity: 'EXPECTED',
      })],
    })]);

    await client.close();
    await server.close();
  });
});
