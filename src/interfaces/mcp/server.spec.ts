import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { WorkflowApplicationError } from '../../application/errors.js';
import type { WorkflowApp } from '../../application/workflow-app.js';
import { createMcpServer } from './server.js';

describe('workflow MCP server', () => {
  it('exposes the short context through the MCP protocol', async () => {
    const app = {
      ledger: {
        listProjects: async () => ({ projects: [{ key: 'carara', name: 'Carará', status: 'ACTIVE' }] }),
        listFeatures: async (projectKey: string) => ({ project: projectKey, features: [] }),
        listRepositories: async (projectKey: string) => ({ project: projectKey, repositories: [] }),
        listDecisions: async (projectKey: string) => ({ project: projectKey, decisions: [] }),
        listPendingItems: async (projectKey: string) => ({ project: projectKey, pendingItems: [] }),
        checkPlan: async (input: { projectKey: string; featureKey: string }) => ({
          project: input.projectKey,
          feature: { key: input.featureKey },
          items: [],
        }),
        approveSliceSize: async (input: unknown) => ({
          decision: { key: 'SIZE-APPROVAL', input },
          item: { state: 'DRAFT' },
        }),
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
        getValidationLog: async () => ({
          id: 'validation-1',
          purpose: 'RED',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          expiresAt: new Date('2026-01-08T00:00:00.000Z'),
          text: 'raw output',
        }),
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
      'workflow_approve_slice_size',
      'workflow_compact_history',
      'workflow_confirm_structural_red',
      'workflow_context',
      'workflow_decision_record',
      'workflow_define_item',
      'workflow_invalidate_green',
      'workflow_list_decisions',
      'workflow_list_features',
      'workflow_list_pending',
      'workflow_list_projects',
      'workflow_list_repositories',
      'workflow_list_validations',
      'workflow_pending_record',
        'workflow_pending_resolve',
        'workflow_plan_check',
        'workflow_record',
      'workflow_reopen',
      'workflow_review',
      'workflow_transition',
      'workflow_validate',
      'workflow_validation_log',
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

    const catalogResult = await client.callTool({
      name: 'workflow_list_features',
      arguments: { projectKey: 'carara' },
    });
    expect(catalogResult.isError).not.toBe(true);
    expect(catalogResult.content).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('"project":"carara"'),
      },
    ]);

    const planResult = await client.callTool({
      name: 'workflow_plan_check',
      arguments: { projectKey: 'carara', featureKey: 'E6' },
    });
    expect(planResult.isError).not.toBe(true);
    expect(planResult.content).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('"feature":{"key":"E6"'),
      },
    ]);

    const approvalResult = await client.callTool({
      name: 'workflow_approve_slice_size',
      arguments: {
        projectKey: 'carara',
        featureKey: 'E6',
        itemKey: '05',
        actor: 'planner',
        reason: 'gate indivisível',
      },
    });
    expect(approvalResult.isError).not.toBe(true);
    expect(approvalResult.content).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('SIZE-APPROVAL'),
      },
    ]);

    const logResult = await client.callTool({
      name: 'workflow_validation_log',
      arguments: {
        projectKey: 'carara',
        featureKey: 'E6',
        itemKey: '05',
        validationId: 'validation-1',
      },
    });
    expect(logResult.isError).not.toBe(true);
    expect(logResult.content).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('raw output'),
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
