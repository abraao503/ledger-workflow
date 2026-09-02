import { gzipSync } from 'node:zlib';
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
import { GitReadAdapter } from './git-read-adapter.js';
import { fail, WorkflowApplicationError } from './errors.js';
import { decodeJson, encodeJson } from './json.js';
import type {
  AddRepositoryInput,
  AuthorizeWorkItemInput,
  CompactHistoryInput,
  ContextRequest,
  CreateValidationProfileInput,
  CreateFeatureInput,
  CreateProjectInput,
  CreateTemplateInput,
  DefineWorkItemInput,
  RecordRequest,
  RecordValidationInput,
  SubmitReviewInput,
  TransitionWorkItemInput,
  GitReadPort,
} from './types.js';

const LOG_RETENTION_DAYS = 7;

type WorkItemWithFeature = WorkItem & {
  feature: Feature;
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

  async submitReview(input: SubmitReviewInput) {
    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);

    if (item.state !== 'READY_FOR_REVIEW') {
      fail('REVIEW_STATE_INVALID');
    }

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
          payloadJson: encodeJson({ verdict: input.verdict, reviewer: input.reviewer }),
        },
      });

      return review;
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

  async getContext(input: ContextRequest): Promise<WorkflowContext> {
    const item = input.itemKey
      ? await this.requireItem(input.projectKey, input.featureKey ?? '', input.itemKey)
      : await this.findCurrentItem(input.projectKey, input.featureKey);
    const [authorization, snapshots, criteria, decisions, pendingItems, recentItems, oldSummaries, tests] =
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
      ]);

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
        authorization: authorization
          ? {
              instruction: authorization.instruction,
              allowedEffects: decodeJson(authorization.allowedEffectsJson, []),
              forbiddenEffects: decodeJson(authorization.forbiddenEffectsJson, []),
            }
          : undefined,
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
        recentSlices: recentItems.reverse().map((recent) => ({
          key: recent.key,
          state: recent.state,
          result: recent.state === 'CLOSED' ? 'CLOSED' : recent.state,
          summary: recent.summary ?? recent.title,
          commitRefs: [],
        })),
        olderSummaries: oldSummaries.map((summary) => ({
          key: summary.scopeKey,
          summary: historySummaryText(summary.deliveredJson, summary.state),
        })),
        requiredChecks: tests.map((test) => ({
          key: test.key,
          description: `${test.purpose}: ${test.name}`,
        })),
      },
      input.maxChars,
    );
  }

  async getRecord(input: RecordRequest) {
    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    const [useCases, criteria, tests, authorization, snapshots, validations, reviews, decisions, pendingItems] =
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
      })),
      reviews,
      decisions,
      pendingItems,
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
    input: TransitionWorkItemInput,
  ): Promise<TransitionContext> {
    const [authorization, tests, red, green, review] = await Promise.all([
      this.db.authorization.findFirst({ where: { workItemId: item.id } }),
      this.db.testSpecification.count({ where: { workItemId: item.id } }),
      this.db.validationRun.findFirst({
        where: {
          workItemId: item.id,
          purpose: 'RED',
          resultKind: 'TEST_FAILURE',
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.db.validationRun.findFirst({
        where: {
          workItemId: item.id,
          purpose: 'GREEN',
          resultKind: 'PASS',
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.db.review.findFirst({
        where: { workItemId: item.id },
        include: { findings: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      requirementsComplete: item.requirementsComplete,
      authorized: Boolean(authorization),
      testsDefined: tests > 0 || item.tddPolicy !== 'REQUIRED',
      redEvidence: Boolean(red),
      redEvidenceSha: red?.sha,
      currentSha: item.currentSha ?? red?.sha ?? green?.sha,
      greenEvidence: Boolean(green),
      greenEvidenceSha: green?.sha,
      tddExceptionReason: input.reason,
      reviewApproved: review?.verdict === 'APPROVED',
      hasBlockingFindings: review?.findings.some(
        (finding) => !finding.resolved && ['CRITICAL', 'HIGH'].includes(finding.severity),
      ),
      changesRequired: review?.verdict === 'CHANGES_REQUIRED',
      commitSha: input.commitSha,
      blockReason: input.reason,
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

    const item = await this.db.workItem.findFirst({
      where: { featureId: (feature as Feature).id, state: { not: 'CLOSED' } },
      orderBy: { position: 'asc' },
      include: { feature: true },
    });

    if (!item) {
      fail('ACTIVE_WORK_ITEM_NOT_FOUND');
    }

    return item as WorkItemWithFeature;
  }
}

export const isWorkflowApplicationError = (
  error: unknown,
): error is WorkflowApplicationError => error instanceof WorkflowApplicationError;

function historySummaryText(deliveredJson: string, state: string): string {
  const delivered = decodeJson<{ title?: string; summary?: string }>(deliveredJson, {});
  return delivered.summary ?? delivered.title ?? state;
}
