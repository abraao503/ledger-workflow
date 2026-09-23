import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { isWorkflowApplicationError } from '../../application/workflow-ledger.js';
import type { WorkflowApp } from '../../application/workflow-app.js';
import { criterionPolarityValues, evidenceKindValues, riskTagValues } from '../../application/types.js';
import { workItemStates } from '../../domain/workflow-state.js';
import { formatValidationResult } from '../validation-output.js';

export function createMcpServer(app: WorkflowApp): McpServer {
  const server = new McpServer({
    name: '7agentes-workflow',
    version: '0.1.0',
  });

  server.registerTool(
    'workflow_list_projects',
    {
      description: 'Lista os projetos registrados; use antes de escolher projectKey.',
      inputSchema: {},
    },
    async () => runTool(() => app.ledger.listProjects()),
  );

  server.registerTool(
    'workflow_list_features',
    {
      description: 'Lista features compactas por padrão; use includeItems ou featureKey para aprofundar uma seleção.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string().optional(),
        includeItems: z.boolean().default(false),
        taskType: z.enum(['FEATURE', 'PATCH']).optional(),
      },
    },
    async (input) => runTool(() => app.ledger.listFeatures(input)),
  );

  server.registerTool(
    'workflow_create_task',
    {
      description: 'Cria uma tarefa FEATURE no modelo atual ou uma tarefa PATCH enxuta, já pronta para autorização.',
      inputSchema: {
        projectKey: z.string(),
        type: z.enum(['FEATURE', 'PATCH']),
        key: z.string(),
        title: z.string(),
        summary: z.string(),
        templateKey: z.string().optional().describe('Obrigatório para FEATURE; dispensado para PATCH.'),
        templateVersion: z.number().int().positive().optional(),
        kind: z.enum(['CODE', 'DOCUMENTATION', 'VALIDATION', 'OTHER']).optional(),
        scope: z.object({
          repositories: z.array(z.object({
            repositoryKey: z.string(),
            paths: z.array(z.string()),
          })),
        }).optional(),
        riskTags: z.enum(riskTagValues).array().optional(),
        useCases: z.array(z.object({
          key: z.string(), title: z.string(), actor: z.string(),
          preconditions: z.string(), trigger: z.string(), expectedOutcome: z.string(),
          invariants: z.array(z.string()).optional(),
        })).optional(),
        criteria: z.array(z.object({
          key: z.string(), statement: z.string(), useCaseKey: z.string().optional(),
          required: z.boolean().optional(), evidenceKind: z.enum(evidenceKindValues).optional(),
          polarity: z.enum(criterionPolarityValues).optional(),
        })).optional(),
        tests: z.array(z.object({
          key: z.string(), name: z.string(), purpose: z.enum(['RED', 'GREEN', 'CHECK']),
          runnerProfileKey: z.string().optional(), criterionKey: z.string().optional(),
        })).optional(),
      },
    },
    async (input) => runTool(() => app.ledger.createTask(input)),
  );

  server.registerTool(
    'workflow_ready_frontier',
    {
      description: 'Mostra somente folhas não terminais e classifica ação imediata, espera humana, dependência, lease ou bloqueio.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string().optional(),
        includeEmptyFeatures: z.boolean().default(false),
        includeClosedDependencies: z.boolean().default(false),
      },
    },
    async (input) => runTool(() => app.ledger.getReadyFrontier(input)),
  );

  server.registerTool(
    'workflow_plan_check',
    {
      description: 'Audita a granularidade das fatias de uma feature sem alterar o ledger.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
      },
    },
    async (input) => runTool(() => app.ledger.checkPlan(input)),
  );

  server.registerTool(
    'workflow_request_slice_size_exception',
    {
      description: 'Solicita uma exceção de granularidade sem aprovar nem liberar a fatia.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        itemKey: z.string(),
        actor: z.string(),
        reason: z.string(),
      },
    },
    async (input) => runTool(() => app.ledger.requestSliceSizeException(input)),
  );

  server.registerTool(
    'workflow_list_repositories',
    {
      description: 'Lista repositórios compactos por padrão; use repositoryKey e includeProfiles para detalhes.',
      inputSchema: {
        projectKey: z.string(),
        repositoryKey: z.string().optional(),
        includeProfiles: z.boolean().default(false),
      },
    },
    async (input) => runTool(() => app.ledger.listRepositories(input)),
  );

  server.registerTool(
    'workflow_list_decisions',
    {
      description: 'Lista decisões compactas e filtráveis; o conteúdo completo é opcional.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string().optional(),
        itemKey: z.string().optional(),
        key: z.string().optional(),
        includeContent: z.boolean().default(false),
      },
    },
    async (input) => runTool(() => app.ledger.listDecisions(input)),
  );

  server.registerTool(
    'workflow_list_pending',
    {
      description: 'Lista pendências abertas por padrão, com filtros de feature, fatia e resolução.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string().optional(),
        itemKey: z.string().optional(),
        resolution: z.enum(['OPEN', 'RESOLVED', 'ALL']).default('OPEN'),
      },
    },
    async (input) => runTool(() => app.ledger.listPendingItems(input)),
  );

  server.registerTool(
    'workflow_context',
    {
      description: 'Retorna o contexto curto da feature e da fatia; informe featureKey e itemKey para uma seleção explícita.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string().optional(),
        itemKey: z.string().optional(),
        maxChars: z.number().int().min(512).max(50_000).optional(),
      },
    },
    async (input) => runTool(() => app.ledger.getContext(input)),
  );

  server.registerTool(
    'workflow_record',
    {
      description: 'Retorna o registro detalhado recente de uma fatia, sem logs crus.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        itemKey: z.string(),
      },
    },
    async (input) => runTool(() => app.ledger.getRecord(input)),
  );

  server.registerTool(
    'workflow_list_validations',
    {
      description: 'Lista as validações registradas de uma fatia, com os ids para leitura de log.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        itemKey: z.string(),
        purpose: z.enum(['RED', 'GREEN', 'CHECK']).optional(),
      },
    },
    async (input) => runTool(() => app.ledger.listValidations(input)),
  );

  server.registerTool(
    'workflow_decision_record',
    {
      description: 'Registra (ou atualiza) uma decisão de execução; decisões duráveis aparecem no contexto.',
      inputSchema: {
        projectKey: z.string(),
        key: z.string(),
        title: z.string(),
        content: z.string(),
        featureKey: z.string().optional(),
        itemKey: z.string().optional(),
        durable: z.boolean().default(true),
        pinned: z.boolean().default(false),
      },
    },
    async (input) => runTool(() => app.ledger.recordDecision(input)),
  );

  server.registerTool(
    'workflow_pending_record',
    {
      description: 'Registra uma pendência explícita; pendências não resolvidas aparecem no contexto.',
      inputSchema: {
        projectKey: z.string(),
        key: z.string(),
        description: z.string(),
        featureKey: z.string().optional(),
        itemKey: z.string().optional(),
        blocking: z.boolean().default(false),
        pinned: z.boolean().default(false),
      },
    },
    async (input) => runTool(() => app.ledger.recordPendingItem(input)),
  );

  server.registerTool(
    'workflow_pending_resolve',
    {
      description: 'Resolve uma pendência registrada, com justificativa opcional.',
      inputSchema: {
        projectKey: z.string(),
        key: z.string(),
        reason: z.string().optional(),
      },
    },
    async (input) => runTool(() => app.ledger.resolvePendingItem(input)),
  );

  server.registerTool(
    'workflow_validation_log',
    {
      description: 'Lê o log retido de uma validação sem executar o perfil novamente.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        itemKey: z.string(),
        validationId: z.string(),
      },
    },
    async (input) => runTool(() => app.ledger.getValidationLog(input)),
  );

  server.registerTool(
    'workflow_define_item',
    {
      description: 'Registra uma fatia com casos de uso, critérios e testes.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        key: z.string(),
        phaseKey: z.string(),
        position: z.number().int(),
        title: z.string(),
        kind: z.enum(['CODE', 'DOCUMENTATION', 'VALIDATION', 'OTHER']).optional(),
        summary: z.string().optional(),
        tddPolicy: z.enum(['REQUIRED', 'OPTIONAL', 'EXEMPT']).optional(),
        riskTags: z.enum(riskTagValues).array().optional(),
        parentItemKey: z.string().optional(),
        dependsOn: z.array(z.object({
          featureKey: z.string(),
          itemKey: z.string(),
        })).optional(),
        scope: z.object({
          repositories: z.array(z.object({
            repositoryKey: z.string(),
            paths: z.array(z.string()),
          })),
        }).optional(),
        useCases: z.array(z.object({
          key: z.string(),
          title: z.string(),
          actor: z.string(),
          preconditions: z.string(),
          trigger: z.string(),
          expectedOutcome: z.string(),
          invariants: z.array(z.string()).optional(),
        })),
        criteria: z.array(z.object({
          key: z.string(),
          statement: z.string(),
          useCaseKey: z.string().optional(),
          required: z.boolean().optional(),
          evidenceKind: z.enum(evidenceKindValues).optional(),
          polarity: z.enum(criterionPolarityValues).optional(),
        })),
        tests: z.array(z.object({
          key: z.string(),
          name: z.string(),
          purpose: z.enum(['RED', 'GREEN', 'CHECK']),
          runnerProfileKey: z.string().optional(),
          criterionKey: z.string().optional(),
        })),
      },
    },
    async (input) => runTool(() => app.ledger.defineWorkItem(input)),
  );

  server.registerTool(
    'workflow_replan_item',
    {
      description: 'Bloqueia uma fatia grande ou semanticamente inválida para replanejamento e preserva sua linhagem.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        itemKey: z.string(),
        actor: z.string(),
        reason: z.string(),
      },
    },
    async (input) => runTool(() => app.ledger.replanWorkItem(input)),
  );

  server.registerTool(
    'workflow_claim_item',
    {
      description: 'Reserva uma fatia autorizada para um agente, rejeitando concorrência ativa.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        itemKey: z.string(),
        holder: z.string(),
        durationSeconds: z.number().int().positive().max(86_400).optional(),
      },
    },
    async (input) => runTool(() => app.ledger.claimWorkItem(input)),
  );

  server.registerTool(
    'workflow_recover_item_lease',
    {
      description: 'Recupera uma reserva expirada, preserva seu histórico e rejeita recuperação antecipada.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        itemKey: z.string(),
        holder: z.string(),
        durationSeconds: z.number().int().positive().max(86_400).optional(),
      },
    },
    async (input) => runTool(() => app.ledger.recoverWorkItemLease(input)),
  );

  server.registerTool(
    'workflow_renew_item_lease',
    {
      description: 'Renova uma lease ativa somente com holder e generation vigentes.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        itemKey: z.string(),
        holder: z.string(),
        executionFence: z.number().int().positive(),
        durationSeconds: z.number().int().positive().max(86_400).optional(),
      },
    },
    async (input) => runTool(() => app.ledger.renewWorkItemLease(input)),
  );

  server.registerTool(
    'workflow_release_item_lease',
    {
      description: 'Libera uma lease ativa somente com holder e generation vigentes.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        itemKey: z.string(),
        holder: z.string(),
        executionFence: z.number().int().positive(),
        reason: z.string().optional(),
      },
    },
    async (input) => runTool(() => app.ledger.releaseWorkItemLease(input)),
  );

  server.registerTool(
    'workflow_reconcile_item_leases',
    {
      description: 'Reconcilia leases expiradas e abandona workspaces ativos de forma idempotente.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string().optional(),
        itemKey: z.string().optional(),
      },
    },
    async (input) => runTool(() => app.ledger.reconcileWorkItemLeases(input)),
  );

  server.registerTool(
    'workflow_authorize',
    {
      description: 'Autoriza uma fatia e captura os baselines Git somente leitura.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        itemKey: z.string(),
        instruction: z.string(),
        actor: z.string(),
        allowedEffects: z.array(z.string()),
        forbiddenEffects: z.array(z.string()),
        repositoryKeys: z.array(z.string()).min(1),
        executionMode: z.enum(['SHARED', 'MANAGED_WORKTREE']).optional(),
      },
    },
    async (input) => runTool(() => app.ledger.authorizeWorkItem(input)),
  );

  server.registerTool(
    'workflow_add_dependency',
    {
      description: 'Adiciona uma dependência entre fatias do mesmo projeto, rejeitando ciclos.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        itemKey: z.string(),
        dependsOn: z.object({ featureKey: z.string(), itemKey: z.string() }),
      },
    },
    async (input) => runTool(() => app.ledger.addWorkItemDependency(input)),
  );

  server.registerTool(
    'workflow_remove_dependency',
    {
      description: 'Remove uma dependência de uma fatia ainda editável.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        itemKey: z.string(),
        dependsOn: z.object({ featureKey: z.string(), itemKey: z.string() }),
      },
    },
    async (input) => runTool(() => app.ledger.removeWorkItemDependency(input)),
  );

  server.registerTool(
    'workflow_list_dependencies',
    {
      description: 'Lista predecessoras e dependentes de uma fatia.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        itemKey: z.string(),
      },
    },
    async (input) => runTool(() => app.ledger.listWorkItemDependencies(input)),
  );

  server.registerTool(
    'workflow_prepare_integration',
    {
      description: 'Rebaseia worktrees gerenciadas e registra candidatos de integração por SHA.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        itemKey: z.string(),
        executionFence: z.number().int().positive().optional(),
      },
    },
    async (input) => runTool(() => app.ledger.prepareIntegration(input)),
  );

  server.registerTool(
    'workflow_authorize_integration',
    {
      description: 'Autoriza integração humana para candidatos e bases exatos.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        itemKey: z.string(),
        actor: z.string(),
        candidates: z.record(z.string()),
        targetBases: z.record(z.string()),
        executionFence: z.number().int().positive().optional(),
      },
    },
    async (input) => runTool(() => app.ledger.authorizeIntegration(input)),
  );

  server.registerTool(
    'workflow_integrate_item',
    {
      description: 'Integra uma fatia gerenciada por fast-forward após autorização humana.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        itemKey: z.string(),
        executionFence: z.number().int().positive().optional(),
      },
    },
    async (input) => runTool(() => app.ledger.integrateWorkItem(input)),
  );

  server.registerTool(
    'workflow_cleanup_worktrees',
    {
      description: 'Tenta remover worktrees e branches sem usar remoção forçada.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        itemKey: z.string(),
      },
    },
    async (input) => runTool(() => app.ledger.cleanupWorkItem(input)),
  );

  server.registerTool(
    'workflow_validate',
    {
      description: 'Executa RED/GREEN/CHECK sem intervenção do usuário; RED/GREEN válidos avançam o estado e CHECK idêntico reutiliza o GREEN.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        itemKey: z.string(),
        repositoryKey: z.string(),
        profileKey: z.string(),
        purpose: z.enum(['RED', 'GREEN', 'CHECK']),
        reason: z.string().optional().describe('Obrigatório quando o RED é estrutural.'),
        executionFence: z.number().int().positive().optional(),
      },
    },
    async (input) => runTool(async () => {
      const result = await app.validation.run(input);
      return formatValidationResult(app, input, result);
    }),
  );

  server.registerTool(
    'workflow_confirm_structural_red',
    {
      description: 'Confirma um RED estrutural já registrado, sem executar os testes novamente.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        itemKey: z.string(),
        validationId: z.string(),
        reason: z.string(),
        executionFence: z.number().int().positive().optional(),
      },
    },
    async (input) => runTool(() => app.ledger.confirmStructuralRed(input)),
  );

  server.registerTool(
    'workflow_transition',
    {
      description: 'Avança uma fatia pela máquina de estados com suas evidências.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        itemKey: z.string(),
        to: z.enum(workItemStates),
        reason: z.string().optional(),
        commitSha: z.string().optional(),
        executionFence: z.number().int().positive().optional(),
      },
    },
    async (input) => runTool(() => app.ledger.transitionWorkItem(input)),
  );

  server.registerTool(
    'workflow_reopen',
    {
      description: 'Reabre uma fatia bloqueada no estado anterior e registra ator e justificativa.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        itemKey: z.string(),
        actor: z.string(),
        reason: z.string(),
      },
    },
    async (input) => runTool(() => app.ledger.reopenWorkItem(input)),
  );

  server.registerTool(
    'workflow_invalidate_green',
    {
      description: 'Invalida evidência GREEN obsoleta e retorna a fatia para IMPLEMENTING.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        itemKey: z.string(),
        reason: z.string(),
        executionFence: z.number().int().positive().optional(),
      },
    },
    async (input) => runTool(() => app.ledger.invalidateGreen(input)),
  );

  server.registerTool(
    'workflow_review',
    {
      description: 'Registra SELF ou INDEPENDENT review e aplica o veredito ao estado automaticamente.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        itemKey: z.string(),
        reviewer: z.string(),
        reviewMode: z.enum(['SELF', 'INDEPENDENT']).default('SELF'),
        verdict: z.enum(['APPROVED', 'CHANGES_REQUIRED', 'BLOCKED']),
        summary: z.string(),
        findings: z.array(z.object({
          severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
          location: z.string(),
          evidence: z.string(),
          risk: z.string(),
          correction: z.string(),
          testNeeded: z.string(),
          resolved: z.boolean().optional(),
        })).default([]),
        executionFence: z.number().int().positive().optional(),
      },
    },
    async (input) => runTool(() => app.ledger.submitReview(input)),
  );

  server.registerTool(
    'workflow_compact_history',
    {
      description: 'Compacta o histórico antigo e preserva a fatia ativa, recentes e protegidas.',
      inputSchema: {
        projectKey: z.string(),
        featureKey: z.string(),
        activeItemKey: z.string(),
        keepRecent: z.number().int().min(0).max(20).optional(),
      },
    },
    async (input) => runTool(() => app.ledger.compactHistory(input)),
  );

  return server;
}

async function runTool(action: () => Promise<unknown>) {
  try {
    const value = await action();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(value) }],
    };
  } catch (error) {
    const message = isWorkflowApplicationError(error)
      ? `[${error.code}] ${error.message}${error.details ? ` ${JSON.stringify(error.details)}` : ''}`
      : error instanceof Error
        ? error.message
        : String(error);

    return {
      isError: true,
      content: [{ type: 'text' as const, text: message }],
    };
  }
}
