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
        listFeatures: async (input: string | { projectKey: string }) => ({
          project: typeof input === 'string' ? input : input.projectKey,
          features: [],
        }),
        listRepositories: async (projectKey: string) => ({ project: projectKey, repositories: [] }),
        listDecisions: async (projectKey: string) => ({ project: projectKey, decisions: [] }),
        listPendingItems: async (projectKey: string) => ({ project: projectKey, pendingItems: [] }),
        checkPlan: async (input: { projectKey: string; featureKey: string }) => ({
          project: input.projectKey,
          feature: { key: input.featureKey },
          items: [],
        }),
        requestSliceSizeException: async (input: unknown) => ({
          pending: { key: 'SIZE-REQUEST', input },
          item: { state: 'DRAFT' },
        }),
        createTask: async (input: unknown) => ({ taskType: 'PATCH', input }),
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
      'workflow_add_dependency',
      'workflow_authorize',
      'workflow_authorize_integration',
      'workflow_claim_item',
      'workflow_cleanup_worktrees',
      'workflow_request_slice_size_exception',
      'workflow_compact_history',
      'workflow_confirm_structural_red',
      'workflow_context',
      'workflow_create_task',
      'workflow_decision_record',
      'workflow_define_item',
      'workflow_integrate_item',
      'workflow_invalidate_green',
      'workflow_list_dependencies',
      'workflow_list_decisions',
      'workflow_list_features',
      'workflow_list_pending',
      'workflow_list_projects',
      'workflow_list_repositories',
      'workflow_list_validations',
      'workflow_pending_record',
      'workflow_pending_resolve',
      'workflow_plan_check',
      'workflow_prepare_integration',
      'workflow_ready_frontier',
      'workflow_record',
      'workflow_reconcile_item_leases',
      'workflow_replan_item',
      'workflow_recover_item_lease',
      'workflow_release_item_lease',
      'workflow_remove_dependency',
      'workflow_reopen',
      'workflow_renew_item_lease',
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

    const taskResult = await client.callTool({
      name: 'workflow_create_task',
      arguments: {
        projectKey: 'carara',
        type: 'PATCH',
        key: 'P1',
        title: 'Ajuste pontual',
        summary: 'Correção simples',
      },
    });
    expect(taskResult.isError).not.toBe(true);
    expect(taskResult.content).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('"taskType":"PATCH"'),
      },
    ]);
    const visualTaskResult = await client.callTool({
      name: 'workflow_create_task',
      arguments: {
        projectKey: 'carara', type: 'PATCH', key: 'UI-01',
        title: 'Repaginar tela', summary: 'Alterar a biblioteca',
        scope: { repositories: [{ repositoryKey: 'front', paths: ['src/pages/Example.tsx'] }] },
        riskTags: ['VISUAL_ONLY'],
        useCases: [{
          key: 'UC-01', title: 'Consultar', actor: 'operador',
          preconditions: 'workspace selecionado', trigger: 'abre a tela',
          expectedOutcome: 'encontra o modelo',
        }],
        criteria: [{
          key: 'AC-01', statement: 'tela utilizável',
          useCaseKey: 'UC-01', evidenceKind: 'UI',
        }],
        tests: [{
          key: 'T-01', name: 'jornada UI', purpose: 'GREEN',
          runnerProfileKey: 'front-ui', criterionKey: 'AC-01',
        }],
      },
    });
    expect(visualTaskResult.isError).not.toBe(true);
    expect(visualTaskResult.content).toEqual([{
      type: 'text', text: expect.stringContaining('"riskTags":["VISUAL_ONLY"]'),
    }]);

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

    const requestResult = await client.callTool({
      name: 'workflow_request_slice_size_exception',
      arguments: {
        projectKey: 'carara',
        featureKey: 'E6',
        itemKey: '05',
        actor: 'agent:planner',
        reason: 'gate indivisível',
      },
    });
    expect(requestResult.isError).not.toBe(true);
    expect(requestResult.content).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('SIZE-REQUEST'),
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

  it('passes compact and scoped discovery options to the ledger', async () => {
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
    const server = createMcpServer(app);
    const client = new Client({ name: 'discovery-test-client', version: '0.1.0' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.callTool({
      name: 'workflow_list_features',
      arguments: { projectKey: 'carara', includeItems: false },
    });
    await client.callTool({
      name: 'workflow_list_repositories',
      arguments: { projectKey: 'carara', includeProfiles: false },
    });
    await client.callTool({
      name: 'workflow_list_decisions',
      arguments: { projectKey: 'carara', featureKey: 'E18', itemKey: '08A', includeContent: false },
    });
    await client.callTool({
      name: 'workflow_list_pending',
      arguments: { projectKey: 'carara', featureKey: 'E18', itemKey: '08A', resolution: 'OPEN' },
    });
    await client.callTool({
      name: 'workflow_ready_frontier',
      arguments: { projectKey: 'carara', includeEmptyFeatures: false, includeClosedDependencies: false },
    });

    expect(calls).toEqual([
      { operation: 'listFeatures', input: { projectKey: 'carara', includeItems: false } },
      { operation: 'listRepositories', input: { projectKey: 'carara', includeProfiles: false } },
      {
        operation: 'listDecisions',
        input: { projectKey: 'carara', featureKey: 'E18', itemKey: '08A', includeContent: false },
      },
      {
        operation: 'listPendingItems',
        input: { projectKey: 'carara', featureKey: 'E18', itemKey: '08A', resolution: 'OPEN' },
      },
      {
        operation: 'getReadyFrontier',
        input: { projectKey: 'carara', includeEmptyFeatures: false, includeClosedDependencies: false },
      },
    ]);

    await client.close();
    await server.close();
  });
});
