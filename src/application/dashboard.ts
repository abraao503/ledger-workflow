import type { PrismaClient } from '@prisma/client';

import { fail } from './errors.js';
import { WorkflowLedger, sliceSizeRequestKey } from './workflow-ledger.js';
import type {
  DashboardAction,
  DashboardCatalogProject,
  DashboardGate,
  DashboardHealth,
  DashboardSelection,
  DashboardSnapshot,
} from './types.js';
import { workItemStates } from '../domain/workflow-state.js';

const gateDefinitions = [
  { key: 'specification', label: 'Especificação & Auth', states: ['DRAFT', 'READY', 'AUTHORIZED'] },
  { key: 'contract', label: 'Contrato TDD', states: ['TESTS_DEFINED', 'RED_CONFIRMED', 'TDD_EXCEPTION_APPROVED'] },
  { key: 'execution', label: 'Execução', states: ['IMPLEMENTING', 'GREEN_CONFIRMED'] },
  { key: 'audit', label: 'Auditoria & Review', states: ['READY_FOR_REVIEW', 'APPROVED', 'CHANGES_REQUIRED', 'BLOCKED'] },
  { key: 'final', label: 'Selamento Ledger', states: ['CLOSED'] },
] as const;

export type DashboardView = 'dashboard' | 'features' | 'execution' | 'review' | 'context';

export class DashboardService {
  constructor(
    private readonly db: PrismaClient,
    private readonly ledger: WorkflowLedger,
  ) {}

  async getCatalog(): Promise<DashboardCatalogProject[]> {
    const projects = await this.db.project.findMany({
      orderBy: { key: 'asc' },
      select: {
        key: true,
        name: true,
        status: true,
        features: {
          orderBy: { key: 'asc' },
          select: {
            key: true,
            name: true,
            status: true,
            currentPhaseKey: true,
            items: {
              orderBy: { position: 'asc' },
              select: { key: true, title: true, phaseKey: true, state: true, position: true },
            },
          },
        },
      },
    });

    return projects.map((project) => ({
      key: project.key,
      name: project.name,
      status: project.status,
      features: project.features.map((feature) => ({
        key: feature.key,
        name: feature.name,
        status: feature.status,
        currentPhaseKey: feature.currentPhaseKey ?? undefined,
        items: feature.items,
      })),
    }));
  }

  async getHealth(): Promise<DashboardHealth> {
    try {
      await this.db.$queryRaw`SELECT 1`;
      const rows = await this.db.$queryRawUnsafe<Array<{ journal_mode: string }>>(
        'PRAGMA journal_mode',
      );
      return {
        ok: true,
        database: 'sqlite',
        journalMode: rows[0]?.journal_mode ?? 'unknown',
        serverTime: new Date().toISOString(),
      };
    } catch {
      return {
        ok: false,
        database: 'sqlite',
        journalMode: 'unknown',
        serverTime: new Date().toISOString(),
      };
    }
  }

  async getDashboard(selection: DashboardSelection = {}, view: DashboardView = 'dashboard'): Promise<DashboardSnapshot> {
    const project = selection.projectKey
      ? await this.db.project.findUnique({ where: { key: selection.projectKey } })
      : await this.db.project.findFirst({
          where: { status: 'ACTIVE' },
          orderBy: { updatedAt: 'desc' },
        });

    if (!project) {
      fail('PROJECT_NOT_FOUND');
    }

    const currentProject = project as NonNullable<typeof project>;
    const feature = selection.featureKey
      ? await this.db.feature.findFirst({
          where: { projectId: currentProject.id, key: selection.featureKey },
        })
      : await this.db.feature.findFirst({
          where: { projectId: currentProject.id, status: 'ACTIVE' },
          orderBy: { updatedAt: 'desc' },
        });

    if (!feature) {
      fail('FEATURE_NOT_FOUND');
    }

    const currentFeature = feature as NonNullable<typeof feature>;
    const items = await this.db.workItem.findMany({
      where: { featureId: currentFeature.id },
      orderBy: { position: 'asc' },
    });
    const selectedItem = selection.itemKey
      ? items.find((item) => item.key === selection.itemKey)
      : items.find((item) => item.state !== 'CLOSED') ?? items.at(-1);

    if (!selectedItem) {
      fail('WORK_ITEM_NOT_FOUND');
    }

    const item = selectedItem as NonNullable<typeof selectedItem>;
    const context = await this.ledger.getContext({
      projectKey: currentProject.key,
      featureKey: currentFeature.key,
      itemKey: item.key,
    });
    const record = await this.ledger.getRecord({
      projectKey: currentProject.key,
      featureKey: currentFeature.key,
      itemKey: item.key,
    });
    const [repositories, activeFeatures, openItems, allRepositories, health, lease] = await Promise.all([
      this.db.repository.findMany({
        where: { projectId: currentProject.id },
        orderBy: { key: 'asc' },
        include: {
          validationProfiles: {
            where: { active: true },
            orderBy: { key: 'asc' },
            select: { key: true, parser: true },
          },
        },
      }),
      this.db.feature.count({ where: { projectId: currentProject.id, status: 'ACTIVE' } }),
      this.db.workItem.count({
        where: { feature: { projectId: currentProject.id }, state: { not: 'CLOSED' } },
      }),
      this.db.repository.findMany({
        where: { projectId: currentProject.id },
        select: {
          id: true,
          snapshots: {
            orderBy: { capturedAt: 'desc' },
            take: 1,
            select: { dirty: true },
          },
        },
      }),
      this.getHealth(),
      this.db.workItemLease.findFirst({
        where: { workItemId: item.id, releasedAt: null },
        orderBy: { expiresAt: 'desc' },
      }),
    ]);
    const cleanRepositories = allRepositories.filter((repository) => repository.snapshots[0]?.dirty === false).length;
    const now = new Date();
    const validations = (record.validations as Array<{
      id: string;
      purpose: string;
      status: string;
      resultKind: string;
      exitCode: number | null;
      sha: string;
      durationMs: number;
      summary: Record<string, unknown>;
      profileKey: string;
      createdAt: Date;
      logBlob?: Uint8Array | null;
      logExpiresAt?: Date | null;
      logAvailable?: boolean;
    }>).map((validation) => ({
      id: validation.id,
      purpose: validation.purpose,
      status: validation.status,
      resultKind: validation.resultKind,
      exitCode: validation.exitCode,
      sha: validation.sha,
      durationMs: validation.durationMs,
      summary: validation.summary,
      profileKey: validation.profileKey,
      createdAt: validation.createdAt.toISOString(),
      logAvailable: validation.logAvailable ?? (Boolean(validation.logBlob) && (!validation.logExpiresAt || validation.logExpiresAt > now)),
      ...(validation.logExpiresAt ? { logExpiresAt: validation.logExpiresAt.toISOString() } : {}),
    }));
    const recordAuthorization = record.authorization as { executionMode?: string } | undefined;
    const executionMode = recordAuthorization?.executionMode ?? 'SHARED';
    const recordWorkspaces = record.workspaces as Array<{
      repository: string;
      path: string;
      branch: string;
      baseSha: string;
      targetBaseSha?: string | null;
      candidateSha?: string | null;
      status: string;
      cleanupError?: string | null;
    }>;
    const integrationApprovals = record.integrationApprovals as Array<{
      id: string;
      actor: string;
      status: string;
      candidates: Record<string, string>;
      targetBases: Record<string, string>;
    }>;
    const latestIntegrationApproval = integrationApprovals[0];

    return {
      selection: {
        projectKey: currentProject.key,
        featureKey: currentFeature.key,
        itemKey: item.key,
        view,
      },
      project: { key: currentProject.key, name: currentProject.name },
      feature: {
        key: currentFeature.key,
        name: currentFeature.name,
        summary: currentFeature.summary,
        status: currentFeature.status,
      },
      overview: {
        repositories: repositories.length,
        cleanRepositories,
        activeFeatures,
        openItems,
        walMode: health.journalMode,
      },
      item: record.item,
      gates: makeGates(item.state),
      context: context as unknown as Record<string, unknown>,
      record: record as unknown as Record<string, unknown>,
      validations,
      pendingItems: record.pendingItems.map((pending) => ({
        key: pending.key,
        description: pending.description,
        blocking: pending.blocking,
        resolved: pending.resolved,
      })),
      recentSlices: items
        .filter((candidate) => candidate.position < item.position && candidate.state === 'CLOSED')
        .slice(-2)
        .reverse()
        .map((candidate) => ({
          key: candidate.key,
          title: candidate.title,
          state: candidate.state,
          summary: candidate.summary,
          currentSha: candidate.currentSha,
          position: candidate.position,
        })),
      repositories: repositories.map((repository) => ({
        key: repository.key,
        expectedBranch: repository.expectedBranch,
        profiles: repository.validationProfiles,
      })),
      lease: lease
        ? {
            holder: lease.holder,
            acquiredAt: lease.acquiredAt.toISOString(),
            expiresAt: lease.expiresAt.toISOString(),
            active: lease.expiresAt > now,
          }
        : null,
      execution: {
        mode: executionMode,
        workspaces: recordWorkspaces,
        integrationApproval: latestIntegrationApproval,
      },
      availableActions: makeActions({
        state: item.state,
        requirementsComplete: item.requirementsComplete,
        testsDefined: record.tests.length > 0 || item.tddPolicy !== 'REQUIRED',
        tddPolicy: item.tddPolicy,
        repositoryKeys: repositories.map((repository) => repository.key),
        profileKeys: repositories.flatMap((repository) => repository.validationProfiles.map((profile) => profile.key)),
        executionMode,
        hasLease: Boolean(lease && lease.expiresAt > now),
        hasExpiredLease: Boolean(lease && lease.expiresAt <= now),
        hasWorkspaces: recordWorkspaces.some((workspace) => workspace.status !== 'REMOVED'),
        hasActiveWorkspaces: recordWorkspaces.some((workspace) => workspace.status === 'ACTIVE'),
        hasIntegrationApproval: ['AUTHORIZED', 'IN_PROGRESS'].includes(latestIntegrationApproval?.status ?? ''),
        hasPreparedCandidates: (() => {
          const activeWorkspaces = recordWorkspaces.filter((workspace) => workspace.status === 'ACTIVE');
          return activeWorkspaces.length > 0 && activeWorkspaces.every((workspace) => Boolean(workspace.candidateSha));
        })(),
        dependenciesPending: context.dependencies?.some((dependency) => dependency.state !== 'CLOSED') ?? false,
        sizeExceptionPending: (record.pendingItems as Array<{ key: string; resolved?: boolean }>).some(
          (pending) => pending.key === sliceSizeRequestKey(currentFeature.key, item.key) && !pending.resolved,
        ),
      }),
      health,
    };
  }
}

function makeGates(state: string): DashboardGate[] {
  const currentIndex = gateDefinitions.findIndex((gate) => (gate.states as readonly string[]).includes(state));
  return gateDefinitions.map((gate, index) => ({
    key: gate.key,
    label: gate.label,
    states: [...gate.states],
    status: state === 'CLOSED'
      ? 'complete'
      : state === 'BLOCKED' && gate.key === 'audit'
      ? 'blocked'
      : index < currentIndex
        ? 'complete'
        : index === currentIndex
          ? 'active'
          : 'pending',
  }));
}

function makeActions(input: {
  state: string;
  requirementsComplete: boolean;
  testsDefined: boolean;
  tddPolicy: string;
  repositoryKeys: string[];
  profileKeys: string[];
  executionMode: string;
  hasLease: boolean;
  hasExpiredLease: boolean;
  hasWorkspaces: boolean;
  hasActiveWorkspaces: boolean;
  hasIntegrationApproval: boolean;
  hasPreparedCandidates: boolean;
  dependenciesPending: boolean;
  sizeExceptionPending: boolean;
}): DashboardAction[] {
  const validationOptions = {
    repositoryKeys: input.repositoryKeys,
    profileKeys: input.profileKeys,
  };
  const actions: DashboardAction[] = [];
  const add = (action: DashboardAction) => actions.push(action);

  add({
    id: 'MARK_READY', label: 'Avançar para READY', kind: 'primary',
    enabled: input.state === 'DRAFT' && input.requirementsComplete,
    ...(input.state === 'DRAFT' && !input.requirementsComplete ? { reason: 'Requisitos ainda incompletos' } : {}),
  });
  add({
    id: 'AUTHORIZE', label: 'Autorizar fatia', kind: 'primary',
    enabled: input.state === 'READY',
  });
  add({
    id: 'CLAIM', label: 'Reservar fatia', kind: 'primary',
    enabled: input.state === 'AUTHORIZED' && !input.hasLease && !input.hasExpiredLease && !input.dependenciesPending,
    ...(input.state === 'AUTHORIZED' && input.hasLease ? { reason: 'A fatia já possui uma reserva ativa' } : {}),
    ...(input.state === 'AUTHORIZED' && input.hasExpiredLease ? { reason: 'A reserva expirou; use recuperação para preservar a worktree anterior' } : {}),
    ...(input.state === 'AUTHORIZED' && input.dependenciesPending ? { reason: 'As dependências ainda não foram fechadas' } : {}),
  });
  add({
    id: 'RECOVER', label: 'Recuperar reserva expirada', kind: 'secondary',
    enabled: !['CLOSED', 'BLOCKED'].includes(input.state) && input.hasExpiredLease,
  });
  add({
    id: 'MARK_TESTS_DEFINED', label: 'Confirmar testes definidos', kind: 'primary',
    enabled: input.state === 'AUTHORIZED' && input.testsDefined,
    ...(input.state === 'AUTHORIZED' && !input.testsDefined ? { reason: 'Registre ao menos um teste no CLI/MCP' } : {}),
  });
  add({
    id: 'RUN_RED', label: 'Executar validação RED', kind: 'primary',
    enabled: input.state === 'TESTS_DEFINED',
    options: validationOptions,
  });
  add({
    id: 'APPROVE_TDD_EXCEPTION', label: 'Justificar exceção TDD', kind: 'secondary',
    enabled: input.state === 'TESTS_DEFINED' && input.tddPolicy !== 'REQUIRED',
  });
  add({
    id: 'START_IMPLEMENTING', label: 'Iniciar implementação', kind: 'primary',
    enabled: ['RED_CONFIRMED', 'TDD_EXCEPTION_APPROVED'].includes(input.state),
  });
  add({
    id: 'RUN_GREEN', label: 'Executar validação GREEN', kind: 'primary',
    enabled: input.state === 'IMPLEMENTING',
    options: validationOptions,
  });
  add({
    id: 'MARK_READY_FOR_REVIEW', label: 'Enviar para revisão', kind: 'primary',
    enabled: input.state === 'GREEN_CONFIRMED',
  });
  add({
    id: 'PREPARE_INTEGRATION', label: 'Preparar integração', kind: 'secondary',
    enabled: input.state === 'APPROVED' && input.executionMode === 'MANAGED_WORKTREE' && input.hasActiveWorkspaces,
  });
  add({
    id: 'INVALIDATE_GREEN', label: 'Invalidar GREEN obsoleto', kind: 'danger',
    enabled: ['GREEN_CONFIRMED', 'READY_FOR_REVIEW', 'APPROVED'].includes(input.state),
    reason: 'Use quando a worktree mudou depois do GREEN',
  });
  add({
    id: 'SUBMIT_REVIEW', label: 'Registrar revisão', kind: 'primary',
    enabled: input.state === 'READY_FOR_REVIEW',
  });
  add({
    id: 'RETURN_TO_TESTS', label: 'Retornar para testes', kind: 'secondary',
    enabled: input.state === 'CHANGES_REQUIRED',
  });
  add({
    id: 'CLOSE', label: 'Selar com commit', kind: 'primary',
    enabled: input.state === 'APPROVED' && input.executionMode !== 'MANAGED_WORKTREE',
    ...(input.state === 'APPROVED' && input.executionMode === 'MANAGED_WORKTREE'
      ? { reason: 'Fatias gerenciadas devem ser integradas com aprovação por SHA' }
      : {}),
  });
  add({
    id: 'AUTHORIZE_INTEGRATION', label: 'Autorizar integração', kind: 'primary',
    enabled: input.state === 'APPROVED' && input.executionMode === 'MANAGED_WORKTREE' && input.hasPreparedCandidates,
  });
  add({
    id: 'INTEGRATE', label: 'Integrar por fast-forward', kind: 'primary',
    enabled: input.state === 'APPROVED' && input.executionMode === 'MANAGED_WORKTREE' && input.hasIntegrationApproval,
  });
  add({
    id: 'CLEANUP_WORKTREES', label: 'Limpar worktrees', kind: 'maintenance',
    enabled: input.hasWorkspaces && ['CLOSED', 'BLOCKED'].includes(input.state),
  });
  add({
    id: 'BLOCK', label: 'Bloquear ou justificar', kind: 'danger',
    enabled: !['BLOCKED', 'CLOSED'].includes(input.state),
  });
  add({
    id: 'REOPEN', label: 'Reabrir fatia', kind: 'secondary',
    enabled: input.state === 'BLOCKED',
  });
  add({
    id: 'RUN_CHECK', label: 'Executar CHECK', kind: 'secondary',
    enabled: input.state !== 'CLOSED',
    options: validationOptions,
  });
  add({ id: 'REINSPECT', label: 'Reinspecionar árvore Git', kind: 'maintenance', enabled: true, options: validationOptions });
  add({ id: 'COMPACT_HISTORY', label: 'Compactar histórico', kind: 'maintenance', enabled: true });
  add({
    id: 'PLAN_CHECK', label: 'Auditar planejamento', kind: 'maintenance', enabled: true,
    reason: 'Avalia granularidade, semântica e escopo das fatias da entrega',
  });
  add({
    id: 'REQUEST_SIZE_EXCEPTION', label: 'Solicitar exceção de tamanho', kind: 'secondary',
    enabled: input.state === 'DRAFT',
  });
  add({
    id: 'APPROVE_SIZE', label: 'Aprovar exceção de tamanho', kind: 'primary',
    enabled: input.state === 'DRAFT' && input.sizeExceptionPending,
    ...(input.state === 'DRAFT' && !input.sizeExceptionPending
      ? { reason: 'Nenhuma solicitação de exceção pendente nesta fatia' }
      : {}),
  });
  add({
    id: 'REPLAN', label: 'Replanejar fatia', kind: 'danger',
    enabled: input.state === 'DRAFT',
  });

  return actions.filter((action) => action.enabled
    || (['REINSPECT', 'COMPACT_HISTORY', 'PLAN_CHECK'] as string[]).includes(action.id));
}

export function isDashboardView(value: string | undefined): value is DashboardView {
  return Boolean(value && ['dashboard', 'features', 'execution', 'review', 'context'].includes(value));
}

export function isWorkItemState(value: string): boolean {
  return (workItemStates as readonly string[]).includes(value);
}
