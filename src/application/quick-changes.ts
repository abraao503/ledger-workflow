import type { PrismaClient } from '@prisma/client';

import { validateWorkItemScope } from '../domain/work-item-scope.js';
import { fail } from './errors.js';
import { decodeJson, encodeJson } from './json.js';
import {
  quickChangeStatuses,
  quickVerificationKinds,
  riskTagValues,
} from './types.js';
import type {
  CancelQuickChangeInput,
  FinishQuickChangeInput,
  GitReadPort,
  GitWorkspacePort,
  ListQuickChangesInput,
  PromoteQuickChangeInput,
  QuickChangeStatus,
  RiskTag,
  StartQuickChangeInput,
} from './types.js';

const MAX_QUICK_PATHS = 5;
const FORBIDDEN_QUICK_RISKS = new Set<RiskTag>([
  'API_READ',
  'API_WRITE',
  'DATABASE',
  'MIGRATION',
  'PRIVATE_DATA',
  'MULTI_TENANT',
  'REALTIME',
  'ASYNC_JOB',
  'EXTERNAL_INTEGRATION',
  'AUTHORIZATION',
]);

export class QuickChangeService {
  constructor(
    private readonly db: PrismaClient,
    private readonly git: GitReadPort,
  ) {}

  async start(input: StartQuickChangeInput) {
    const key = required(input.key, 'QUICK_CHANGE_KEY_REQUIRED');
    const title = required(input.title, 'QUICK_CHANGE_TITLE_REQUIRED');
    const summary = required(input.summary, 'QUICK_CHANGE_SUMMARY_REQUIRED');
    const requestedBy = required(input.requestedBy, 'QUICK_CHANGE_REQUESTER_REQUIRED');
    const eligibilityReason = required(
      input.eligibilityReason,
      'QUICK_CHANGE_ELIGIBILITY_REASON_REQUIRED',
    );
    if (!requestedBy.toLowerCase().startsWith('human:')) {
      fail(
        'QUICK_CHANGE_HUMAN_AUTHORIZATION_REQUIRED',
        'O caminho rápido precisa registrar a autorização explícita de uma pessoa.',
      );
    }

    const paths = unique(input.paths.map((entry) => entry.trim()).filter(Boolean));
    const scope = { repositories: [{ repositoryKey: input.repositoryKey, paths }] };
    const scopeIssues = validateWorkItemScope(scope);
    if (scopeIssues.length) {
      fail(scopeIssues[0].code, scopeIssues[0].message);
    }
    if (!paths.length || paths.length > MAX_QUICK_PATHS) {
      fail('QUICK_CHANGE_SCOPE_TOO_LARGE', `O ajuste rápido aceita de 1 a ${MAX_QUICK_PATHS} paths.`);
    }

    const riskTags = normalizeRiskTags(input.riskTags ?? []);
    const forbiddenRisks = riskTags.filter((risk) => FORBIDDEN_QUICK_RISKS.has(risk));
    if (forbiddenRisks.length) {
      fail(
        'QUICK_CHANGE_REQUIRES_GOVERNED_FLOW',
        'O risco declarado exige PATCH ou FEATURE.',
        { riskTags: forbiddenRisks },
      );
    }
    const guardReference = input.guardReference?.trim();
    if (riskTags.includes('ROLE_VISIBILITY') && !guardReference) {
      fail(
        'QUICK_CHANGE_GUARD_REFERENCE_REQUIRED',
        'Mudança de visibilidade por role precisa referenciar uma permissão já existente.',
      );
    }

    const project = await this.db.project.findUnique({ where: { key: input.projectKey } });
    if (!project) fail('PROJECT_NOT_FOUND');
    const currentProject = project as NonNullable<typeof project>;
    const repository = await this.db.repository.findFirst({
      where: { projectId: currentProject.id, key: input.repositoryKey },
    });
    if (!repository) fail('REPOSITORY_NOT_FOUND');
    const currentRepository = repository as NonNullable<typeof repository>;

    const baseline = await this.git.capture(currentRepository.path);
    if (baseline.dirty) {
      fail('QUICK_CHANGE_DIRTY_BASELINE', 'O ajuste rápido exige um checkout limpo.');
    }
    if (currentRepository.expectedBranch && baseline.branch !== currentRepository.expectedBranch) {
      fail('QUICK_CHANGE_BRANCH_MISMATCH', 'O checkout não está na branch esperada.', {
        expected: currentRepository.expectedBranch,
        actual: baseline.branch,
      });
    }

    return this.db.$transaction(async (transaction) => {
      await transaction.project.update({
        where: { id: currentProject.id },
        data: { updatedAt: new Date() },
      });
      const duplicate = await transaction.quickChange.findUnique({
        where: { projectId_key: { projectId: currentProject.id, key } },
      });
      if (duplicate) fail('QUICK_CHANGE_KEY_EXISTS');

      const [openQuickChanges, activeLeases] = await Promise.all([
        transaction.quickChange.findMany({
          where: { projectId: currentProject.id, status: 'OPEN' },
          include: { repository: { select: { key: true } } },
        }),
        transaction.workItemLease.findMany({
          where: {
            releasedAt: null,
            expiresAt: { gt: new Date() },
            workItem: { feature: { projectId: currentProject.id } },
          },
          include: {
            workItem: {
              select: {
                key: true,
                scopeJson: true,
                feature: { select: { key: true } },
              },
            },
          },
        }),
      ]);

      for (const current of openQuickChanges) {
        if (current.repository.key !== currentRepository.key) continue;
        const currentPaths = decodeJson<string[]>(current.scopeJson, []);
        const conflicts = findPathConflicts(paths, currentPaths);
        if (conflicts.length) {
          fail('QUICK_CHANGE_SCOPE_CONFLICT', 'Outro ajuste rápido já reservou paths sobrepostos.', {
            quickChangeKey: current.key,
            conflicts,
          });
        }
      }
      for (const lease of activeLeases) {
        const currentScope = decodeJson<{
          repositories?: Array<{ repositoryKey: string; paths: string[] }>;
        }>(lease.workItem.scopeJson ?? '', {});
        const repositoryScope = currentScope.repositories?.find(
          (entry) => entry.repositoryKey === currentRepository.key,
        );
        if (!repositoryScope) continue;
        const conflicts = findPathConflicts(paths, repositoryScope.paths);
        if (conflicts.length) {
          fail('QUICK_CHANGE_SCOPE_CONFLICT', 'Uma fatia ativa já reservou paths sobrepostos.', {
            featureKey: lease.workItem.feature.key,
            itemKey: lease.workItem.key,
            conflicts,
          });
        }
      }

      const created = await transaction.quickChange.create({
        data: {
          projectId: currentProject.id,
          repositoryId: currentRepository.id,
          key,
          title,
          summary,
          requestedBy,
          eligibilityReason,
          guardReference,
          scopeJson: encodeJson(paths),
          riskTagsJson: encodeJson(riskTags),
          baseBranch: baseline.branch,
          baseSha: baseline.sha,
          baseFingerprint: baseline.fingerprint,
        },
        include: { repository: { select: { key: true } } },
      });
      await transaction.workflowEvent.create({
        data: {
          projectId: currentProject.id,
          type: 'QUICK_CHANGE_STARTED',
          payloadJson: encodeJson({
            quickChangeId: created.id,
            key,
            repositoryKey: currentRepository.key,
            paths,
            requestedBy,
            riskTags,
          }),
        },
      });
      return present(created);
    });
  }

  async finish(input: FinishQuickChangeInput) {
    const completedBy = required(input.completedBy, 'QUICK_CHANGE_COMPLETER_REQUIRED');
    const verificationSummary = required(
      input.verificationSummary,
      'QUICK_CHANGE_VERIFICATION_REQUIRED',
    );
    if (!quickVerificationKinds.includes(input.verificationKind)) {
      fail('QUICK_CHANGE_VERIFICATION_KIND_INVALID');
    }

    const current = await this.requireOpen(input.projectKey, input.key);
    const snapshot = await this.git.capture(current.repository.path);
    if (snapshot.dirty) {
      fail('QUICK_CHANGE_UNCOMMITTED_CHANGES', 'Finalize o commit antes de fechar o ajuste rápido.');
    }
    if (snapshot.branch !== current.baseBranch) {
      fail('QUICK_CHANGE_BRANCH_CHANGED');
    }
    if (snapshot.sha === current.baseSha) {
      fail('QUICK_CHANGE_COMMIT_REQUIRED');
    }

    const workspaceGit = this.git as Partial<GitWorkspacePort>;
    if (typeof workspaceGit.diffFiles !== 'function') {
      fail('GIT_DIFF_UNAVAILABLE');
    }
    const diffFiles = workspaceGit.diffFiles as GitWorkspacePort['diffFiles'];
    const changedFiles = await diffFiles.call(
      this.git,
      current.repository.path,
      current.baseSha,
      snapshot.sha,
    );
    if (!changedFiles.length) {
      fail('QUICK_CHANGE_EMPTY_DIFF');
    }
    const paths = decodeJson<string[]>(current.scopeJson, []);
    const outsideScope = changedFiles.filter(
      (file) => !paths.some((pattern) => scopePathContains(pattern, file)),
    );
    if (outsideScope.length) {
      fail(
        'QUICK_CHANGE_REQUIRES_PROMOTION',
        'O diff excedeu o escopo rápido; promova a mudança para PATCH.',
        { changedFiles: outsideScope, allowedPaths: paths },
      );
    }

    return this.db.$transaction(async (transaction) => {
      await transaction.project.update({
        where: { id: current.projectId },
        data: { updatedAt: new Date() },
      });
      const updated = await transaction.quickChange.updateMany({
        where: { id: current.id, status: 'OPEN' },
        data: {
          status: 'CLOSED',
          completedBy,
          commitSha: snapshot.sha,
          changedFilesJson: encodeJson(changedFiles),
          verificationKind: input.verificationKind,
          verificationSummary,
          closedAt: new Date(),
        },
      });
      if (updated.count !== 1) fail('QUICK_CHANGE_STATE_CHANGED_CONCURRENTLY');
      await transaction.workflowEvent.create({
        data: {
          projectId: current.projectId,
          type: 'QUICK_CHANGE_CLOSED',
          payloadJson: encodeJson({
            quickChangeId: current.id,
            key: current.key,
            completedBy,
            commitSha: snapshot.sha,
            changedFiles,
            verificationKind: input.verificationKind,
            verificationSummary,
          }),
        },
      });
      const closed = await transaction.quickChange.findUnique({
        where: { id: current.id },
        include: { repository: { select: { key: true } } },
      });
      return present(closed as NonNullable<typeof closed>);
    });
  }

  async promote(input: PromoteQuickChangeInput) {
    const actor = required(input.actor, 'QUICK_CHANGE_PROMOTION_ACTOR_REQUIRED');
    const reason = required(input.reason, 'QUICK_CHANGE_PROMOTION_REASON_REQUIRED');
    const patchKey = required(input.patchKey, 'QUICK_CHANGE_PROMOTION_TARGET_REQUIRED');
    const current = await this.requireOpen(input.projectKey, input.key);
    const patch = await this.db.feature.findFirst({
      where: { projectId: current.projectId, key: patchKey, taskType: 'PATCH' },
    });
    if (!patch) {
      fail(
        'QUICK_CHANGE_PATCH_NOT_FOUND',
        'Crie o PATCH governado antes de promover o ajuste rápido.',
      );
    }

    return this.setTerminalStatus(current, {
      status: 'PROMOTED',
      actor,
      reason,
      patchKey,
      eventType: 'QUICK_CHANGE_PROMOTED',
    });
  }

  async cancel(input: CancelQuickChangeInput) {
    const actor = required(input.actor, 'QUICK_CHANGE_CANCEL_ACTOR_REQUIRED');
    const reason = required(input.reason, 'QUICK_CHANGE_CANCEL_REASON_REQUIRED');
    const current = await this.requireOpen(input.projectKey, input.key);
    return this.setTerminalStatus(current, {
      status: 'CANCELLED',
      actor,
      reason,
      eventType: 'QUICK_CHANGE_CANCELLED',
    });
  }

  async list(input: ListQuickChangesInput) {
    const project = await this.db.project.findUnique({ where: { key: input.projectKey } });
    if (!project) fail('PROJECT_NOT_FOUND');
    const currentProject = project as NonNullable<typeof project>;
    const status = input.status ?? 'OPEN';
    if (status !== 'ALL' && !quickChangeStatuses.includes(status)) {
      fail('QUICK_CHANGE_STATUS_INVALID');
    }
    const changes = await this.db.quickChange.findMany({
      where: {
        projectId: currentProject.id,
        ...(input.key ? { key: input.key } : {}),
        ...(status === 'ALL' ? {} : { status }),
      },
      include: { repository: { select: { key: true } } },
      orderBy: [{ createdAt: 'desc' }, { key: 'asc' }],
    });
    return { project: currentProject.key, quickChanges: changes.map(present) };
  }

  private async requireOpen(projectKey: string, key: string) {
    const current = await this.db.quickChange.findFirst({
      where: { key, project: { key: projectKey } },
      include: { repository: true },
    });
    if (!current) fail('QUICK_CHANGE_NOT_FOUND');
    const openChange = current as NonNullable<typeof current>;
    if (openChange.status !== 'OPEN') fail('QUICK_CHANGE_NOT_OPEN');
    return openChange;
  }

  private async setTerminalStatus(
    current: Awaited<ReturnType<QuickChangeService['requireOpen']>>,
    input: {
      status: Extract<QuickChangeStatus, 'PROMOTED' | 'CANCELLED'>;
      actor: string;
      reason: string;
      patchKey?: string;
      eventType: string;
    },
  ) {
    return this.db.$transaction(async (transaction) => {
      await transaction.project.update({
        where: { id: current.projectId },
        data: { updatedAt: new Date() },
      });
      const result = await transaction.quickChange.updateMany({
        where: { id: current.id, status: 'OPEN' },
        data: {
          status: input.status,
          completedBy: input.actor,
          promotedTaskKey: input.patchKey,
          promotionReason: input.reason,
          closedAt: new Date(),
        },
      });
      if (result.count !== 1) fail('QUICK_CHANGE_STATE_CHANGED_CONCURRENTLY');
      await transaction.workflowEvent.create({
        data: {
          projectId: current.projectId,
          type: input.eventType,
          payloadJson: encodeJson({
            quickChangeId: current.id,
            key: current.key,
            actor: input.actor,
            reason: input.reason,
            patchKey: input.patchKey,
          }),
        },
      });
      const updated = await transaction.quickChange.findUnique({
        where: { id: current.id },
        include: { repository: { select: { key: true } } },
      });
      return present(updated as NonNullable<typeof updated>);
    });
  }
}

function present(change: {
  id: string;
  key: string;
  title: string;
  summary: string;
  status: string;
  requestedBy: string;
  completedBy: string | null;
  eligibilityReason: string;
  guardReference: string | null;
  scopeJson: string;
  riskTagsJson: string;
  baseBranch: string;
  baseSha: string;
  commitSha: string | null;
  changedFilesJson: string;
  verificationKind: string | null;
  verificationSummary: string | null;
  promotedTaskKey: string | null;
  promotionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  repository: { key: string };
}) {
  return {
    id: change.id,
    key: change.key,
    title: change.title,
    summary: change.summary,
    status: change.status as QuickChangeStatus,
    requestedBy: change.requestedBy,
    completedBy: change.completedBy ?? undefined,
    eligibilityReason: change.eligibilityReason,
    guardReference: change.guardReference ?? undefined,
    repositoryKey: change.repository.key,
    paths: decodeJson<string[]>(change.scopeJson, []),
    riskTags: decodeJson<RiskTag[]>(change.riskTagsJson, []),
    baseline: { branch: change.baseBranch, sha: change.baseSha },
    commitSha: change.commitSha ?? undefined,
    changedFiles: decodeJson<string[]>(change.changedFilesJson, []),
    verification: change.verificationKind
      ? { kind: change.verificationKind, summary: change.verificationSummary }
      : undefined,
    promotedTaskKey: change.promotedTaskKey ?? undefined,
    promotionReason: change.promotionReason ?? undefined,
    createdAt: change.createdAt.toISOString(),
    updatedAt: change.updatedAt.toISOString(),
    closedAt: change.closedAt?.toISOString(),
  };
}

function normalizeRiskTags(values: readonly string[]): RiskTag[] {
  const allowed = new Set<string>(riskTagValues);
  const normalized = unique(values.map((entry) => entry.trim()).filter(Boolean));
  const invalid = normalized.filter((entry) => !allowed.has(entry));
  if (invalid.length) fail('RISK_TAG_INVALID', 'Tag de risco inválida.', { riskTags: invalid });
  return normalized as RiskTag[];
}

function required(value: string, code: string): string {
  const normalized = value.trim();
  if (!normalized) fail(code);
  return normalized;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function findPathConflicts(left: string[], right: string[]) {
  return left.flatMap((leftPath) => right.flatMap((rightPath) => (
    scopePathsOverlap(leftPath, rightPath) ? [{ leftPath, rightPath }] : []
  )));
}

function scopePathContains(pattern: string, file: string): boolean {
  const normalizedPattern = normalizeScopePath(pattern);
  const normalizedFile = normalizeScopePath(file);
  if (!normalizedPattern) return true;
  if (!normalizedFile) return false;
  if (!/[?*]/.test(normalizedPattern)) {
    return normalizedFile === normalizedPattern || normalizedFile.startsWith(`${normalizedPattern}/`);
  }
  return globMatchesPath(normalizedPattern, normalizedFile);
}

function scopePathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeScopePath(left);
  const normalizedRight = normalizeScopePath(right);
  if (!normalizedLeft || !normalizedRight || normalizedLeft === normalizedRight) return true;
  const leftGlob = /[*?]/.test(normalizedLeft);
  const rightGlob = /[*?]/.test(normalizedRight);
  if (!leftGlob && !rightGlob) {
    return normalizedLeft.startsWith(`${normalizedRight}/`)
      || normalizedRight.startsWith(`${normalizedLeft}/`);
  }
  if (leftGlob && !rightGlob) return globMatchesPath(normalizedLeft, normalizedRight);
  if (!leftGlob && rightGlob) return globMatchesPath(normalizedRight, normalizedLeft);
  const leftPrefix = staticGlobPrefix(normalizedLeft);
  const rightPrefix = staticGlobPrefix(normalizedRight);
  return !leftPrefix || !rightPrefix || leftPrefix === rightPrefix
    || leftPrefix.startsWith(`${rightPrefix}/`)
    || rightPrefix.startsWith(`${leftPrefix}/`);
}

function normalizeScopePath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');
  return normalized === '.' ? '' : normalized;
}

function staticGlobPrefix(pattern: string): string {
  const wildcard = pattern.search(/[?*]/);
  const prefix = wildcard < 0 ? pattern : pattern.slice(0, wildcard);
  return prefix.replace(/\/[^/]*$/, '').replace(/\/$/, '');
}

function globMatchesPath(pattern: string, value: string): boolean {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${source}(?:/.*)?$`).test(value);
}
