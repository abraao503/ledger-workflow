import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';

import type {
  Feature,
  PrismaClient,
  Project,
  WorkItem,
} from '@prisma/client';

import {
  selectHistoryRetention,
  type HistoryRecord,
} from '../domain/history-retention.js';
import {
  WorkflowStateMachine,
  type TransitionContext,
  type WorkItemState,
} from '../domain/workflow-state.js';
import {
  buildWorkflowContext,
  type WorkflowContext,
} from '../domain/workflow-context.js';
import {
  assessSliceSize,
  DEFAULT_SLICE_SIZE_POLICY,
  type SliceSizePolicy,
} from '../domain/slice-sizing.js';
import { GitReadAdapter } from './git-read-adapter.js';
import { fail, WorkflowApplicationError } from './errors.js';
import { decodeJson, encodeJson } from './json.js';
import type {
  AddRepositoryInput,
  ApproveSliceSizeInput,
  AuthorizeWorkItemInput,
  CompactHistoryInput,
  ContextRequest,
  CreateValidationProfileInput,
  CreateFeatureInput,
  CreateProjectInput,
  CreateTemplateInput,
  DefineWorkItemInput,
  ConfirmStructuralRedInput,
  InvalidateGreenInput,
  ListValidationsInput,
  RecordDecisionInput,
  RecordPendingItemInput,
  PlanCheckRequest,
  PlanCheckResult,
  RecordRequest,
  RecordValidationInput,
  ReplanWorkItemInput,
  ResolvePendingItemInput,
  RequestSliceSizeExceptionInput,
  ReopenWorkItemInput,
  SubmitReviewInput,
  TransitionWorkItemInput,
  GitReadPort,
} from './types.js';

const LOG_RETENTION_DAYS = 7;

type WorkItemWithFeature = WorkItem & {
  feature: Feature;
};

type GreenEvidenceContext = {
  greenEvidence: boolean;
  greenEvidenceIsCurrent: boolean;
  greenEvidencePendingRepositories: string[];
  greenEvidenceSha?: string;
  currentSha?: string;
  greenEvidenceFingerprint?: string;
  currentFingerprint?: string;
  greenEvidenceContentFingerprint?: string;
  currentContentFingerprint?: string;
};

export class WorkflowLedger {
  private readonly stateMachine = new WorkflowStateMachine();

  constructor(
    private readonly db: PrismaClient,
    private readonly git: GitReadPort = new GitReadAdapter(),
  ) {}

  async createProject(input: CreateProjectInput) {
    if (!input.rootPath.trim()) {
      fail('PROJECT_ROOT_REQUIRED');
    }

    return this.db.project.create({
      data: {
        key: input.key,
        name: input.name,
        rootPath: path.resolve(input.rootPath),
      },
    });
  }

  async addRepository(input: AddRepositoryInput) {
    const project = await this.requireProject(input.projectKey);
    const repositoryPath = path.resolve(input.path.trim());
    const rootPath = path.resolve(project.rootPath);
    const relativePath = path.relative(rootPath, repositoryPath);

    if (!input.path.trim()) {
      fail('REPOSITORY_PATH_REQUIRED');
    }

    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      fail('REPOSITORY_PATH_INVALID');
    }

    return this.db.repository.create({
      data: {
        projectId: project.id,
        key: input.key,
        path: repositoryPath,
        expectedBranch: input.expectedBranch,
      },
    });
  }

  async createTemplate(input: CreateTemplateInput) {
    const project = await this.requireProject(input.projectKey);
    const current = await this.db.workflowTemplateVersion.findFirst({
      where: { projectId: project.id, key: input.key },
      orderBy: { version: 'desc' },
    });

    return this.db.workflowTemplateVersion.create({
      data: {
        projectId: project.id,
        key: input.key,
        version: (current?.version ?? 0) + 1,
        name: input.name,
        definitionJson: encodeJson(input.definition),
      },
    });
  }

  async createFeature(input: CreateFeatureInput) {
    const project = await this.requireProject(input.projectKey);
    const template = await this.db.workflowTemplateVersion.findFirst({
      where: {
        projectId: project.id,
        key: input.templateKey,
        ...(input.templateVersion ? { version: input.templateVersion } : {}),
      },
      orderBy: { version: 'desc' },
    });

    if (!template) {
      fail('TEMPLATE_NOT_FOUND');
    }

    return this.db.feature.create({
      data: {
        projectId: project.id,
        templateId: (template as NonNullable<typeof template>).id,
        key: input.key,
        name: input.name,
        summary: input.summary,
        currentPhaseKey: undefined,
      },
    });
  }

  async defineWorkItem(input: DefineWorkItemInput) {
    const feature = await this.requireFeature(input.projectKey, input.featureKey);
    const useCaseKeys = new Set<string>();
    const criterionKeys = new Set<string>();
    const testKeys = new Set<string>();

    for (const useCase of input.useCases) {
      if (useCaseKeys.has(useCase.key)) {
        fail('DUPLICATE_USE_CASE_KEY');
      }

      useCaseKeys.add(useCase.key);
    }

    for (const criterion of input.criteria) {
      if (criterionKeys.has(criterion.key)) {
        fail('DUPLICATE_CRITERION_KEY');
      }

      if (criterion.useCaseKey && !useCaseKeys.has(criterion.useCaseKey)) {
        fail('CRITERION_USE_CASE_NOT_FOUND');
      }

      criterionKeys.add(criterion.key);
    }

    for (const test of input.tests) {
      if (testKeys.has(test.key)) {
        fail('DUPLICATE_TEST_KEY');
      }

      if (test.criterionKey && !criterionKeys.has(test.criterionKey)) {
        fail('TEST_CRITERION_NOT_FOUND');
      }

      testKeys.add(test.key);
    }

    const kind = input.kind ?? 'CODE';
    const tddPolicy = input.tddPolicy ?? (kind === 'CODE' ? 'REQUIRED' : 'OPTIONAL');
    const requirementsComplete =
      input.useCases.length > 0 &&
      input.criteria.some((criterion) => criterion.required !== false) &&
      (kind !== 'CODE' || tddPolicy !== 'REQUIRED' || input.tests.length > 0);

    return this.db.$transaction(async (transaction) => {
      let parentItemId: string | undefined;
      if (input.parentItemKey?.trim()) {
        const parentItem = await transaction.workItem.findFirst({
          where: {
            featureId: feature.id,
            key: input.parentItemKey.trim(),
          },
        });

        if (!parentItem) {
          fail('PARENT_ITEM_NOT_FOUND');
        }

        const replanEvent = await transaction.workflowEvent.findFirst({
          where: {
            workItemId: (parentItem as NonNullable<typeof parentItem>).id,
            type: 'SLICE_SIZE_REPLANNED',
          },
        });

        if ((parentItem as NonNullable<typeof parentItem>).state !== 'BLOCKED' || !replanEvent) {
          fail('PARENT_ITEM_NOT_REPLANNED');
        }

        parentItemId = (parentItem as NonNullable<typeof parentItem>).id;
      }

      const item = await transaction.workItem.create({
        data: {
          featureId: feature.id,
          key: input.key,
          phaseKey: input.phaseKey,
          position: input.position,
          title: input.title,
          kind,
          summary: input.summary,
          tddPolicy,
          parentItemId,
          requirementsComplete,
        },
      });

      const useCasesByKey = new Map<string, string>();

      for (const useCase of input.useCases) {
        const created = await transaction.useCase.create({
          data: {
            workItemId: item.id,
            key: useCase.key,
            title: useCase.title,
            actor: useCase.actor,
            preconditions: useCase.preconditions,
            trigger: useCase.trigger,
            expectedOutcome: useCase.expectedOutcome,
            invariantsJson: encodeJson(useCase.invariants ?? []),
          },
        });

        useCasesByKey.set(useCase.key, created.id);
      }

      const criteriaByKey = new Map<string, string>();

      for (const criterion of input.criteria) {
        const created = await transaction.acceptanceCriterion.create({
          data: {
            workItemId: item.id,
            useCaseId: criterion.useCaseKey
              ? useCasesByKey.get(criterion.useCaseKey)
              : undefined,
            key: criterion.key,
            statement: criterion.statement,
            required: criterion.required !== false,
          },
        });

        criteriaByKey.set(criterion.key, created.id);
      }

      for (const test of input.tests) {
        await transaction.testSpecification.create({
          data: {
            workItemId: item.id,
            criterionId: test.criterionKey
              ? criteriaByKey.get(test.criterionKey)
              : undefined,
            key: test.key,
            name: test.name,
            purpose: test.purpose,
            runnerProfileKey: test.runnerProfileKey,
          },
        });
      }

      await transaction.workflowEvent.create({
        data: {
          projectId: feature.projectId,
          featureId: feature.id,
          workItemId: item.id,
          type: 'ITEM_DEFINED',
          payloadJson: encodeJson({
            key: item.key,
            requirementsComplete,
            testCount: input.tests.length,
          }),
        },
      });

      return item;
    });
  }

  async authorizeWorkItem(input: AuthorizeWorkItemInput) {
    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);

    if (item.state !== 'READY') {
      fail('ITEM_NOT_READY');
    }

    if (!input.instruction.trim()) {
      fail('AUTHORIZATION_INSTRUCTION_REQUIRED');
    }

    const repositories = await this.db.repository.findMany({
      where: {
        projectId: item.feature.projectId,
        key: { in: input.repositoryKeys },
      },
    });

    if (input.repositoryKeys.length !== new Set(input.repositoryKeys).size) {
      fail('BASELINE_REPOSITORY_DUPLICATE');
    }

    if (repositories.length !== input.repositoryKeys.length) {
      fail('BASELINE_REPOSITORY_NOT_FOUND');
    }

    if (repositories.length === 0) {
      fail('BASELINE_REPOSITORY_REQUIRED');
    }

    const baselines = await Promise.all(
      repositories.map(async (repository) => ({
        repository,
        snapshot: await this.git.capture(repository.path),
      })),
    );

    if (baselines.some(({ snapshot }) => snapshot.dirty)) {
      fail('DIRTY_BASELINE');
    }

    if (baselines.some(({ repository, snapshot }) => (
      repository.expectedBranch && repository.expectedBranch !== snapshot.branch
    ))) {
      fail('EXPECTED_BRANCH_MISMATCH');
    }

    this.stateMachine.assertTransition('READY', 'AUTHORIZED', {
      authorized: true,
    });

    return this.db.$transaction(async (transaction) => {
      const authorization = await transaction.authorization.create({
        data: {
          workItemId: item.id,
          instruction: input.instruction,
          actor: input.actor,
          allowedEffectsJson: encodeJson(input.allowedEffects),
          forbiddenEffectsJson: encodeJson(input.forbiddenEffects),
        },
      });

      for (const baseline of baselines) {
        await transaction.repositorySnapshot.create({
          data: {
            workItemId: item.id,
            repositoryId: baseline.repository.id,
            branch: baseline.snapshot.branch,
            sha: baseline.snapshot.sha,
            dirty: baseline.snapshot.dirty,
            changedFilesJson: encodeJson(baseline.snapshot.changedFiles),
          },
        });
      }

      const updated = await transaction.workItem.update({
        where: { id: item.id },
        data: { state: 'AUTHORIZED', currentSha: baselines[0]?.snapshot.sha },
      });

      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'ITEM_AUTHORIZED',
          payloadJson: encodeJson({
            actor: input.actor,
            repositoryCount: baselines.length,
          }),
        },
      });

      return { authorization, item: updated };
    });
  }

  async createValidationProfile(input: CreateValidationProfileInput) {
    const project = await this.requireProject(input.projectKey);
    const repository = await this.db.repository.findFirst({
      where: { projectId: project.id, key: input.repositoryKey },
    });

    if (!repository) {
      fail('REPOSITORY_NOT_FOUND');
    }

    const allowedPrograms = new Set(['npm', 'npx', 'node', 'pnpm', 'yarn']);

    if (!allowedPrograms.has(input.program)) {
      fail('VALIDATION_PROGRAM_NOT_ALLOWED');
    }

    const cwd = input.cwd?.trim() || '.';

    if (path.isAbsolute(cwd) || cwd.split(/[\\/]/).includes('..')) {
      fail('VALIDATION_CWD_INVALID');
    }

    if (input.timeoutSeconds !== undefined && (input.timeoutSeconds < 1 || input.timeoutSeconds > 3_600)) {
      fail('VALIDATION_TIMEOUT_INVALID');
    }

    if (input.maxOutputBytes !== undefined && (input.maxOutputBytes < 1_024 || input.maxOutputBytes > 2_000_000)) {
      fail('VALIDATION_OUTPUT_LIMIT_INVALID');
    }

    return this.db.validationProfile.create({
      data: {
        repositoryId: (repository as NonNullable<typeof repository>).id,
        key: input.key,
        program: input.program,
        argsJson: encodeJson(input.args),
        cwd,
        parser: input.parser,
        timeoutSeconds: input.timeoutSeconds ?? 60,
        maxOutputBytes: input.maxOutputBytes ?? 2_000_000,
      },
    });
  }

  async recordValidation(input: RecordValidationInput) {
    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    const repository = await this.db.repository.findFirst({
      where: { projectId: item.feature.projectId, key: input.repositoryKey },
    });

    if (!repository) {
      fail('REPOSITORY_NOT_FOUND');
    }

    const profile = await this.db.validationProfile.findFirst({
      where: {
        repositoryId: (repository as NonNullable<typeof repository>).id,
        key: input.profileKey,
        active: true,
      },
    });

    if (!profile) {
      fail('VALIDATION_PROFILE_NOT_FOUND');
    }

    const expires = new Date();
    expires.setDate(expires.getDate() + LOG_RETENTION_DAYS);

    const boundedLog = input.log
      ? Buffer.from(input.log)
          .subarray(0, (profile as NonNullable<typeof profile>).maxOutputBytes)
          .toString('utf8')
      : undefined;

    return this.db.validationRun.create({
      data: {
        workItemId: item.id,
        profileId: (profile as NonNullable<typeof profile>).id,
        purpose: input.purpose,
        status: input.status,
        resultKind: input.resultKind,
        exitCode: input.exitCode,
        sha: input.sha,
        durationMs: input.durationMs,
        summaryJson: encodeJson(input.summary),
        logBlob: boundedLog ? gzipSync(boundedLog) : undefined,
        logExpiresAt: boundedLog ? expires : undefined,
      },
    });
  }

  async confirmStructuralRed(input: ConfirmStructuralRedInput) {
    if (!input.reason.trim()) {
      fail('STRUCTURAL_RED_REASON_REQUIRED');
    }

    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    if (item.state !== 'TESTS_DEFINED') {
      fail('STRUCTURAL_RED_CONFIRMATION_STATE_INVALID');
    }

    const validation = await this.db.validationRun.findFirst({
      where: {
        id: input.validationId,
        workItemId: item.id,
        purpose: 'RED',
        resultKind: 'TEST_FAILURE',
      },
    });

    if (!validation) {
      fail('STRUCTURAL_RED_VALIDATION_NOT_FOUND');
    }

    const currentValidation = validation as NonNullable<typeof validation>;
    const latestRed = await this.db.validationRun.findFirst({
      where: {
        workItemId: item.id,
        purpose: 'RED',
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    });

    if (!latestRed || latestRed.id !== currentValidation.id) {
      fail('STRUCTURAL_RED_VALIDATION_NOT_LATEST');
    }

    const summary = decodeJson<{
      redEvidenceKind?: 'BEHAVIORAL' | 'STRUCTURAL';
    }>(currentValidation.summaryJson, {});
    if (summary.redEvidenceKind !== 'STRUCTURAL') {
      fail('STRUCTURAL_RED_VALIDATION_INVALID');
    }

    return this.transitionWorkItem({
      projectKey: input.projectKey,
      featureKey: input.featureKey,
      itemKey: input.itemKey,
      to: 'RED_CONFIRMED',
      reason: input.reason.trim(),
    });
  }

  async invalidateGreen(input: InvalidateGreenInput) {
    if (!input.reason.trim()) {
      fail('GREEN_INVALIDATION_REASON_REQUIRED');
    }

    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    if (!['GREEN_CONFIRMED', 'READY_FOR_REVIEW', 'APPROVED'].includes(item.state)) {
      fail('GREEN_INVALIDATION_STATE_INVALID');
    }

    const greenContext = await this.getGreenEvidenceContext(item, true);
    if (!greenContext.greenEvidence) {
      fail('GREEN_EVIDENCE_NOT_FOUND');
    }

    if (greenContext.greenEvidenceIsCurrent) {
      fail('GREEN_EVIDENCE_NOT_STALE');
    }

    return this.db.$transaction(async (transaction) => {
      const updated = await transaction.workItem.update({
        where: { id: item.id },
        data: { state: 'IMPLEMENTING' },
      });

      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'GREEN_INVALIDATED',
          payloadJson: encodeJson({
            from: item.state,
            to: 'IMPLEMENTING',
            reason: input.reason.trim(),
            evidenceSha: greenContext.greenEvidenceSha,
            evidenceFingerprint: greenContext.greenEvidenceFingerprint,
            evidenceContentFingerprint: greenContext.greenEvidenceContentFingerprint,
            currentSha: greenContext.currentSha,
            currentFingerprint: greenContext.currentFingerprint,
            currentContentFingerprint: greenContext.currentContentFingerprint,
          }),
        },
      });

      return updated;
    });
  }

  async submitReview(input: SubmitReviewInput) {
    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);

    if (item.state !== 'READY_FOR_REVIEW') {
      fail('REVIEW_STATE_INVALID');
    }

    const reviewMode = input.reviewMode ?? 'SELF';
    const targetState: WorkItemState = input.verdict === 'APPROVED'
      ? 'APPROVED'
      : input.verdict === 'CHANGES_REQUIRED'
        ? 'CHANGES_REQUIRED'
        : 'BLOCKED';
    const transitionContext = await this.getTransitionContext(item, {
      to: targetState,
      reason: input.summary,
    });
    this.stateMachine.assertTransition('READY_FOR_REVIEW', targetState, {
      ...transitionContext,
      reviewApproved: input.verdict === 'APPROVED',
      changesRequired: input.verdict === 'CHANGES_REQUIRED',
      hasBlockingFindings: input.findings.some(
        (finding) => !finding.resolved && ['CRITICAL', 'HIGH'].includes(finding.severity),
      ),
      blockReason: input.summary,
    });

    return this.db.$transaction(async (transaction) => {
      const review = await transaction.review.create({
        data: {
          workItemId: item.id,
          verdict: input.verdict,
          reviewer: input.reviewer,
          summary: input.summary,
          findings: {
            create: input.findings.map((finding) => ({
              severity: finding.severity,
              location: finding.location,
              evidence: finding.evidence,
              risk: finding.risk,
              correction: finding.correction,
              testNeeded: finding.testNeeded,
              resolved: finding.resolved ?? false,
            })),
          },
        },
        include: { findings: true },
      });

      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'REVIEW_SUBMITTED',
          payloadJson: encodeJson({
            verdict: input.verdict,
            reviewer: input.reviewer,
            reviewMode,
          }),
        },
      });

      const updated = await transaction.workItem.update({
        where: { id: item.id },
        data: { state: targetState },
      });
      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'ITEM_TRANSITIONED',
          payloadJson: encodeJson({
            from: 'READY_FOR_REVIEW',
            to: targetState,
            reason: `Veredito ${input.verdict} aplicado automaticamente`,
          }),
        },
      });

      return { review, item: updated, reviewMode };
    });
  }

  async transitionWorkItem(input: TransitionWorkItemInput) {
    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    const from = item.state as WorkItemState;
    const to = input.to as WorkItemState;
    const context = await this.getTransitionContext(item, input);

    this.stateMachine.assertTransition(from, to, context);

    return this.db.$transaction(async (transaction) => {
      const updated = await transaction.workItem.update({
        where: { id: item.id },
        data: {
          state: to,
          ...(to === 'CLOSED' && input.commitSha
            ? { currentSha: input.commitSha }
            : {}),
        },
      });

      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'ITEM_TRANSITIONED',
          payloadJson: encodeJson({ from, to, reason: input.reason, commitSha: input.commitSha }),
        },
      });

      return updated;
    });
  }

  async reopenWorkItem(input: ReopenWorkItemInput) {
    if (!input.actor.trim()) {
      fail('REOPEN_ACTOR_REQUIRED');
    }

    if (!input.reason.trim()) {
      fail('REOPEN_REASON_REQUIRED');
    }

    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    if (item.state !== 'BLOCKED') {
      fail('REOPEN_STATE_INVALID');
    }

    const blockedTransition = await this.db.workflowEvent.findFirst({
      where: { workItemId: item.id, type: 'ITEM_TRANSITIONED' },
      orderBy: { createdAt: 'desc' },
    });
    const payload = blockedTransition
      ? decodeJson<{ from?: string; to?: string }>(blockedTransition.payloadJson, {})
      : {};
    const target = payload.to === 'BLOCKED' ? payload.from : undefined;

    if (!target || target === 'BLOCKED' || target === 'CLOSED') {
      fail('REOPEN_TARGET_NOT_FOUND');
    }

    return this.db.$transaction(async (transaction) => {
      const updated = await transaction.workItem.update({
        where: { id: item.id },
        data: { state: target },
      });

      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'ITEM_REOPENED',
          payloadJson: encodeJson({
            from: 'BLOCKED',
            to: target,
            actor: input.actor,
            reason: input.reason,
          }),
        },
      });

      return updated;
    });
  }

  async getContext(input: ContextRequest): Promise<WorkflowContext> {
    const item = input.itemKey
      ? await this.requireItem(input.projectKey, input.featureKey ?? '', input.itemKey)
      : await this.findCurrentItem(input.projectKey, input.featureKey);
    const [
      authorization,
      snapshots,
      criteria,
      decisions,
      pendingItems,
      recentItems,
      oldSummaries,
      tests,
      validations,
      latestReview,
      latestReviewEvent,
      currentEvents,
      lineage,
    ] =
      await Promise.all([
        this.db.authorization.findFirst({
          where: { workItemId: item.id },
          orderBy: { createdAt: 'desc' },
        }),
        this.db.repositorySnapshot.findMany({
          where: { workItemId: item.id },
          include: { repository: true },
          orderBy: { capturedAt: 'desc' },
        }),
        this.db.acceptanceCriterion.findMany({
          where: { workItemId: item.id, required: true },
          orderBy: { key: 'asc' },
        }),
        this.db.decision.findMany({
          where: {
            projectId: item.feature.projectId,
            OR: [{ featureId: item.featureId }, { workItemId: item.id }],
            durable: true,
          },
          orderBy: { key: 'asc' },
        }),
        this.db.pendingItem.findMany({
          where: {
            projectId: item.feature.projectId,
            resolved: false,
            OR: [{ featureId: item.featureId }, { workItemId: item.id }],
          },
          orderBy: [{ blocking: 'desc' }, { key: 'asc' }],
        }),
        this.db.workItem.findMany({
          where: {
            featureId: item.featureId,
            position: { lt: item.position },
            state: 'CLOSED',
          },
          orderBy: { position: 'desc' },
          take: 2,
          include: {
            events: {
              where: { type: 'ITEM_TRANSITIONED' },
              orderBy: { createdAt: 'desc' },
            },
          },
        }),
        this.db.historySummary.findMany({
          where: { featureId: item.featureId, workItemId: null },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
        this.db.testSpecification.findMany({
          where: { workItemId: item.id },
          orderBy: { key: 'asc' },
        }),
        this.db.validationRun.findMany({
          where: { workItemId: item.id },
          include: { profile: true },
          orderBy: { createdAt: 'desc' },
        }),
        this.db.review.findFirst({
          where: { workItemId: item.id },
          orderBy: { createdAt: 'desc' },
        }),
        this.db.workflowEvent.findFirst({
          where: { workItemId: item.id, type: 'REVIEW_SUBMITTED' },
          orderBy: { createdAt: 'desc' },
        }),
        this.db.workflowEvent.findMany({
          where: { workItemId: item.id, type: 'ITEM_TRANSITIONED' },
          orderBy: { createdAt: 'desc' },
        }),
        this.db.workItem.findUnique({
          where: { id: item.id },
          select: {
            parentItem: { select: { key: true, title: true, state: true } },
            childItems: {
              orderBy: { position: 'asc' },
              select: { key: true, title: true, state: true },
            },
          },
        }),
      ]);

    const latestValidations = ['RED', 'GREEN', 'CHECK']
      .map((purpose) => validations.find((validation) => validation.purpose === purpose))
      .filter((validation): validation is NonNullable<typeof validation> => Boolean(validation));
    const reviewEventPayload = latestReviewEvent
      ? decodeJson<{ reviewMode?: 'SELF' | 'INDEPENDENT' }>(latestReviewEvent.payloadJson, {})
      : {};
    const currentClose = findClosedTransition(currentEvents);

    return buildWorkflowContext(
      {
        current: {
          projectKey: input.projectKey,
          featureKey: item.feature.key,
          phaseKey: item.phaseKey,
          itemKey: item.key,
          state: item.state,
          nextAllowedTransition: this.nextAllowedTransition(item.state as WorkItemState),
        },
        currentEvidence: {
          outcome: currentClose?.reason ?? item.summary ?? item.title,
          commitRef: currentClose?.commitSha ?? item.currentSha ?? undefined,
          validations: latestValidations.map((validation) => {
            const summary = decodeJson<{
              reusedFromValidationId?: string;
              redEvidenceKind?: string;
            }>(validation.summaryJson, {});
            return {
              purpose: validation.purpose,
              result: validation.resultKind,
              profileKey: validation.profile.key,
              durationMs: validation.durationMs,
              reused: Boolean(summary.reusedFromValidationId),
              redKind: summary.redEvidenceKind,
            };
          }),
          review: latestReview
            ? {
                verdict: latestReview.verdict,
                mode: reviewEventPayload.reviewMode ?? 'UNSPECIFIED',
                reviewer: latestReview.reviewer,
                summary: latestReview.summary,
              }
            : undefined,
        },
        authorization: authorization
          ? {
              instruction: authorization.instruction,
              allowedEffects: decodeJson(authorization.allowedEffectsJson, []),
              forbiddenEffects: decodeJson(authorization.forbiddenEffectsJson, []),
            }
          : undefined,
        lineage: {
          parent: lineage?.parentItem ?? undefined,
          children: lineage?.childItems ?? [],
        },
        baselines: snapshots.map((snapshot) => ({
          repository: snapshot.repository.key,
          branch: snapshot.branch,
          sha: snapshot.sha,
          dirty: snapshot.dirty,
        })),
        acceptanceCriteria: criteria.map((criterion) => ({
          key: criterion.key,
          statement: criterion.statement,
        })),
        durableDecisions: decisions.map((decision) => ({
          key: decision.key,
          title: decision.title,
        })),
        unresolvedItems: pendingItems.map((pending) => ({
          key: pending.key,
          description: pending.description,
          blocking: pending.blocking,
        })),
        recentSlices: recentItems.reverse().map((recent) => {
          const close = findClosedTransition(recent.events);
          return {
            key: recent.key,
            state: recent.state,
            result: recent.state === 'CLOSED' ? 'CLOSED' : recent.state,
            summary: close?.reason ?? recent.summary ?? recent.title,
            commitRefs: close?.commitSha
              ? [close.commitSha]
              : recent.currentSha
                ? [recent.currentSha]
                : [],
          };
        }),
        olderSummaries: oldSummaries.map((summary) => ({
          key: summary.scopeKey,
          summary: historySummaryText(summary.deliveredJson, summary.state),
        })),
        requiredChecks: tests.map((test) => {
          const evidence = validations.find((validation) => (
            validation.purpose === test.purpose &&
            (!test.runnerProfileKey || validation.profile.key === test.runnerProfileKey) &&
            (test.purpose === 'RED'
              ? validation.resultKind === 'TEST_FAILURE'
              : validation.resultKind === 'PASS')
          ));
          return {
            key: test.key,
            description: `${test.purpose}: ${test.name}`,
            status: evidence ? 'PASSED' : 'PENDING',
          };
        }),
      },
      input.maxChars,
    );
  }

  async getRecord(input: RecordRequest) {
    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    const [useCases, criteria, tests, authorization, snapshots, validations, reviews, decisions, pendingItems, lineage] =
      await Promise.all([
        this.db.useCase.findMany({ where: { workItemId: item.id }, orderBy: { key: 'asc' } }),
        this.db.acceptanceCriterion.findMany({ where: { workItemId: item.id }, orderBy: { key: 'asc' } }),
        this.db.testSpecification.findMany({ where: { workItemId: item.id }, orderBy: { key: 'asc' } }),
        this.db.authorization.findFirst({ where: { workItemId: item.id }, orderBy: { createdAt: 'desc' } }),
        this.db.repositorySnapshot.findMany({
          where: { workItemId: item.id },
          include: { repository: true },
          orderBy: { capturedAt: 'desc' },
        }),
        this.db.validationRun.findMany({
          where: { workItemId: item.id },
          include: { profile: true },
          orderBy: { createdAt: 'desc' },
        }),
        this.db.review.findMany({
          where: { workItemId: item.id },
          include: { findings: true },
          orderBy: { createdAt: 'desc' },
        }),
        this.db.decision.findMany({ where: { workItemId: item.id }, orderBy: { key: 'asc' } }),
        this.db.pendingItem.findMany({ where: { workItemId: item.id }, orderBy: { key: 'asc' } }),
        this.db.workItem.findUnique({
          where: { id: item.id },
          select: {
            parentItem: { select: { key: true, title: true, state: true } },
            childItems: {
              orderBy: { position: 'asc' },
              select: { key: true, title: true, state: true },
            },
          },
        }),
      ]);

    return {
      item: {
        key: item.key,
        title: item.title,
        phaseKey: item.phaseKey,
        kind: item.kind,
        state: item.state,
        summary: item.summary,
        tddPolicy: item.tddPolicy,
        currentSha: item.currentSha,
        requirementsComplete: item.requirementsComplete,
      },
      lineage: {
        parent: lineage?.parentItem ?? undefined,
        children: lineage?.childItems ?? [],
      },
      useCases,
      acceptanceCriteria: criteria,
      tests,
      authorization: authorization
        ? {
            instruction: authorization.instruction,
            actor: authorization.actor,
            allowedEffects: decodeJson(authorization.allowedEffectsJson, []),
            forbiddenEffects: decodeJson(authorization.forbiddenEffectsJson, []),
          }
        : undefined,
      baselines: snapshots.map((snapshot) => ({
        repository: snapshot.repository.key,
        branch: snapshot.branch,
        sha: snapshot.sha,
        dirty: snapshot.dirty,
        changedFiles: decodeJson(snapshot.changedFilesJson, []),
      })),
      validations: validations.map((validation) => ({
        id: validation.id,
        purpose: validation.purpose,
        status: validation.status,
        resultKind: validation.resultKind,
        exitCode: validation.exitCode,
        sha: validation.sha,
        durationMs: validation.durationMs,
        summary: decodeJson(validation.summaryJson, {}),
        profileKey: validation.profile.key,
        createdAt: validation.createdAt,
        logAvailable: Boolean(validation.logBlob) && (!validation.logExpiresAt || validation.logExpiresAt > new Date()),
        logExpiresAt: validation.logExpiresAt,
      })),
      reviews,
      decisions,
      pendingItems,
    };
  }

  async getValidationLog(input: {
    projectKey: string;
    featureKey: string;
    itemKey: string;
    validationId: string;
  }): Promise<{
    id: string;
    purpose: string;
    createdAt: Date;
    expiresAt: Date | null;
    text: string;
  }> {
    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    const validation = await this.db.validationRun.findFirst({
      where: { id: input.validationId, workItemId: item.id },
    });

    if (!validation) {
      fail('VALIDATION_NOT_FOUND');
    }

    const current = validation as NonNullable<typeof validation>;
    if (current.logExpiresAt && current.logExpiresAt < new Date()) {
      fail('VALIDATION_LOG_EXPIRED');
    }

    if (!current.logBlob) {
      fail('VALIDATION_LOG_UNAVAILABLE');
    }

    try {
      return {
        id: current.id,
        purpose: current.purpose,
        createdAt: current.createdAt,
        expiresAt: current.logExpiresAt,
        text: gunzipSync(Buffer.from(current.logBlob as Uint8Array)).toString('utf8'),
      };
    } catch {
      return fail('VALIDATION_LOG_CORRUPT');
    }
  }

  async listProjects() {
    const projects = await this.db.project.findMany({
      orderBy: { key: 'asc' },
      select: { key: true, name: true, status: true },
    });

    return { projects };
  }

  async listFeatures(projectKey: string) {
    const project = await this.requireProject(projectKey);
    const features = await this.db.feature.findMany({
      where: { projectId: project.id },
      orderBy: { key: 'asc' },
      select: {
        key: true,
        name: true,
        summary: true,
        status: true,
        currentPhaseKey: true,
        items: {
          orderBy: { position: 'asc' },
          select: {
            key: true,
            title: true,
            phaseKey: true,
            state: true,
            position: true,
            parentItem: { select: { key: true } },
          },
        },
      },
    });

    return {
      project: project.key,
      features: features.map((feature) => ({
        ...feature,
        items: feature.items.map((item) => ({
          ...item,
          parentItemKey: item.parentItem?.key,
        })),
      })),
    };
  }

  async checkPlan(input: PlanCheckRequest): Promise<PlanCheckResult> {
    const project = await this.requireProject(input.projectKey);
    const feature = await this.db.feature.findFirst({
      where: { projectId: project.id, key: input.featureKey },
      include: { template: true },
    });

    if (!feature) {
      fail('FEATURE_NOT_FOUND');
    }

    const currentFeature = feature as NonNullable<typeof feature>;
    const policy = readSliceSizePolicy(currentFeature.template.definitionJson);
    const items = await this.db.workItem.findMany({
      where: { featureId: currentFeature.id },
      orderBy: { position: 'asc' },
      include: {
        useCases: { select: { id: true } },
        criteria: { where: { required: true }, select: { id: true } },
        tests: { select: { id: true } },
        snapshots: { select: { repositoryId: true } },
        parentItem: { select: { key: true } },
      },
    });

    const auditedItems = items.map((item) => {
      const repositoryCount = new Set(item.snapshots.map((snapshot) => snapshot.repositoryId)).size;
      const assessment = assessSliceSize({
        useCases: item.useCases.length,
        requiredCriteria: item.criteria.length,
        tests: item.tests.length,
        repositories: repositoryCount,
      }, policy);

      return {
        key: item.key,
        title: item.title,
        phaseKey: item.phaseKey,
        state: item.state,
        parentItemKey: item.parentItem?.key,
        metrics: assessment.metrics,
        status: assessment.status,
        score: assessment.score,
        violations: assessment.violations,
        suggestions: assessment.suggestions,
        repositoryScope: repositoryCount > 0 ? 'CAPTURED' as const : 'UNKNOWN' as const,
      };
    });

    return {
      project: project.key,
      feature: {
        key: currentFeature.key,
        name: currentFeature.name,
        summary: currentFeature.summary,
      },
      policy,
      summary: {
        total: auditedItems.length,
        ok: auditedItems.filter((item) => item.status === 'OK').length,
        splitRecommended: auditedItems.filter((item) => item.status === 'SPLIT_RECOMMENDED').length,
        exceptionRequired: auditedItems.filter((item) => item.status === 'EXCEPTION_REQUIRED').length,
      },
      items: auditedItems,
    };
  }

  async approveSliceSize(input: ApproveSliceSizeInput) {
    if (!input.actor.trim().toLowerCase().startsWith('human:')) {
      fail('SLICE_SIZE_APPROVAL_HUMAN_REQUIRED');
    }

    if (!input.actor.trim()) {
      fail('SLICE_SIZE_APPROVAL_ACTOR_REQUIRED');
    }

    if (!input.reason.trim()) {
      fail('SLICE_SIZE_APPROVAL_REASON_REQUIRED');
    }

    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    if (item.state !== 'DRAFT') {
      fail('SLICE_SIZE_APPROVAL_STATE_INVALID');
    }

    const request = await this.db.pendingItem.findUnique({
      where: {
        projectId_key: {
          projectId: item.feature.projectId,
          key: sliceSizeRequestKey(item.feature.key, item.key),
        },
      },
    });

    if (!request) {
      fail('SLICE_SIZE_APPROVAL_REQUEST_REQUIRED');
    }

    if ((request as NonNullable<typeof request>).resolved) {
      fail('SLICE_SIZE_APPROVAL_REQUEST_RESOLVED');
    }

    const plan = await this.checkPlan({
      projectKey: input.projectKey,
      featureKey: input.featureKey,
    });
    const auditedItem = plan.items.find((candidate) => candidate.key === item.key);

    if (!auditedItem) {
      fail('WORK_ITEM_NOT_FOUND');
    }

    if ((auditedItem as NonNullable<typeof auditedItem>).status === 'OK') {
      fail('SLICE_SIZE_APPROVAL_NOT_REQUIRED');
    }

    const decisionKey = sliceSizeApprovalKey(item.feature.key, item.key);
    const content = [
      `Ator: ${input.actor.trim()}`,
      `Razão: ${input.reason.trim()}`,
      `Diagnóstico: ${(auditedItem as NonNullable<typeof auditedItem>).status}`,
      `Métricas: ${JSON.stringify((auditedItem as NonNullable<typeof auditedItem>).metrics)}`,
    ].join('\n');

    return this.db.$transaction(async (transaction) => {
      const decision = await transaction.decision.upsert({
        where: {
          projectId_key: {
            projectId: item.feature.projectId,
            key: decisionKey,
          },
        },
        create: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          key: decisionKey,
          title: 'Exceção de granularidade aprovada',
          content,
          durable: true,
          pinned: true,
        },
        update: {
          featureId: item.featureId,
          workItemId: item.id,
          title: 'Exceção de granularidade aprovada',
          content,
          durable: true,
          pinned: true,
        },
      });

      const resolvedRequest = await transaction.pendingItem.update({
        where: { id: (request as NonNullable<typeof request>).id },
        data: { resolved: true },
      });

      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'SLICE_SIZE_APPROVED',
          payloadJson: encodeJson({
            actor: input.actor.trim(),
            reason: input.reason.trim(),
            decisionKey,
            status: (auditedItem as NonNullable<typeof auditedItem>).status,
            requestKey: resolvedRequest.key,
          }),
        },
      });

      return { decision, pending: resolvedRequest, item };
    });
  }

  async requestSliceSizeException(input: RequestSliceSizeExceptionInput) {
    if (!input.actor.trim()) {
      fail('SLICE_SIZE_REQUEST_ACTOR_REQUIRED');
    }

    if (!input.reason.trim()) {
      fail('SLICE_SIZE_REQUEST_REASON_REQUIRED');
    }

    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    if (item.state !== 'DRAFT') {
      fail('SLICE_SIZE_REQUEST_STATE_INVALID');
    }

    const plan = await this.checkPlan({
      projectKey: input.projectKey,
      featureKey: input.featureKey,
    });
    const assessment = plan.items.find((candidate) => candidate.key === item.key);

    if (!assessment) {
      fail('WORK_ITEM_NOT_FOUND');
    }

    if ((assessment as NonNullable<typeof assessment>).status === 'OK') {
      fail('SLICE_SIZE_REQUEST_NOT_REQUIRED');
    }

    const requestKey = sliceSizeRequestKey(item.feature.key, item.key);
    const description = [
      `Solicitante: ${input.actor.trim()}`,
      `Motivo: ${input.reason.trim()}`,
      `Diagnóstico: ${(assessment as NonNullable<typeof assessment>).status}`,
      `Métricas: ${JSON.stringify((assessment as NonNullable<typeof assessment>).metrics)}`,
      'A fatia permanece bloqueada até replanejamento ou aprovação humana.',
    ].join('\n');

    return this.db.$transaction(async (transaction) => {
      const pending = await transaction.pendingItem.upsert({
        where: {
          projectId_key: {
            projectId: item.feature.projectId,
            key: requestKey,
          },
        },
        create: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          key: requestKey,
          description,
          blocking: true,
          pinned: true,
        },
        update: {
          featureId: item.featureId,
          workItemId: item.id,
          description,
          blocking: true,
          pinned: true,
          resolved: false,
        },
      });

      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'SLICE_SIZE_EXCEPTION_REQUESTED',
          payloadJson: encodeJson({
            actor: input.actor.trim(),
            reason: input.reason.trim(),
            requestKey,
            status: (assessment as NonNullable<typeof assessment>).status,
          }),
        },
      });

      return { assessment, pending, item };
    });
  }

  async replanWorkItem(input: ReplanWorkItemInput) {
    if (!input.actor.trim()) {
      fail('SLICE_REPLAN_ACTOR_REQUIRED');
    }

    if (!input.reason.trim()) {
      fail('SLICE_REPLAN_REASON_REQUIRED');
    }

    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    if (item.state !== 'DRAFT') {
      fail('SLICE_REPLAN_STATE_INVALID');
    }

    const plan = await this.checkPlan({
      projectKey: input.projectKey,
      featureKey: input.featureKey,
    });
    const assessment = plan.items.find((candidate) => candidate.key === item.key);

    if (!assessment) {
      fail('WORK_ITEM_NOT_FOUND');
    }

    if ((assessment as NonNullable<typeof assessment>).status === 'OK') {
      fail('SLICE_REPLAN_NOT_REQUIRED');
    }

    this.stateMachine.assertTransition('DRAFT', 'BLOCKED', {
      blockReason: input.reason,
    });

    const requestKey = sliceSizeRequestKey(item.feature.key, item.key);
    return this.db.$transaction(async (transaction) => {
      const pending = await transaction.pendingItem.findUnique({
        where: {
          projectId_key: {
            projectId: item.feature.projectId,
            key: requestKey,
          },
        },
      });
      const resolvedPending = pending && !pending.resolved
        ? await transaction.pendingItem.update({
            where: { id: pending.id },
            data: { resolved: true },
          })
        : pending;
      const updated = await transaction.workItem.update({
        where: { id: item.id },
        data: { state: 'BLOCKED' },
      });

      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'SLICE_SIZE_REPLANNED',
          payloadJson: encodeJson({
            actor: input.actor.trim(),
            reason: input.reason.trim(),
            status: (assessment as NonNullable<typeof assessment>).status,
            requestKey,
          }),
        },
      });

      return { assessment, item: updated, pending: resolvedPending };
    });
  }

  async listRepositories(projectKey: string) {
    const project = await this.requireProject(projectKey);
    const repositories = await this.db.repository.findMany({
      where: { projectId: project.id },
      orderBy: { key: 'asc' },
      include: {
        validationProfiles: {
          where: { active: true },
          orderBy: { key: 'asc' },
        },
      },
    });

    return {
      project: project.key,
      repositories: repositories.map((repository) => ({
        key: repository.key,
        path: repository.path,
        expectedBranch: repository.expectedBranch,
        profiles: repository.validationProfiles.map((profile) => ({
          key: profile.key,
          program: profile.program,
          args: decodeJson<string[]>(profile.argsJson, []),
          parser: profile.parser,
          cwd: profile.cwd,
          timeoutSeconds: profile.timeoutSeconds,
        })),
      })),
    };
  }

  async listValidations(input: ListValidationsInput) {
    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    const validations = await this.db.validationRun.findMany({
      where: {
        workItemId: item.id,
        ...(input.purpose ? { purpose: input.purpose } : {}),
      },
      include: { profile: { include: { repository: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return {
      item: { featureKey: item.feature.key, itemKey: item.key, state: item.state },
      validations: validations.map((validation) => ({
        id: validation.id,
        purpose: validation.purpose,
        repositoryKey: validation.profile.repository.key,
        profileKey: validation.profile.key,
        status: validation.status,
        resultKind: validation.resultKind,
        exitCode: validation.exitCode,
        sha: validation.sha,
        durationMs: validation.durationMs,
        summary: decodeJson<Record<string, unknown>>(validation.summaryJson, {}),
        createdAt: validation.createdAt,
        logAvailable: Boolean(validation.logBlob) && (!validation.logExpiresAt || validation.logExpiresAt > new Date()),
      })),
    };
  }

  async recordDecision(input: RecordDecisionInput) {
    if (!input.key.trim()) {
      fail('DECISION_KEY_REQUIRED');
    }

    if (!input.title.trim() || !input.content.trim()) {
      fail('DECISION_CONTENT_REQUIRED');
    }

    const project = await this.requireProject(input.projectKey);
    const scope = await this.resolveEventScope(project.id, input.featureKey, input.itemKey);
    const durable = input.durable ?? true;
    const pinned = input.pinned ?? false;

    return this.db.$transaction(async (transaction) => {
      const decision = await transaction.decision.upsert({
        where: { projectId_key: { projectId: project.id, key: input.key } },
        create: {
          projectId: project.id,
          featureId: scope?.featureId,
          workItemId: scope?.workItemId,
          key: input.key,
          title: input.title.trim(),
          content: input.content,
          durable,
          pinned,
        },
        update: {
          title: input.title.trim(),
          content: input.content,
          durable,
          pinned,
          ...(scope ? { featureId: scope.featureId, workItemId: scope.workItemId } : {}),
        },
      });

      if (scope) {
        await transaction.workflowEvent.create({
          data: {
            projectId: project.id,
            featureId: scope.featureId,
            workItemId: scope.workItemId,
            type: 'DECISION_RECORDED',
            payloadJson: encodeJson({
              key: decision.key,
              title: decision.title,
              durable: decision.durable,
              pinned: decision.pinned,
            }),
          },
        });
      }

      return decision;
    });
  }

  async listDecisions(projectKey: string) {
    const project = await this.requireProject(projectKey);
    const decisions = await this.db.decision.findMany({
      where: { projectId: project.id },
      orderBy: { key: 'asc' },
      include: {
        feature: { select: { key: true } },
        workItem: { select: { key: true } },
      },
    });

    return {
      project: project.key,
      decisions: decisions.map((decision) => ({
        key: decision.key,
        title: decision.title,
        content: decision.content,
        durable: decision.durable,
        pinned: decision.pinned,
        featureKey: decision.feature?.key,
        itemKey: decision.workItem?.key,
        createdAt: decision.createdAt,
      })),
    };
  }

  async recordPendingItem(input: RecordPendingItemInput) {
    if (!input.key.trim()) {
      fail('PENDING_ITEM_KEY_REQUIRED');
    }

    if (!input.description.trim()) {
      fail('PENDING_ITEM_DESCRIPTION_REQUIRED');
    }

    const project = await this.requireProject(input.projectKey);
    const scope = await this.resolveEventScope(project.id, input.featureKey, input.itemKey);
    const existing = await this.db.pendingItem.findUnique({
      where: { projectId_key: { projectId: project.id, key: input.key } },
    });

    if (existing) {
      fail('PENDING_ITEM_EXISTS');
    }

    return this.db.$transaction(async (transaction) => {
      const pending = await transaction.pendingItem.create({
        data: {
          projectId: project.id,
          featureId: scope?.featureId,
          workItemId: scope?.workItemId,
          key: input.key,
          description: input.description,
          blocking: input.blocking ?? false,
          pinned: input.pinned ?? false,
        },
      });

      if (scope) {
        await transaction.workflowEvent.create({
          data: {
            projectId: project.id,
            featureId: scope.featureId,
            workItemId: scope.workItemId,
            type: 'PENDING_ITEM_RECORDED',
            payloadJson: encodeJson({
              key: pending.key,
              description: pending.description,
              blocking: pending.blocking,
            }),
          },
        });
      }

      return pending;
    });
  }

  async resolvePendingItem(input: ResolvePendingItemInput) {
    const project = await this.requireProject(input.projectKey);
    const pending = await this.db.pendingItem.findUnique({
      where: { projectId_key: { projectId: project.id, key: input.key } },
    });

    if (!pending) {
      fail('PENDING_ITEM_NOT_FOUND');
    }

    if ((pending as NonNullable<typeof pending>).resolved) {
      fail('PENDING_ITEM_ALREADY_RESOLVED');
    }

    const resolved = await this.db.pendingItem.update({
      where: { id: (pending as NonNullable<typeof pending>).id },
      data: { resolved: true },
    });

    await this.db.workflowEvent.create({
      data: {
        projectId: project.id,
        featureId: resolved.featureId,
        workItemId: resolved.workItemId,
        type: 'PENDING_ITEM_RESOLVED',
        payloadJson: encodeJson({
          key: resolved.key,
          reason: input.reason,
        }),
      },
    });

    return resolved;
  }

  async listPendingItems(projectKey: string) {
    const project = await this.requireProject(projectKey);
    const pendingItems = await this.db.pendingItem.findMany({
      where: { projectId: project.id },
      orderBy: [{ resolved: 'asc' }, { blocking: 'desc' }, { key: 'asc' }],
      include: {
        feature: { select: { key: true } },
        workItem: { select: { key: true } },
      },
    });

    return {
      project: project.key,
      pendingItems: pendingItems.map((pending) => ({
        key: pending.key,
        description: pending.description,
        blocking: pending.blocking,
        resolved: pending.resolved,
        featureKey: pending.feature?.key,
        itemKey: pending.workItem?.key,
        createdAt: pending.createdAt,
      })),
    };
  }

  private async resolveEventScope(
    projectId: string,
    featureKey?: string,
    itemKey?: string,
  ): Promise<{ featureId?: string; workItemId?: string } | undefined> {
    if (!featureKey && !itemKey) {
      return undefined;
    }

    if (itemKey && !featureKey) {
      fail('ITEM_REQUIRES_FEATURE');
    }

    const feature = await this.db.feature.findFirst({
      where: { projectId, key: featureKey as string },
    });

    if (!feature) {
      fail('FEATURE_NOT_FOUND');
    }

    if (!itemKey) {
      return { featureId: (feature as NonNullable<typeof feature>).id };
    }

    const item = await this.db.workItem.findFirst({
      where: { featureId: (feature as NonNullable<typeof feature>).id, key: itemKey },
    });

    if (!item) {
      fail('WORK_ITEM_NOT_FOUND');
    }

    return {
      featureId: (feature as NonNullable<typeof feature>).id,
      workItemId: (item as NonNullable<typeof item>).id,
    };
  }

  async compactHistory(input: CompactHistoryInput) {
    const feature = await this.requireFeature(input.projectKey, input.featureKey);
    const items = await this.db.workItem.findMany({
      where: { featureId: feature.id },
      orderBy: { position: 'asc' },
    });
    const pinned = await this.db.historySummary.findMany({
      where: { featureId: feature.id, pinned: true },
      select: { scopeKey: true },
    });
    const unresolved = await this.db.pendingItem.findMany({
      where: { featureId: feature.id, resolved: false },
      select: { workItemId: true },
    });
    const retention = selectHistoryRetention(
      items.map<HistoryRecord>((item) => ({
        key: item.key,
        order: item.position,
        state: item.state,
      })),
      {
        activeKey: input.activeItemKey,
        keepRecent: input.keepRecent ?? 2,
        pinnedKeys: pinned.map((record) => record.scopeKey),
        unresolvedKeys: unresolved
          .map((record) => items.find((item) => item.id === record.workItemId)?.key)
          .filter((key): key is string => Boolean(key)),
      },
    );

    return this.db.$transaction(async (transaction) => {
      for (const key of retention.compact) {
        const item = items.find((candidate) => candidate.key === key);

        if (!item) {
          continue;
        }

        const validations = await transaction.validationRun.findMany({
          where: { workItemId: item.id },
          select: { purpose: true, resultKind: true, sha: true },
        });

        await transaction.historySummary.upsert({
          where: { projectId_scopeKey: { projectId: feature.projectId, scopeKey: `${feature.key}:${item.key}` } },
          create: {
            projectId: feature.projectId,
            featureId: feature.id,
            workItemId: item.id,
            scopeKey: `${feature.key}:${item.key}`,
            state: item.state,
            result: item.state === 'CLOSED' ? 'CLOSED' : item.state,
            deliveredJson: encodeJson({ title: item.title, summary: item.summary }),
            commitsJson: encodeJson(item.currentSha ? [item.currentSha] : []),
            validationsJson: encodeJson(validations),
            limitationsJson: encodeJson([]),
          },
          update: {
            state: item.state,
            result: item.state === 'CLOSED' ? 'CLOSED' : item.state,
            deliveredJson: encodeJson({ title: item.title, summary: item.summary }),
            commitsJson: encodeJson(item.currentSha ? [item.currentSha] : []),
            validationsJson: encodeJson(validations),
          },
        });

        await transaction.workflowEvent.deleteMany({ where: { workItemId: item.id } });
        await transaction.validationRun.deleteMany({ where: { workItemId: item.id } });
        await transaction.repositorySnapshot.deleteMany({ where: { workItemId: item.id } });
        await transaction.authorization.deleteMany({ where: { workItemId: item.id } });
        await transaction.review.deleteMany({ where: { workItemId: item.id } });
        await transaction.testSpecification.deleteMany({ where: { workItemId: item.id } });
        await transaction.acceptanceCriterion.deleteMany({ where: { workItemId: item.id } });
        await transaction.useCase.deleteMany({ where: { workItemId: item.id } });
      }

      return retention;
    });
  }

  async purgeExpiredLogs(now = new Date()) {
    return this.db.validationRun.updateMany({
      where: { logExpiresAt: { lt: now }, logBlob: { not: null } },
      data: { logBlob: null },
    });
  }

  private async getTransitionContext(
    item: WorkItemWithFeature,
    input: Pick<TransitionWorkItemInput, 'to' | 'reason' | 'commitSha'>,
  ): Promise<TransitionContext> {
    const usesGreenEvidence = ['GREEN_CONFIRMED', 'READY_FOR_REVIEW', 'APPROVED', 'CLOSED']
      .includes(input.to);
    const [authorization, tests, red, review, greenContext, sliceSizeContext] = await Promise.all([
      this.db.authorization.findFirst({ where: { workItemId: item.id } }),
      this.db.testSpecification.count({ where: { workItemId: item.id } }),
      this.db.validationRun.findFirst({
        where: {
          workItemId: item.id,
          purpose: 'RED',
        },
        include: { profile: { include: { repository: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.db.review.findFirst({
        where: { workItemId: item.id },
        include: { findings: true },
        orderBy: { createdAt: 'desc' },
      }),
      usesGreenEvidence
        ? this.getGreenEvidenceContext(item, true)
        : Promise.resolve(emptyGreenEvidenceContext()),
      input.to === 'READY'
        ? this.getSliceSizeTransitionContext(item)
        : Promise.resolve({
            status: undefined as 'OK' | 'SPLIT_RECOMMENDED' | 'EXCEPTION_REQUIRED' | undefined,
            approved: false,
          }),
    ]);

    const redEvidence = red?.resultKind === 'TEST_FAILURE' ? red : undefined;
    const redEvidenceSummary = redEvidence
      ? decodeJson<{
          fingerprint?: string;
          contentFingerprint?: string;
          redEvidenceKind?: 'BEHAVIORAL' | 'STRUCTURAL';
        }>(redEvidence.summaryJson, {})
      : {};
    const currentRedSnapshot = redEvidence && (
      redEvidenceSummary.fingerprint || redEvidenceSummary.contentFingerprint
    )
      ? await this.git.capture(redEvidence.profile.repository.path)
      : undefined;
    const currentSha = input.to === 'RED_CONFIRMED'
      ? currentRedSnapshot?.sha ?? item.currentSha ?? redEvidence?.sha
      : usesGreenEvidence
        ? greenContext.currentSha ?? item.currentSha ?? greenContext.greenEvidenceSha
        : item.currentSha ?? redEvidence?.sha ?? greenContext.greenEvidenceSha;
    const currentFingerprint = input.to === 'RED_CONFIRMED'
      ? currentRedSnapshot?.fingerprint
      : usesGreenEvidence
        ? greenContext.currentFingerprint
        : undefined;
    const currentContentFingerprint = input.to === 'RED_CONFIRMED'
      ? currentRedSnapshot?.contentFingerprint
      : usesGreenEvidence
        ? greenContext.currentContentFingerprint
        : undefined;

    return {
      requirementsComplete: item.requirementsComplete,
      authorized: Boolean(authorization),
      testsDefined: tests > 0 || item.tddPolicy !== 'REQUIRED',
      redEvidence: Boolean(redEvidence),
      redEvidenceSha: redEvidence?.sha,
      redEvidenceContentFingerprint: input.to === 'RED_CONFIRMED'
        ? redEvidenceSummary.contentFingerprint
        : undefined,
      redEvidenceFingerprint: input.to === 'RED_CONFIRMED'
        ? redEvidenceSummary.fingerprint
        : undefined,
      redEvidenceKind: input.to === 'RED_CONFIRMED'
        ? redEvidenceSummary.redEvidenceKind
        : undefined,
      redEvidenceReason: input.reason,
      currentSha,
      currentFingerprint,
      currentContentFingerprint,
      greenEvidence: greenContext.greenEvidence,
      greenEvidenceSha: greenContext.greenEvidenceSha,
      greenEvidenceFingerprint: usesGreenEvidence
        ? greenContext.greenEvidenceFingerprint
        : undefined,
      greenEvidenceContentFingerprint: usesGreenEvidence
        ? greenContext.greenEvidenceContentFingerprint
        : undefined,
      greenEvidencePendingRepositories: usesGreenEvidence
        ? greenContext.greenEvidencePendingRepositories
        : undefined,
      tddExceptionReason: input.reason,
      reviewApproved: review?.verdict === 'APPROVED',
      hasBlockingFindings: review?.findings.some(
        (finding) => !finding.resolved && ['CRITICAL', 'HIGH'].includes(finding.severity),
      ),
      changesRequired: review?.verdict === 'CHANGES_REQUIRED',
      commitSha: input.commitSha,
      blockReason: input.reason,
      sliceSizeStatus: sliceSizeContext.status,
      sliceSizeApproved: sliceSizeContext.approved,
    };
  }

  private async getSliceSizeTransitionContext(item: WorkItemWithFeature): Promise<{
    status: 'OK' | 'SPLIT_RECOMMENDED' | 'EXCEPTION_REQUIRED';
    approved: boolean;
  }> {
    const project = await this.db.project.findUnique({ where: { id: item.feature.projectId } });
    if (!project) {
      fail('PROJECT_NOT_FOUND');
    }

    const plan = await this.checkPlan({
      projectKey: (project as NonNullable<typeof project>).key,
      featureKey: item.feature.key,
    });
    const auditedItem = plan.items.find((candidate) => candidate.key === item.key);
    const [approval, approvalEvent] = await Promise.all([
      this.db.decision.findFirst({
        where: {
          workItemId: item.id,
          key: sliceSizeApprovalKey(item.feature.key, item.key),
          durable: true,
        },
      }),
      this.db.workflowEvent.findFirst({
        where: {
          workItemId: item.id,
          type: 'SLICE_SIZE_APPROVED',
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const approvalPayload = approvalEvent
      ? decodeJson<{ actor?: string; decisionKey?: string }>(approvalEvent.payloadJson, {})
      : {};

    return {
      status: auditedItem?.status ?? 'OK',
      approved: Boolean(
        approval &&
        approvalEvent &&
        approvalPayload.decisionKey === approval.key &&
        approvalPayload.actor?.toLowerCase().startsWith('human:'),
      ),
    };
  }

  private async getGreenEvidenceContext(
    item: WorkItemWithFeature,
    captureCurrent: boolean,
  ): Promise<GreenEvidenceContext> {
    const [snapshots, validations] = await Promise.all([
      this.db.repositorySnapshot.findMany({
        where: { workItemId: item.id },
        include: { repository: true },
        orderBy: { capturedAt: 'desc' },
      }),
      this.db.validationRun.findMany({
        where: { workItemId: item.id, purpose: 'GREEN' },
        include: { profile: { include: { repository: true } } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    const repositories = new Map<string, { id: string; key: string; path: string }>();

    for (const snapshot of snapshots) {
      repositories.set(snapshot.repository.id, snapshot.repository);
    }

    if (snapshots.length === 0) {
      for (const validation of validations) {
        repositories.set(validation.profile.repository.id, validation.profile.repository);
      }
    }

    const latestByRepository = new Map<string, (typeof validations)[number]>();
    for (const validation of validations) {
      if (!latestByRepository.has(validation.profile.repository.id)) {
        latestByRepository.set(validation.profile.repository.id, validation);
      }
    }

    const entries = await Promise.all(
      [...repositories.values()].map(async (repository) => {
        const validation = latestByRepository.get(repository.id);
        const summary = validation
          ? decodeJson<{ fingerprint?: string; contentFingerprint?: string }>(
              validation.summaryJson,
              {},
            )
          : {};
        const currentSnapshot = captureCurrent && validation
          ? await this.git.capture(repository.path)
          : undefined;

        return { repository, validation, summary, currentSnapshot };
      }),
    );
    const greenEvidence = entries.length > 0 && entries.every((entry) => (
      entry.validation?.resultKind === 'PASS'
    ));
    const hasAnyEvidence = entries.some((entry) => Boolean(entry.validation));
    const greenEvidencePendingRepositories = hasAnyEvidence
      ? entries
          .filter((entry) => entry.validation?.resultKind !== 'PASS')
          .map((entry) => entry.repository.key)
          .sort()
      : [];
    const greenEvidenceIsCurrent = greenEvidence && entries.every((entry) => (
      Boolean(entry.validation && entry.currentSnapshot) &&
      matchesGreenSnapshot(
        entry.summary,
        entry.validation as NonNullable<typeof entry.validation>,
        entry.currentSnapshot as NonNullable<typeof entry.currentSnapshot>,
      )
    ));

    return {
      greenEvidence,
      greenEvidenceIsCurrent,
      greenEvidencePendingRepositories,
      greenEvidenceSha: aggregateEvidenceValues(
        entries.map((entry) => ({ key: entry.repository.key, value: entry.validation?.sha })),
      ),
      currentSha: aggregateEvidenceValues(
        entries.map((entry) => ({ key: entry.repository.key, value: entry.currentSnapshot?.sha })),
      ),
      greenEvidenceFingerprint: aggregateEvidenceValues(
        entries.map((entry) => ({ key: entry.repository.key, value: entry.summary.fingerprint })),
      ),
      currentFingerprint: aggregateEvidenceValues(
        entries.map((entry) => ({ key: entry.repository.key, value: entry.currentSnapshot?.fingerprint })),
      ),
      greenEvidenceContentFingerprint: aggregateEvidenceValues(
        entries.map((entry) => ({ key: entry.repository.key, value: entry.summary.contentFingerprint })),
      ),
      currentContentFingerprint: aggregateEvidenceValues(
        entries.map((entry) => ({ key: entry.repository.key, value: entry.currentSnapshot?.contentFingerprint })),
      ),
    };
  }

  private nextAllowedTransition(state: WorkItemState): string | undefined {
    const transitions: Partial<Record<WorkItemState, string>> = {
      DRAFT: 'READY',
      READY: 'AUTHORIZED',
      AUTHORIZED: 'TESTS_DEFINED',
      TESTS_DEFINED: 'RED_CONFIRMED',
      RED_CONFIRMED: 'IMPLEMENTING',
      TDD_EXCEPTION_APPROVED: 'IMPLEMENTING',
      IMPLEMENTING: 'GREEN_CONFIRMED',
      GREEN_CONFIRMED: 'READY_FOR_REVIEW',
      READY_FOR_REVIEW: 'APPROVED',
      APPROVED: 'CLOSED',
      CHANGES_REQUIRED: 'TESTS_DEFINED',
    };

    return transitions[state];
  }

  private async requireProject(key: string): Promise<Project> {
    const project = await this.db.project.findUnique({ where: { key } });

    if (!project) {
      fail('PROJECT_NOT_FOUND');
    }

    return project as Project;
  }

  private async requireFeature(projectKey: string, featureKey: string): Promise<Feature> {
    const project = await this.requireProject(projectKey);
    const feature = await this.db.feature.findFirst({
      where: { projectId: project.id, key: featureKey },
    });

    if (!feature) {
      fail('FEATURE_NOT_FOUND');
    }

    return feature as Feature;
  }

  private async requireItem(
    projectKey: string,
    featureKey: string,
    itemKey: string,
  ): Promise<WorkItemWithFeature> {
    const feature = await this.requireFeature(projectKey, featureKey);
    const item = await this.db.workItem.findFirst({
      where: { featureId: feature.id, key: itemKey },
      include: { feature: true },
    });

    if (!item) {
      fail('WORK_ITEM_NOT_FOUND');
    }

    return item as WorkItemWithFeature;
  }

  private async findCurrentItem(
    projectKey: string,
    featureKey?: string,
  ): Promise<WorkItemWithFeature> {
    const project = await this.requireProject(projectKey);
    const feature = featureKey
      ? await this.db.feature.findFirst({ where: { projectId: project.id, key: featureKey } })
      : await this.db.feature.findFirst({
          where: { projectId: project.id, status: 'ACTIVE' },
          orderBy: { updatedAt: 'desc' },
        });

    if (!feature) {
      fail('FEATURE_NOT_FOUND');
    }

    const item = (await this.db.workItem.findFirst({
      where: { featureId: (feature as Feature).id, state: { not: 'CLOSED' } },
      orderBy: { position: 'asc' },
      include: { feature: true },
    })) ?? (await this.db.workItem.findFirst({
      where: { featureId: (feature as Feature).id },
      orderBy: { position: 'desc' },
      include: { feature: true },
    }));

    if (!item) {
      fail('ACTIVE_WORK_ITEM_NOT_FOUND');
    }

    return item as WorkItemWithFeature;
  }
}

export const isWorkflowApplicationError = (
  error: unknown,
): error is WorkflowApplicationError => error instanceof WorkflowApplicationError;

function sliceSizeApprovalKey(featureKey: string, itemKey: string): string {
  return `SLICE-SIZE-APPROVAL-${featureKey}-${itemKey}`;
}

function sliceSizeRequestKey(featureKey: string, itemKey: string): string {
  return `SLICE-SIZE-REQUEST-${featureKey}-${itemKey}`;
}

function readSliceSizePolicy(definitionJson: string): SliceSizePolicy {
  const definition = decodeJson<Record<string, unknown>>(definitionJson, {});
  const rawPolicy = definition.slicePolicy;

  if (!rawPolicy || typeof rawPolicy !== 'object' || Array.isArray(rawPolicy)) {
    return { ...DEFAULT_SLICE_SIZE_POLICY };
  }

  const candidate = rawPolicy as Record<string, unknown>;
  const policy = {
    maxUseCases: candidate.maxUseCases,
    maxRequiredCriteria: candidate.maxRequiredCriteria,
    maxTests: candidate.maxTests,
    maxRepositories: candidate.maxRepositories,
  };

  if (Object.values(policy).every((value) => Number.isInteger(value) && (value as number) >= 1)) {
    return policy as SliceSizePolicy;
  }

  return { ...DEFAULT_SLICE_SIZE_POLICY };
}

function emptyGreenEvidenceContext(): GreenEvidenceContext {
  return {
    greenEvidence: false,
    greenEvidenceIsCurrent: false,
    greenEvidencePendingRepositories: [],
  };
}

function matchesGreenSnapshot(
  summary: { fingerprint?: string; contentFingerprint?: string },
  validation: { sha: string },
  current: { sha: string; fingerprint: string; contentFingerprint?: string },
): boolean {
  if (summary.contentFingerprint) {
    return Boolean(
      current.contentFingerprint &&
      summary.contentFingerprint === current.contentFingerprint,
    );
  }

  if (summary.fingerprint) {
    return summary.fingerprint === current.fingerprint;
  }

  return validation.sha === current.sha;
}

function aggregateEvidenceValues(
  values: Array<{ key: string; value?: string }>,
): string | undefined {
  if (values.length === 0 || values.some((entry) => !entry.value)) {
    return undefined;
  }

  const normalized = values
    .map((entry) => ({ key: entry.key, value: entry.value as string }))
    .sort((left, right) => left.key.localeCompare(right.key));

  return createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex');
}

function historySummaryText(deliveredJson: string, state: string): string {
  const delivered = decodeJson<{ title?: string; summary?: string }>(deliveredJson, {});
  return delivered.summary ?? delivered.title ?? state;
}

function findClosedTransition(events: Array<{ payloadJson: string }>): {
  reason?: string;
  commitSha?: string;
} | undefined {
  for (const event of events) {
    const payload = decodeJson<{
      to?: string;
      reason?: string;
      commitSha?: string;
    }>(event.payloadJson, {});

    if (payload.to === 'CLOSED') {
      return { reason: payload.reason, commitSha: payload.commitSha };
    }
  }

  return undefined;
}
