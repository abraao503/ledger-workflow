import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import path from 'node:path';

import { Prisma } from '@prisma/client';
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
import {
  decodeWorkItemScope,
  validateWorkItemScope,
} from '../domain/work-item-scope.js';
import { assessPlanSemantics } from '../domain/planning-semantics.js';
import {
  assessValidationCoverage,
  deriveValidationRequirements,
} from '../domain/validation-requirements.js';
import { GitReadAdapter } from './git-read-adapter.js';
import { fail, WorkflowApplicationError } from './errors.js';
import { decodeJson, encodeJson } from './json.js';
import {
  criterionPolarityValues,
  evidenceKindValues,
  riskTagValues,
  validationCapabilityValues,
} from './types.js';
import type {
  AddRepositoryInput,
  ApproveSliceSizeInput,
  AuthorizeWorkItemInput,
  ClaimWorkItemInput,
  CompactHistoryInput,
  ContextRequest,
  CreateValidationProfileInput,
  CreateFeatureInput,
  CreateProjectInput,
  CreateTemplateInput,
  DefineWorkItemInput,
  CreatePointTaskInput,
  CreateTaskInput,
  ConfirmStructuralRedInput,
  InvalidateGreenInput,
  ListValidationsInput,
  ListFeaturesInput,
  ListRepositoriesInput,
  ListDecisionsInput,
  ListPendingItemsInput,
  RecordDecisionInput,
  RecordPendingItemInput,
  PlanCheckRequest,
  PlanCheckResult,
  RecordRequest,
  RecordValidationInput,
  RecoverWorkItemLeaseInput,
  RenewWorkItemLeaseInput,
  ReleaseWorkItemLeaseInput,
  ReconcileWorkItemLeasesInput,
  ReadyFrontierRequest,
  ReadyFrontierResult,
  ReadyFrontierItem,
  ReplanWorkItemInput,
  ResolvePendingItemInput,
  RequestSliceSizeExceptionInput,
  ReopenWorkItemInput,
  SubmitReviewInput,
  TransitionWorkItemInput,
  GitReadPort,
  GitWorkspacePort,
  AddWorkItemDependencyInput,
  RemoveWorkItemDependencyInput,
  PrepareIntegrationInput,
  AuthorizeIntegrationInput,
  IntegrateWorkItemInput,
  CleanupWorkItemInput,
  FeatureExecutionCounts,
  FeatureExecutionStatus,
} from './types.js';

const LOG_RETENTION_DAYS = 7;
const POINT_TASK_TEMPLATE_KEY = '__workflow-point-task';

type WorkItemWithFeature = WorkItem & {
  feature: Feature;
};

type LedgerExecutor = PrismaClient | Prisma.TransactionClient;

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

  private workspaceGit(): GitWorkspacePort {
    const candidate = this.git as Partial<GitWorkspacePort>;
    if (
      !candidate.createWorktree ||
      !candidate.removeWorktree ||
      !candidate.deleteBranch ||
      !candidate.rebaseWorktree ||
      !candidate.getHead ||
      !candidate.diffFiles ||
      !candidate.fastForward
    ) {
      fail('WORKTREE_GIT_UNAVAILABLE');
    }

    return this.git as GitWorkspacePort;
  }

  private async lockProjectForWrite(
    transaction: Prisma.TransactionClient,
    projectId: string,
  ): Promise<void> {
    // SQLite has no advisory locks. A no-op update takes the project row's
    // write lock for the duration of the transaction, serializing claims and
    // dependency-graph mutations for the same project without changing data.
    const affectedRows = await transaction.$executeRaw(
      Prisma.sql`UPDATE "Project" SET "id" = "id" WHERE "id" = ${projectId}`,
    );
    if (affectedRows !== 1) {
      fail('PROJECT_NOT_FOUND');
    }
  }

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
        taskType: 'FEATURE',
        currentPhaseKey: undefined,
      },
    });
  }

  async createPointTask(input: CreatePointTaskInput) {
    if (!input.key.trim()) {
      fail('TASK_KEY_REQUIRED');
    }

    if (!input.title.trim()) {
      fail('TASK_TITLE_REQUIRED');
    }

    if (!input.summary.trim()) {
      fail('TASK_SUMMARY_REQUIRED');
    }

    const scopeIssues = input.scope ? validateWorkItemScope(input.scope) : [];
    if (scopeIssues.length) {
      fail(scopeIssues[0].code);
    }

    const project = await this.requireProject(input.projectKey);
    const kind = input.kind ?? 'CODE';
    const useCases = input.useCases ?? [];
    const criteria = input.criteria ?? [];
    const tests = input.tests ?? [];
    if (![useCases, criteria, tests].every(Array.isArray)) {
      fail('TASK_CONTRACT_INVALID');
    }
    const isUiPatch = kind === 'CODE' && Boolean(
      isFrontendUiScope(input.scope)
      || input.riskTags?.some((tag) => tag === 'FRONTEND' || tag === 'VISUAL_ONLY'),
    );
    const riskTags = normalizeCatalogValues(
      isUiPatch ? ['FRONTEND', ...(input.riskTags ?? [])] : (input.riskTags ?? []),
      riskTagValues,
      'RISK_TAG_INVALID',
    );

    const hasContract = isUiPatch || riskTags.length > 0
      || useCases.length > 0 || criteria.length > 0 || tests.length > 0;
    if (hasContract) {
      const contractError = isUiPatch ? 'TASK_UI_CONTRACT_REQUIRED' : 'TASK_CONTRACT_INVALID';
      const scope = input.scope ?? fail(contractError);
      const useCaseKeys = new Set(useCases.map((useCase) => useCase.key));
      const criterionKeys = new Set(criteria.map((criterion) => criterion.key));
      const testKeys = new Set(tests.map((test) => test.key));
      const uiCriteria = criteria.filter((criterion) => (
        criterion.required !== false
        && criterion.polarity !== 'FORBIDDEN'
        && criterion.evidenceKind === 'UI'
      ));
      if (
        useCases.length === 0
        || useCases.some((useCase) => !useCase.actor?.trim())
        || useCaseKeys.size !== useCases.length
        || criterionKeys.size !== criteria.length
        || testKeys.size !== tests.length
        || (isUiPatch && uiCriteria.length === 0)
        || criteria.some((criterion) => !criterion.useCaseKey || !useCaseKeys.has(criterion.useCaseKey))
        || tests.some((test) => !test.criterionKey || !criterionKeys.has(test.criterionKey))
        || criteria.some((criterion) => (
          (criterion.evidenceKind && !evidenceKindValues.includes(criterion.evidenceKind))
          || (criterion.polarity && !criterionPolarityValues.includes(criterion.polarity))
        ))
      ) {
        fail(contractError);
      }

      const semantic = assessPlanSemantics({
        useCases,
        criteria,
        tests,
        requiresTests: kind === 'CODE',
      });
      if (semantic.status !== 'OK') {
        fail(contractError, 'A jornada precisa de um resultado e critérios observáveis.', {
          issues: semantic.issues,
        });
      }

      const profiles = await this.db.validationProfile.findMany({
        where: {
          active: true,
          repository: {
            projectId: project.id,
            key: { in: scope.repositories.map((repository) => repository.repositoryKey) },
          },
        },
        select: { key: true, capabilitiesJson: true },
      });
      const validationProfiles = profiles.map((profile) => ({
        key: profile.key,
        capabilities: decodeJson<string[]>(profile.capabilitiesJson, []),
      }));
      const uiCriterionKeys = new Set(uiCriteria.map((criterion) => criterion.key));
      const hasLinkedUiTest = !isUiPatch || tests.some((test) => (
        uiCriterionKeys.has(test.criterionKey ?? '')
        && validationProfiles.some((profile) => (
          profile.key === test.runnerProfileKey
          && profile.capabilities.includes('UI_INTERACTION')
        ))
      ));
      const validation = assessValidationCoverage({ riskTags, tests, profiles: validationProfiles });
      if (!hasLinkedUiTest || validation.status !== 'OK') {
        fail('VALIDATION_PLAN_INCOMPLETE', 'O plano precisa de perfis que cubram os riscos e o critério UI.', {
          missingCapabilities: validation.missingCapabilities,
          missingProfileKeys: validation.missingProfileKeys,
        });
      }
    }

    return this.db.$transaction(async (transaction) => {
      await this.lockProjectForWrite(transaction, project.id);

      const existing = await transaction.feature.findFirst({
        where: { projectId: project.id, key: input.key.trim() },
      });
      if (existing) {
        fail('TASK_KEY_EXISTS');
      }

      if (input.scope) {
        const declaredRepositoryKeys = input.scope.repositories.map((repository) => repository.repositoryKey);
        const repositories = await transaction.repository.findMany({
          where: {
            projectId: project.id,
            key: { in: declaredRepositoryKeys },
          },
          select: { key: true },
        });
        if (repositories.length !== declaredRepositoryKeys.length) {
          fail('SCOPE_REPOSITORY_NOT_FOUND');
        }
      }

      let template = await transaction.workflowTemplateVersion.findFirst({
        where: { projectId: project.id, key: POINT_TASK_TEMPLATE_KEY },
        orderBy: { version: 'desc' },
      });
      if (!template) {
        template = await transaction.workflowTemplateVersion.create({
          data: {
            projectId: project.id,
            key: POINT_TASK_TEMPLATE_KEY,
            version: 1,
            name: 'Tarefa pontual',
            definitionJson: encodeJson({
              taskType: 'PATCH',
              slicePolicy: DEFAULT_SLICE_SIZE_POLICY,
            }),
          },
        });
      }

      const feature = await transaction.feature.create({
        data: {
          projectId: project.id,
          templateId: template.id,
          key: input.key.trim(),
          name: input.title.trim(),
          summary: input.summary.trim(),
          taskType: 'PATCH',
          currentPhaseKey: 'PATCH',
        },
      });
      const item = await transaction.workItem.create({
        data: {
          featureId: feature.id,
          key: '01',
          phaseKey: 'PATCH',
          position: 1,
          title: input.title.trim(),
          kind,
          taskType: 'PATCH',
          state: 'READY',
          summary: input.summary.trim(),
          requirementsComplete: true,
          tddPolicy: 'EXEMPT',
          riskTagsJson: encodeJson(riskTags),
          scopeJson: input.scope ? encodeJson(input.scope) : undefined,
        },
      });

      const useCasesByKey = new Map<string, string>();
      for (const useCase of useCases) {
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
      for (const criterion of criteria) {
        const created = await transaction.acceptanceCriterion.create({
          data: {
            workItemId: item.id,
            useCaseId: criterion.useCaseKey ? useCasesByKey.get(criterion.useCaseKey) : undefined,
            key: criterion.key,
            statement: criterion.statement,
            required: criterion.required !== false,
            evidenceKind: criterion.evidenceKind ?? 'GENERAL',
            polarity: criterion.polarity ?? 'EXPECTED',
          },
        });
        criteriaByKey.set(criterion.key, created.id);
      }

      for (const test of tests) {
        await transaction.testSpecification.create({
          data: {
            workItemId: item.id,
            criterionId: test.criterionKey ? criteriaByKey.get(test.criterionKey) : undefined,
            key: test.key,
            name: test.name,
            purpose: test.purpose,
            runnerProfileKey: test.runnerProfileKey,
          },
        });
      }

      await transaction.workflowEvent.create({
        data: {
          projectId: project.id,
          featureId: feature.id,
          workItemId: item.id,
          type: 'TASK_CREATED',
          payloadJson: encodeJson({
            taskType: 'PATCH',
            key: feature.key,
            itemKey: item.key,
            kind,
          }),
        },
      });

      return { feature, item };
    });
  }

  async createTask(input: CreateTaskInput) {
    if (input.type === 'PATCH') {
      return this.createPointTask(input);
    }

    if (input.type !== 'FEATURE') {
      fail('TASK_TYPE_INVALID', 'Tipo de tarefa inválido. Use FEATURE ou PATCH.');
    }

    const templateKey = input.templateKey?.trim() ?? '';
    if (!templateKey) {
      fail('TASK_TEMPLATE_REQUIRED', 'FEATURE exige um template; PATCH não exige template.');
    }

    return this.createFeature({
      projectKey: input.projectKey,
      templateKey,
      templateVersion: input.templateVersion,
      key: input.key,
      name: input.title,
      summary: input.summary,
    });
  }

  async defineWorkItem(input: DefineWorkItemInput) {
    const feature = await this.requireFeature(input.projectKey, input.featureKey);
    const scopeIssues = input.scope ? validateWorkItemScope(input.scope) : [];
    if (scopeIssues.length) {
      fail(scopeIssues[0].code);
    }
    const riskTags = normalizeCatalogValues(
      input.riskTags ?? [],
      riskTagValues,
      'RISK_TAG_INVALID',
    );
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

      if (criterion.evidenceKind && !evidenceKindValues.includes(criterion.evidenceKind)) {
        fail('CRITERION_EVIDENCE_KIND_INVALID');
      }

      if (criterion.polarity && !criterionPolarityValues.includes(criterion.polarity)) {
        fail('CRITERION_POLARITY_INVALID');
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
            type: {
              in: ['SLICE_SIZE_REPLANNED', 'SLICE_SEMANTIC_REPLANNED'],
            },
          },
        });

        const parentState = (parentItem as NonNullable<typeof parentItem>).state;
        const isReplannedParent = parentState === 'SUPERSEDED' || (parentState === 'BLOCKED' && replanEvent);
        if (!isReplannedParent) {
          fail('PARENT_ITEM_NOT_REPLANNED');
        }

        parentItemId = (parentItem as NonNullable<typeof parentItem>).id;
      }

      if (input.scope) {
        const declaredRepositoryKeys = input.scope.repositories.map((repository) => repository.repositoryKey);
        const repositories = await transaction.repository.findMany({
          where: {
            projectId: feature.projectId,
            key: { in: declaredRepositoryKeys },
          },
          select: { key: true },
        });

        if (repositories.length !== declaredRepositoryKeys.length) {
          fail('SCOPE_REPOSITORY_NOT_FOUND');
        }
      }

      const item = await transaction.workItem.create({
        data: {
          featureId: feature.id,
          key: input.key,
          phaseKey: input.phaseKey,
          position: input.position,
          title: input.title,
          kind,
          taskType: feature.taskType === 'PATCH' ? 'PATCH' : 'FEATURE',
          summary: input.summary,
          tddPolicy,
          riskTagsJson: encodeJson(riskTags),
          parentItemId,
          scopeJson: input.scope ? encodeJson(input.scope) : undefined,
          requirementsComplete,
        },
      });

      const dependencyRefs = input.dependsOn ?? [];
      const dependencyKeys = new Set<string>();
      const existingDependencies = await transaction.workItemDependency.findMany({
        select: { workItemId: true, dependsOnItemId: true },
      });
      const dependencyEdges = existingDependencies.map((dependency) => ({
        from: dependency.workItemId,
        to: dependency.dependsOnItemId,
      }));

      for (const dependencyRef of dependencyRefs) {
        const dependencyKey = `${dependencyRef.featureKey}:${dependencyRef.itemKey}`;
        if (dependencyKeys.has(dependencyKey)) {
          fail('DUPLICATE_WORK_ITEM_DEPENDENCY');
        }
        dependencyKeys.add(dependencyKey);

        const dependencyFeature = await transaction.feature.findFirst({
          where: { projectId: feature.projectId, key: dependencyRef.featureKey },
        });
        if (!dependencyFeature) {
          fail('DEPENDENCY_FEATURE_NOT_FOUND');
        }

        const dependencyItem = await transaction.workItem.findFirst({
          where: {
            featureId: (dependencyFeature as NonNullable<typeof dependencyFeature>).id,
            key: dependencyRef.itemKey,
          },
        });
        if (!dependencyItem) {
          fail('DEPENDENCY_ITEM_NOT_FOUND');
        }
        if ((dependencyItem as NonNullable<typeof dependencyItem>).id === item.id) {
          fail('WORK_ITEM_DEPENDENCY_CYCLE');
        }

        if (hasDependencyPath(
          dependencyEdges,
          (dependencyItem as NonNullable<typeof dependencyItem>).id,
          item.id,
        )) {
          fail('WORK_ITEM_DEPENDENCY_CYCLE');
        }

        await transaction.workItemDependency.create({
          data: {
            workItemId: item.id,
            dependsOnItemId: (dependencyItem as NonNullable<typeof dependencyItem>).id,
          },
        });
        dependencyEdges.push({
          from: item.id,
          to: (dependencyItem as NonNullable<typeof dependencyItem>).id,
        });
      }

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
            evidenceKind: criterion.evidenceKind ?? 'GENERAL',
            polarity: criterion.polarity ?? 'EXPECTED',
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
            dependsOn: dependencyRefs.map((dependency) => `${dependency.featureKey}:${dependency.itemKey}`),
          }),
        },
      });

      return item;
    });
  }

  async authorizeWorkItem(input: AuthorizeWorkItemInput) {
    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);

    const executionMode = input.executionMode ?? 'SHARED';
    if (executionMode !== 'SHARED' && executionMode !== 'MANAGED_WORKTREE') {
      fail('EXECUTION_MODE_INVALID');
    }

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

    const declaredScope = decodeWorkItemScope(item.scopeJson);
    if (executionMode === 'MANAGED_WORKTREE' && !declaredScope) {
      fail('WORKTREE_SCOPE_REQUIRED');
    }
    if (executionMode === 'MANAGED_WORKTREE' && repositories.some((repository) => !repository.expectedBranch)) {
      fail(
        'WORKTREE_TARGET_BRANCH_REQUIRED',
        'A execução gerenciada exige uma branch de destino explícita em cada repositório.',
        {
          repositories: repositories
            .filter((repository) => !repository.expectedBranch)
            .map((repository) => repository.key),
        },
      );
    }
    if (declaredScope) {
      const declaredRepositoryKeys = declaredScope.repositories
        .map((repository) => repository.repositoryKey)
        .sort();
      const authorizedRepositoryKeys = [...input.repositoryKeys].sort();

      if (JSON.stringify(declaredRepositoryKeys) !== JSON.stringify(authorizedRepositoryKeys)) {
        fail('AUTHORIZATION_SCOPE_MISMATCH');
      }
    }

    const baselines = await Promise.all(
      repositories.map(async (repository) => ({
        repository,
        snapshot: await this.git.capture(repository.path),
      })),
    );

    const dirtyBaselines = baselines.filter(({ snapshot }) => snapshot.dirty);
    if (dirtyBaselines.length > 0) {
      if (executionMode !== 'MANAGED_WORKTREE') {
        fail('DIRTY_BASELINE');
      }
      await this.assertSharedDirtyCoverage(item, dirtyBaselines);
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
      await this.lockProjectForWrite(transaction, item.feature.projectId);
      const authorization = await transaction.authorization.create({
        data: {
          workItemId: item.id,
          instruction: input.instruction,
          actor: input.actor,
          executionMode,
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

      const updateResult = await transaction.workItem.updateMany({
        where: { id: item.id, state: 'READY' },
        data: { state: 'AUTHORIZED', currentSha: baselines[0]?.snapshot.sha },
      });
      if (updateResult.count !== 1) {
        fail('ITEM_NOT_READY');
      }
      const updated = await transaction.workItem.findUnique({ where: { id: item.id } });
      if (!updated) {
        fail('WORK_ITEM_NOT_FOUND');
      }
      const currentUpdated = updated as NonNullable<typeof updated>;

      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'ITEM_AUTHORIZED',
          payloadJson: encodeJson({
            actor: input.actor,
            repositoryCount: baselines.length,
            executionMode,
            riskTags: decodeJson<string[]>(item.riskTagsJson, []),
            requiredCapabilities: deriveValidationRequirements(
              decodeJson<string[]>(item.riskTagsJson, []),
            ).requiredCapabilities,
          }),
        },
      });

      return { authorization, item: currentUpdated };
    });
  }

  private async assertSharedDirtyCoverage(
    item: WorkItemWithFeature,
    dirtyEntries: Array<{
      repository: { id: string; key: string };
      snapshot: { sha: string; branch: string; changedFiles?: string[] };
    }>,
  ): Promise<void> {
    const inFlightItems = await this.db.workItem.findMany({
      where: {
        feature: { projectId: item.feature.projectId },
        state: {
          in: [
            'AUTHORIZED',
            'TESTS_DEFINED',
            'RED_CONFIRMED',
            'TDD_EXCEPTION_APPROVED',
            'IMPLEMENTING',
            'GREEN_CONFIRMED',
            'READY_FOR_REVIEW',
            'APPROVED',
            'CHANGES_REQUIRED',
          ],
        },
      },
      select: { id: true, scopeJson: true },
    });
    const inFlightIds = inFlightItems.map((candidate) => candidate.id);
    const snapshots = inFlightIds.length
      ? await this.db.repositorySnapshot.findMany({
          where: { workItemId: { in: inFlightIds } },
          orderBy: { capturedAt: 'desc' },
        })
      : [];
    const latestByItemAndRepository = new Map<string, (typeof snapshots)[number]>();
    for (const snapshotRecord of snapshots) {
      const mapKey = `${snapshotRecord.workItemId}:${snapshotRecord.repositoryId}`;
      if (!latestByItemAndRepository.has(mapKey)) {
        latestByItemAndRepository.set(mapKey, snapshotRecord);
      }
    }

    for (const { repository, snapshot } of dirtyEntries) {
      const changedFiles = snapshot.changedFiles ?? [];
      const uncovered = changedFiles.filter((changedFile) => !inFlightItems.some((candidate) => {
        const scope = decodeWorkItemScope(candidate.scopeJson);
        const repositoryScope = scope?.repositories.find(
          (entry) => entry.repositoryKey === repository.key,
        );
        if (!repositoryScope) {
          return false;
        }
        const candidateSnapshot = latestByItemAndRepository.get(`${candidate.id}:${repository.id}`);
        if (!candidateSnapshot) {
          return false;
        }
        if (candidateSnapshot.sha !== snapshot.sha || candidateSnapshot.branch !== snapshot.branch) {
          return false;
        }
        const allowedPaths = repositoryScope.paths.length ? repositoryScope.paths : [''];
        return allowedPaths.some((pattern) => scopePathContains(pattern, changedFile));
      }));
      if (uncovered.length > 0) {
        fail(
          'WORKTREE_BASELINE_DIRTY_UNACCOUNTED',
          'O checkout compartilhado está sujo com arquivos que nenhuma fatia autorizada em andamento contabiliza.',
          {
            repositoryKey: repository.key,
            changedFiles: uncovered,
          },
        );
      }
    }
  }

  async addWorkItemDependency(input: AddWorkItemDependencyInput) {
    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    const dependency = await this.requireItem(
      input.projectKey,
      input.dependsOn.featureKey,
      input.dependsOn.itemKey,
    );

    return this.db.$transaction(async (transaction) => {
      await this.lockProjectForWrite(transaction, item.feature.projectId);
      const currentItemResult = await transaction.workItem.findUnique({
        where: { id: item.id },
        include: { feature: true },
      });
      const currentDependencyResult = await transaction.workItem.findUnique({
        where: { id: dependency.id },
      });
      if (!currentItemResult || !currentDependencyResult) {
        fail('WORK_ITEM_NOT_FOUND');
      }
      const currentItem = currentItemResult as NonNullable<typeof currentItemResult>;
      const currentDependency = currentDependencyResult as NonNullable<typeof currentDependencyResult>;
      if (!['DRAFT', 'READY'].includes(currentItem.state)) {
        fail('DEPENDENCY_ITEM_IMMUTABLE');
      }
      if (currentItem.id === currentDependency.id) {
        fail('WORK_ITEM_DEPENDENCY_CYCLE');
      }

      const existing = await transaction.workItemDependency.findUnique({
        where: {
          workItemId_dependsOnItemId: {
            workItemId: currentItem.id,
            dependsOnItemId: currentDependency.id,
          },
        },
      });
      if (existing) {
        fail('WORK_ITEM_DEPENDENCY_EXISTS');
      }

      const edges = await transaction.workItemDependency.findMany({
        select: { workItemId: true, dependsOnItemId: true },
      });
      if (hasDependencyPath(
        edges.map((edge) => ({ from: edge.workItemId, to: edge.dependsOnItemId })),
        currentDependency.id,
        currentItem.id,
      )) {
        fail('WORK_ITEM_DEPENDENCY_CYCLE');
      }

      const created = await transaction.workItemDependency.create({
        data: {
          workItemId: currentItem.id,
          dependsOnItemId: currentDependency.id,
        },
        include: {
          dependsOnItem: { include: { feature: true } },
        },
      });
      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: currentItem.featureId,
          workItemId: currentItem.id,
          type: 'ITEM_DEPENDENCY_ADDED',
          payloadJson: encodeJson({
            dependsOn: `${input.dependsOn.featureKey}:${input.dependsOn.itemKey}`,
          }),
        },
      });
      return created;
    });
  }

  async removeWorkItemDependency(input: RemoveWorkItemDependencyInput) {
    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    const dependency = await this.requireItem(
      input.projectKey,
      input.dependsOn.featureKey,
      input.dependsOn.itemKey,
    );

    return this.db.$transaction(async (transaction) => {
      await this.lockProjectForWrite(transaction, item.feature.projectId);
      const currentItemResult = await transaction.workItem.findUnique({
        where: { id: item.id },
        include: { feature: true },
      });
      const currentDependencyResult = await transaction.workItem.findUnique({
        where: { id: dependency.id },
      });
      if (!currentItemResult || !currentDependencyResult) {
        fail('WORK_ITEM_NOT_FOUND');
      }
      const currentItem = currentItemResult as NonNullable<typeof currentItemResult>;
      const currentDependency = currentDependencyResult as NonNullable<typeof currentDependencyResult>;
      if (!['DRAFT', 'READY'].includes(currentItem.state)) {
        fail('DEPENDENCY_ITEM_IMMUTABLE');
      }
      const existing = await transaction.workItemDependency.findUnique({
        where: {
          workItemId_dependsOnItemId: {
            workItemId: currentItem.id,
            dependsOnItemId: currentDependency.id,
          },
        },
      });
      if (!existing) {
        fail('WORK_ITEM_DEPENDENCY_NOT_FOUND');
      }
      const currentExisting = existing as NonNullable<typeof existing>;

      const removed = await transaction.workItemDependency.delete({ where: { id: currentExisting.id } });
      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: currentItem.featureId,
          workItemId: currentItem.id,
          type: 'ITEM_DEPENDENCY_REMOVED',
          payloadJson: encodeJson({
            dependsOn: `${input.dependsOn.featureKey}:${input.dependsOn.itemKey}`,
          }),
        },
      });
      return removed;
    });
  }

  async listWorkItemDependencies(input: RecordRequest) {
    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    const [dependencies, dependents] = await Promise.all([
      this.db.workItemDependency.findMany({
        where: { workItemId: item.id },
        include: { dependsOnItem: { include: { feature: true } } },
        orderBy: { createdAt: 'asc' },
      }),
      this.db.workItemDependency.findMany({
        where: { dependsOnItemId: item.id },
        include: { workItem: { include: { feature: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return {
      dependencies: dependencies.map((entry) => ({
        featureKey: entry.dependsOnItem.feature.key,
        itemKey: entry.dependsOnItem.key,
        title: entry.dependsOnItem.title,
        state: entry.dependsOnItem.state,
      })),
      dependents: dependents.map((entry) => ({
        featureKey: entry.workItem.feature.key,
        itemKey: entry.workItem.key,
        title: entry.workItem.title,
        state: entry.workItem.state,
      })),
    };
  }

  async claimWorkItem(input: ClaimWorkItemInput) {
    const holder = input.holder.trim();
    if (!holder) {
      fail('SLICE_CLAIM_HOLDER_REQUIRED');
    }

    const durationSeconds = input.durationSeconds ?? 900;
    if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 86_400) {
      fail('SLICE_CLAIM_DURATION_INVALID');
    }

    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);

    const acquiredAt = new Date();
    const expiresAt = new Date(acquiredAt.getTime() + durationSeconds * 1_000);

    const claimed = await this.db.$transaction(async (transaction) => {
      await this.lockProjectForWrite(transaction, item.feature.projectId);
      const currentItemResult = await transaction.workItem.findUnique({
        where: { id: item.id },
        include: { feature: true },
      });
      const claimableStates = new Set([
        'AUTHORIZED',
        'TESTS_DEFINED',
        'RED_CONFIRMED',
        'TDD_EXCEPTION_APPROVED',
        'IMPLEMENTING',
        'GREEN_CONFIRMED',
        'READY_FOR_REVIEW',
        'APPROVED',
        'CHANGES_REQUIRED',
      ]);
      if (!currentItemResult || !claimableStates.has(currentItemResult.state)) {
        fail('SLICE_CLAIM_STATE_INVALID');
      }
      const currentItem = currentItemResult as NonNullable<typeof currentItemResult>;

      await this.assertDependenciesClosed(currentItem.id, transaction);
      const authorization = await transaction.authorization.findFirst({
        where: { workItemId: currentItem.id },
        orderBy: { createdAt: 'desc' },
      });
      const executionMode = authorization?.executionMode ?? 'SHARED';
      const scope = decodeWorkItemScope(currentItem.scopeJson);
      if (executionMode === 'MANAGED_WORKTREE') {
        if (!scope) {
          fail('WORKTREE_SCOPE_REQUIRED');
        }
        await this.assertScopeAvailable(
          currentItem.id,
          currentItem.feature.projectId,
          scope as NonNullable<typeof scope>,
          acquiredAt,
          transaction,
        );
      }

      const activeLease = await transaction.workItemLease.findFirst({
        where: {
          workItemId: currentItem.id,
          releasedAt: null,
        },
        orderBy: { acquiredAt: 'desc' },
      });

      if (activeLease) {
        if (activeLease.expiresAt <= acquiredAt) {
          fail('SLICE_RESERVATION_EXPIRED_REQUIRES_RECOVERY');
        }

        fail('SLICE_ALREADY_RESERVED');
      }

      const latestLease = await transaction.workItemLease.findFirst({
        where: { workItemId: currentItem.id },
        orderBy: { generation: 'desc' },
        select: { generation: true },
      });
      const generation = (latestLease?.generation ?? 0) + 1;

      let lease;
      try {
        lease = await transaction.workItemLease.create({
          data: {
            workItemId: currentItem.id,
            holder,
            generation,
            acquiredAt,
            expiresAt,
          },
        });
      } catch (error) {
        if (isUniqueConstraintError(error)) {
          fail('SLICE_ALREADY_RESERVED');
        }

        throw error;
      }

      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: currentItem.featureId,
          workItemId: currentItem.id,
          type: 'SLICE_LEASE_ACQUIRED',
          payloadJson: encodeJson({
            holder,
            generation,
            acquiredAt,
            expiresAt,
            durationSeconds,
          }),
        },
      });

      return { lease, item: currentItem, executionMode, scope };
    });

    if (claimed.executionMode !== 'MANAGED_WORKTREE') {
      return claimed;
    }

    try {
      const workspaces = await this.provisionManagedWorkspaces(
        input.projectKey,
        input.featureKey,
        input.itemKey,
        claimed.lease.id,
        claimed.scope as NonNullable<typeof claimed.scope>,
      );
      return { ...claimed, workspaces };
    } catch (error) {
      await this.db.$transaction(async (transaction) => {
        await transaction.workItemLease.update({
          where: { id: claimed.lease.id },
          data: { releasedAt: new Date(), endReason: 'WORKTREE_PROVISION_FAILED' },
        });
        await transaction.workflowEvent.create({
          data: {
            projectId: item.feature.projectId,
            featureId: claimed.item.featureId,
            workItemId: claimed.item.id,
            type: 'SLICE_WORKTREE_PROVISION_FAILED',
            payloadJson: encodeJson({
              leaseId: claimed.lease.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          },
        });
      });
      throw error;
    }
  }

  async recoverWorkItemLease(input: RecoverWorkItemLeaseInput) {
    const holder = input.holder.trim();
    if (!holder) {
      fail('SLICE_CLAIM_HOLDER_REQUIRED');
    }

    const durationSeconds = input.durationSeconds ?? 900;
    if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 86_400) {
      fail('SLICE_CLAIM_DURATION_INVALID');
    }

    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);

    const acquiredAt = new Date();
    const expiresAt = new Date(acquiredAt.getTime() + durationSeconds * 1_000);

    const recovered = await this.db.$transaction(async (transaction) => {
      await this.lockProjectForWrite(transaction, item.feature.projectId);
      const currentItemResult = await transaction.workItem.findUnique({
        where: { id: item.id },
        include: { feature: true },
      });
      if (!currentItemResult || ['CLOSED', 'BLOCKED', 'SUPERSEDED'].includes(currentItemResult.state)) {
        fail('SLICE_CLAIM_STATE_INVALID');
      }
      const currentItem = currentItemResult as NonNullable<typeof currentItemResult>;

      await this.assertDependenciesClosed(currentItem.id, transaction);
      const authorization = await transaction.authorization.findFirst({
        where: { workItemId: currentItem.id },
        orderBy: { createdAt: 'desc' },
      });
      const executionMode = authorization?.executionMode ?? 'SHARED';
      const scope = decodeWorkItemScope(currentItem.scopeJson);
      if (executionMode === 'MANAGED_WORKTREE' && !scope) {
        fail('WORKTREE_SCOPE_REQUIRED');
      }
      if (executionMode === 'MANAGED_WORKTREE') {
        await this.assertScopeAvailable(
          currentItem.id,
          currentItem.feature.projectId,
          scope as NonNullable<typeof scope>,
          acquiredAt,
          transaction,
        );
      }

      const activeLease = await transaction.workItemLease.findFirst({
        where: {
          workItemId: currentItem.id,
          releasedAt: null,
        },
        orderBy: { acquiredAt: 'desc' },
      });

      if (!activeLease) {
        fail('SLICE_RESERVATION_NOT_FOUND');
      }

      if ((activeLease as NonNullable<typeof activeLease>).expiresAt > acquiredAt) {
        fail('SLICE_RESERVATION_NOT_EXPIRED');
      }

      const previousLease = await transaction.workItemLease.update({
        where: { id: (activeLease as NonNullable<typeof activeLease>).id },
        data: { releasedAt: acquiredAt, endReason: 'RECOVERED' },
      });
      await transaction.workItemWorkspace.updateMany({
        where: { leaseId: previousLease.id, status: { in: ['ACTIVE', 'PROVISIONING'] } },
        data: { status: 'ABANDONED' },
      });
      const lease = await transaction.workItemLease.create({
        data: {
          workItemId: currentItem.id,
          holder,
          generation: (activeLease as NonNullable<typeof activeLease>).generation + 1,
          acquiredAt,
          expiresAt,
          recoveredFromId: previousLease.id,
        },
      });

      await transaction.workflowEvent.create({
        data: {
          projectId: currentItem.feature.projectId,
          featureId: currentItem.featureId,
          workItemId: currentItem.id,
          type: 'SLICE_LEASE_RECOVERED',
          payloadJson: encodeJson({
            previousLeaseId: previousLease.id,
            previousHolder: previousLease.holder,
            holder,
            generation: lease.generation,
            acquiredAt,
            expiresAt,
            durationSeconds,
          }),
        },
      });

      return { lease, previousLease, item: currentItem, executionMode, scope };
    });

    if (recovered.executionMode !== 'MANAGED_WORKTREE') {
      return recovered;
    }

    try {
      const workspaces = await this.provisionManagedWorkspaces(
        input.projectKey,
        input.featureKey,
        input.itemKey,
        recovered.lease.id,
        recovered.scope as NonNullable<typeof recovered.scope>,
      );
      return { ...recovered, workspaces };
    } catch (error) {
      await this.db.$transaction(async (transaction) => {
        await transaction.workItemLease.update({
          where: { id: recovered.lease.id },
          data: { releasedAt: new Date(), endReason: 'WORKTREE_PROVISION_FAILED' },
        });
        await transaction.workflowEvent.create({
          data: {
            projectId: item.feature.projectId,
            featureId: item.featureId,
            workItemId: item.id,
            type: 'SLICE_WORKTREE_PROVISION_FAILED',
            payloadJson: encodeJson({
              leaseId: recovered.lease.id,
              recoveredFromId: recovered.previousLease.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          },
        });
      });
      throw error;
    }
  }

  async renewWorkItemLease(input: RenewWorkItemLeaseInput) {
    const holder = input.holder.trim();
    if (!holder) {
      fail('SLICE_CLAIM_HOLDER_REQUIRED');
    }

    const durationSeconds = input.durationSeconds ?? 900;
    if (!Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 86_400) {
      fail('SLICE_CLAIM_DURATION_INVALID');
    }

    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    const renewedAt = new Date();
    const expiresAt = new Date(renewedAt.getTime() + durationSeconds * 1_000);
    const lease = await this.db.$transaction(async (transaction) => {
      await this.lockProjectForWrite(transaction, item.feature.projectId);
      const currentLease = await this.requireActiveExecutionFence(item.id, input.executionFence, transaction);
      if (currentLease.holder !== holder) {
        fail('SLICE_LEASE_HOLDER_MISMATCH');
      }

      const renewed = await transaction.workItemLease.updateMany({
        where: { id: currentLease.id, generation: currentLease.generation, releasedAt: null },
        data: { expiresAt, lastRenewedAt: renewedAt, endReason: null },
      });
      if (renewed.count !== 1) {
        fail('SLICE_LEASE_CHANGED_CONCURRENTLY');
      }
      const updated = await transaction.workItemLease.findUnique({ where: { id: currentLease.id } });
      if (!updated) {
        fail('SLICE_CLAIM_REQUIRED');
      }
      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'SLICE_LEASE_RENEWED',
          payloadJson: encodeJson({ holder, generation: currentLease.generation, renewedAt, expiresAt, durationSeconds }),
        },
      });
      return updated as NonNullable<typeof updated>;
    });

    return { lease, item };
  }

  async releaseWorkItemLease(input: ReleaseWorkItemLeaseInput) {
    const holder = input.holder.trim();
    if (!holder) {
      fail('SLICE_CLAIM_HOLDER_REQUIRED');
    }

    const reason = input.reason?.trim() || 'EXPLICIT_RELEASE';
    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    const releasedAt = new Date();
    const lease = await this.db.$transaction(async (transaction) => {
      await this.lockProjectForWrite(transaction, item.feature.projectId);
      const currentLease = await this.requireActiveExecutionFence(item.id, input.executionFence, transaction);
      if (currentLease.holder !== holder) {
        fail('SLICE_LEASE_HOLDER_MISMATCH');
      }

      const released = await transaction.workItemLease.updateMany({
        where: { id: currentLease.id, generation: currentLease.generation, releasedAt: null },
        data: { releasedAt, endReason: reason },
      });
      if (released.count !== 1) {
        fail('SLICE_LEASE_CHANGED_CONCURRENTLY');
      }
      await transaction.workItemWorkspace.updateMany({
        where: { leaseId: currentLease.id, status: { in: ['ACTIVE', 'PROVISIONING'] } },
        data: { status: 'ABANDONED' },
      });
      const updated = await transaction.workItemLease.findUnique({ where: { id: currentLease.id } });
      if (!updated) {
        fail('SLICE_CLAIM_REQUIRED');
      }
      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'SLICE_LEASE_RELEASED',
          payloadJson: encodeJson({ holder, generation: currentLease.generation, releasedAt, reason }),
        },
      });
      return updated as NonNullable<typeof updated>;
    });

    return { lease, item };
  }

  async reconcileWorkItemLeases(input: ReconcileWorkItemLeasesInput, now = new Date()) {
    const project = await this.requireProject(input.projectKey);
    const workItemWhere = {
      feature: {
        projectId: project.id,
        ...(input.featureKey ? { key: input.featureKey } : {}),
        ...(input.itemKey ? { items: { some: { key: input.itemKey } } } : {}),
      },
    };
    const reconciled = await this.db.$transaction(async (transaction) => {
      await this.lockProjectForWrite(transaction, project.id);
      const expired = await transaction.workItemLease.findMany({
        where: { releasedAt: null, expiresAt: { lte: now }, workItem: workItemWhere },
        include: { workItem: { include: { feature: true } } },
        orderBy: { expiresAt: 'asc' },
      });
      const results: Array<{ leaseId: string; workItemKey: string; featureKey: string; generation: number }> = [];

      for (const lease of expired) {
        const released = await transaction.workItemLease.updateMany({
          where: { id: lease.id, releasedAt: null },
          data: { releasedAt: now, endReason: 'EXPIRED_RECONCILED' },
        });
        if (released.count !== 1) {
          continue;
        }
        await transaction.workItemWorkspace.updateMany({
          where: { leaseId: lease.id, status: { in: ['ACTIVE', 'PROVISIONING'] } },
          data: { status: 'ABANDONED' },
        });
        await transaction.workflowEvent.create({
          data: {
            projectId: project.id,
            featureId: lease.workItem.featureId,
            workItemId: lease.workItemId,
            type: 'SLICE_LEASE_RECONCILED',
            payloadJson: encodeJson({
              leaseId: lease.id,
              holder: lease.holder,
              generation: lease.generation,
              expiredAt: lease.expiresAt,
              releasedAt: now,
            }),
          },
        });
        results.push({
          leaseId: lease.id,
          workItemKey: lease.workItem.key,
          featureKey: lease.workItem.feature.key,
          generation: lease.generation,
        });
      }

      return results;
    });

    return { reconciled: reconciled.length, leases: reconciled };
  }

  private async assertDependenciesClosed(
    itemId: string,
    executor: LedgerExecutor = this.db,
  ): Promise<void> {
    const dependencies = await executor.workItemDependency.findMany({
      where: { workItemId: itemId },
      include: { dependsOnItem: { select: { id: true, key: true, state: true, feature: { select: { key: true } } } } },
    });
    const pending = [];
    for (const dependency of dependencies) {
      if (!(await this.isEffectivelyClosed(dependency.dependsOnItem.id, executor))) {
        pending.push(dependency);
      }
    }
    if (pending.length) {
      fail(
        'WORK_ITEM_DEPENDENCIES_PENDING',
        'A fatia só pode ser reivindicada depois que suas dependências forem fechadas.',
        {
          dependencies: pending.map((dependency) => ({
            featureKey: dependency.dependsOnItem.feature.key,
            itemKey: dependency.dependsOnItem.key,
            state: dependency.dependsOnItem.state,
          })),
        },
      );
    }
  }

  async verifyExecutionFence(input: {
    projectKey: string;
    featureKey: string;
    itemKey: string;
    executionFence?: number;
  }) {
    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    return this.requireActiveExecutionFence(item.id, input.executionFence);
  }

  private async requireActiveExecutionFence(
    itemId: string,
    executionFence: number | undefined,
    executor: LedgerExecutor = this.db,
  ) {
    if (!Number.isInteger(executionFence) || (executionFence as number) < 1) {
      fail('SLICE_EXECUTION_FENCE_REQUIRED');
    }

    const lease = await executor.workItemLease.findFirst({
      where: { workItemId: itemId, releasedAt: null },
      orderBy: { generation: 'desc' },
    });
    if (!lease) {
      fail('SLICE_CLAIM_REQUIRED');
    }

    const currentLease = lease as NonNullable<typeof lease>;
    if (currentLease.generation !== executionFence) {
      fail('SLICE_FENCE_STALE', 'A geração da execução não é mais a vigente.', {
        expectedFence: currentLease.generation,
        receivedFence: executionFence,
      });
    }

    if (currentLease.expiresAt <= new Date()) {
      fail('SLICE_LEASE_EXPIRED');
    }

    return currentLease;
  }

  private async assertScopeAvailable(
    itemId: string,
    projectId: string,
    scope: NonNullable<ReturnType<typeof decodeWorkItemScope>>,
    now: Date,
    executor: LedgerExecutor = this.db,
  ): Promise<void> {
    const [activeLeases, retainedWorkspaces, repositories] = await Promise.all([
      executor.workItemLease.findMany({
        where: {
          releasedAt: null,
          expiresAt: { gt: now },
          workItemId: { not: itemId },
          workItem: { feature: { projectId } },
        },
        include: {
          workItem: { select: { id: true, key: true, scopeJson: true, feature: { select: { key: true } } } },
        },
      }),
      executor.workItemWorkspace.findMany({
        where: {
          status: { not: 'REMOVED' },
          workItemId: { not: itemId },
          workItem: { feature: { projectId } },
        },
        include: {
          workItem: { select: { id: true, key: true, scopeJson: true, feature: { select: { key: true } } } },
          lease: { select: { holder: true } },
        },
      }),
      executor.repository.findMany({
        where: { projectId },
        select: { key: true, path: true },
      }),
    ]);
    const repositoryPaths = new Map(repositories.map((repository) => [repository.key, path.resolve(repository.path)]));
    const occupied = new Map<string, {
      holder: string;
      featureKey: string;
      itemKey: string;
      scopeJson: string | null;
      workspaceStatus?: string;
    }>();
    for (const lease of activeLeases) {
      occupied.set(lease.workItem.id, {
        holder: lease.holder,
        featureKey: lease.workItem.feature.key,
        itemKey: lease.workItem.key,
        scopeJson: lease.workItem.scopeJson,
      });
    }
    for (const workspace of retainedWorkspaces) {
      if (!occupied.has(workspace.workItem.id)) {
        occupied.set(workspace.workItem.id, {
          holder: workspace.lease.holder,
          featureKey: workspace.workItem.feature.key,
          itemKey: workspace.workItem.key,
          scopeJson: workspace.workItem.scopeJson,
          workspaceStatus: workspace.status,
        });
      }
    }
    for (const other of occupied.values()) {
      const otherScope = decodeWorkItemScope(other.scopeJson);
      if (!otherScope) {
        continue;
      }
      const conflicts = findScopeConflicts(scope, otherScope, repositoryPaths);
      if (conflicts.length) {
        fail(
          'WORK_ITEM_SCOPE_CONFLICT',
          'A fatia com paths sobrepostos já está reservada por outro agente.',
          {
            holder: other.holder,
            featureKey: other.featureKey,
            itemKey: other.itemKey,
            conflicts,
            ...(other.workspaceStatus ? { workspaceStatus: other.workspaceStatus } : {}),
          },
        );
      }
    }
  }

  private async provisionManagedWorkspaces(
    projectKey: string,
    featureKey: string,
    itemKey: string,
    leaseId: string,
    scope: NonNullable<ReturnType<typeof decodeWorkItemScope>>,
  ) {
    const item = await this.requireItem(projectKey, featureKey, itemKey);
    const project = await this.requireProject(projectKey);
    const snapshots = await this.db.repositorySnapshot.findMany({
      where: { workItemId: item.id },
      include: { repository: true },
      orderBy: { capturedAt: 'desc' },
    });
    const latestByRepository = new Map<string, (typeof snapshots)[number]>();
    for (const snapshot of snapshots) {
      if (!latestByRepository.has(snapshot.repository.key)) {
        latestByRepository.set(snapshot.repository.key, snapshot);
      }
    }

    const workspaceGit = this.workspaceGit();
    const created: Array<{ repositoryPath: string; worktreePath: string; branch: string }> = [];
    const workspaceData: Array<{
      workItemId: string;
      leaseId: string;
      repositoryId: string;
      path: string;
      branch: string;
      baseSha: string;
    }> = [];

    for (const scopedRepository of scope.repositories) {
      const snapshot = latestByRepository.get(scopedRepository.repositoryKey);
      if (!snapshot) {
        fail('WORKTREE_BASELINE_NOT_FOUND');
      }
      const currentSnapshot = snapshot as NonNullable<typeof snapshot>;
      const current = await this.git.capture(currentSnapshot.repository.path);
      if (
        current.sha !== currentSnapshot.sha ||
        current.branch !== currentSnapshot.branch
      ) {
        fail('WORKTREE_BASELINE_STALE');
      }
      if (current.dirty) {
        await this.assertSharedDirtyCoverage(item, [{
          repository: currentSnapshot.repository,
          snapshot: current,
        }]);
      }

      const repository = currentSnapshot.repository;
      const branch = `workflow/${sanitizeGitSegment(projectKey)}/${sanitizeGitSegment(featureKey)}/${sanitizeGitSegment(itemKey)}/${sanitizeGitSegment(leaseId)}/${sanitizeGitSegment(repository.key)}`;
      const worktreePath = path.resolve(
        project.rootPath,
        '.workflow',
        'worktrees',
        sanitizeGitSegment(projectKey),
        sanitizeGitSegment(featureKey),
        sanitizeGitSegment(itemKey),
        sanitizeGitSegment(leaseId),
        sanitizeGitSegment(repository.key),
      );
      workspaceData.push({
        workItemId: item.id,
        leaseId,
        repositoryId: repository.id,
        path: worktreePath,
        branch,
        baseSha: currentSnapshot.sha,
      });
    }

    const persistedWorkspaces = await this.db.$transaction(async (transaction) => {
      const persisted = [];
      for (const data of workspaceData) {
        persisted.push(await transaction.workItemWorkspace.create({
          data: { ...data, status: 'PROVISIONING' },
        }));
      }
      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'SLICE_WORKTREES_PROVISIONING',
          payloadJson: encodeJson({
            leaseId,
            workspaces: workspaceData.map((workspace) => ({
              repositoryId: workspace.repositoryId,
              path: workspace.path,
              branch: workspace.branch,
              baseSha: workspace.baseSha,
            })),
          }),
        },
      });
      return persisted;
    });

    try {
      for (const data of workspaceData) {
        const repository = snapshots.find((snapshot) => snapshot.repository.id === data.repositoryId)?.repository;
        if (!repository) {
          fail('WORKTREE_BASELINE_NOT_FOUND');
        }
        const currentRepository = repository as NonNullable<typeof repository>;
        created.push({ repositoryPath: currentRepository.path, worktreePath: data.path, branch: data.branch });
        await workspaceGit.createWorktree({
          repositoryPath: currentRepository.path,
          worktreePath: data.path,
          branch: data.branch,
          sha: data.baseSha,
        });
        const workspace = persistedWorkspaces.find((candidate) => candidate.repositoryId === data.repositoryId);
        if (workspace) {
          await this.db.workItemWorkspace.update({
            where: { id: workspace.id },
            data: { status: 'ACTIVE' },
          });
        }
      }
      await this.db.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'SLICE_WORKTREES_PROVISIONED',
          payloadJson: encodeJson({ leaseId, workspaceCount: workspaceData.length }),
        },
      });
      return persistedWorkspaces.map((workspace) => ({ ...workspace, status: 'ACTIVE' }));
    } catch (error) {
      await this.db.$transaction(async (transaction) => {
        await transaction.workItemWorkspace.updateMany({
          where: { leaseId, status: { in: ['PROVISIONING', 'ACTIVE'] } },
          data: { status: 'ABANDONED' },
        });
        await transaction.workflowEvent.create({
          data: {
            projectId: item.feature.projectId,
            featureId: item.featureId,
            workItemId: item.id,
            type: 'SLICE_WORKTREE_PROVISION_FAILED',
            payloadJson: encodeJson({
              leaseId,
              error: error instanceof Error ? error.message : String(error),
            }),
          },
        });
      }).catch(() => undefined);
      for (const workspace of created.reverse()) {
        try {
          await workspaceGit.removeWorktree(workspace.repositoryPath, workspace.worktreePath);
        } catch {
          // Cleanup is retryable and remains visible through the workspace row.
        }
        try {
          await workspaceGit.deleteBranch(workspace.repositoryPath, workspace.branch);
        } catch {
          // Do not force-delete an unmerged branch.
        }
      }
      throw error;
    }
  }

  async prepareIntegration(input: PrepareIntegrationInput) {
    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    await this.requireActiveExecutionFence(item.id, input.executionFence);
    if (item.state !== 'APPROVED') {
      fail('INTEGRATION_PREPARE_STATE_INVALID');
    }
    const authorization = await this.requireManagedAuthorization(item.id);
    const lease = await this.requireActiveExecutionFence(item.id, input.executionFence);
    const scope = decodeWorkItemScope(item.scopeJson);
    if (!scope) {
      fail('WORKTREE_SCOPE_REQUIRED');
    }
    const declaredScope = scope as NonNullable<typeof scope>;
    const workspaces = await this.db.workItemWorkspace.findMany({
      where: { leaseId: lease.id, status: 'ACTIVE' },
      include: { repository: true },
      orderBy: { repository: { key: 'asc' } },
    });
    if (!workspaces.length) {
      fail('WORKTREE_NOT_FOUND');
    }

    const workspaceGit = this.workspaceGit();
    const prepared: Array<{ repositoryKey: string; candidateSha: string; targetBaseSha: string }> = [];
    try {
      for (const workspace of workspaces) {
        const target = await this.git.capture(workspace.repository.path);
        if (
          target.dirty ||
          (workspace.repository.expectedBranch && target.branch !== workspace.repository.expectedBranch)
        ) {
          fail('INTEGRATION_TARGET_DIRTY');
        }
        const worktree = await this.git.capture(workspace.path);
        if (worktree.dirty) {
          fail('WORKTREE_DIRTY');
        }
        if (worktree.branch !== workspace.branch) {
          fail('WORKTREE_BRANCH_MISMATCH');
        }
        await workspaceGit.rebaseWorktree(
          workspace.path,
          workspace.repository.expectedBranch ?? target.branch,
        );
        const targetAfterRebase = await this.git.capture(workspace.repository.path);
        const rebasedWorktree = await this.git.capture(workspace.path);
        if (
          targetAfterRebase.dirty ||
          targetAfterRebase.sha !== target.sha ||
          targetAfterRebase.branch !== target.branch
        ) {
          if (!sameContentSnapshot(worktree, rebasedWorktree)) {
            await this.invalidateGreenForManagedChange(
              item,
              lease.id,
              'A branch de destino avançou durante o rebase da integração.',
              {
                targetBefore: target.sha,
                targetAfter: targetAfterRebase.sha,
                candidateBefore: worktree.sha,
                candidateAfter: rebasedWorktree.sha,
              },
            );
          }
          fail('INTEGRATION_TARGET_STALE');
        }
        const candidateSha = await workspaceGit.getHead(workspace.path);
        const changedFiles = await workspaceGit.diffFiles(
          workspace.repository.path,
          target.sha,
          candidateSha,
        );
        if (!sameContentSnapshot(worktree, rebasedWorktree)) {
          await this.invalidateGreenForManagedChange(
            item,
            lease.id,
            'O rebase alterou o conteúdo validado; um novo GREEN é obrigatório.',
            {
              targetBaseSha: target.sha,
              candidateBefore: worktree.sha,
              candidateAfter: candidateSha,
              changedFiles,
            },
          );
          fail('INTEGRATION_GREEN_REVALIDATION_REQUIRED');
        }
        assertCandidateFilesInScope(declaredScope, workspace.repository.key, changedFiles);
        await this.db.workItemWorkspace.update({
          where: { id: workspace.id },
          data: { candidateSha, targetBaseSha: target.sha },
        });
        prepared.push({
          repositoryKey: workspace.repository.key,
          candidateSha,
          targetBaseSha: target.sha,
        });
      }
    } catch (error) {
      await this.db.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'SLICE_INTEGRATION_PREPARE_FAILED',
          payloadJson: encodeJson({
            leaseId: lease.id,
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      });
      throw error;
    }

    const result = await this.db.$transaction(async (transaction) => {
      await this.lockProjectForWrite(transaction, item.feature.projectId);
      await this.requireActiveExecutionFence(item.id, input.executionFence, transaction);
      await transaction.workItemIntegrationApproval.updateMany({
        where: { workItemId: item.id, status: { in: ['AUTHORIZED', 'IN_PROGRESS'] } },
        data: { status: 'INVALIDATED' },
      });
      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'SLICE_INTEGRATION_PREPARED',
          payloadJson: encodeJson({ leaseId: lease.id, prepared }),
        },
      });
      return prepared;
    });
    return {
      item,
      executionMode: authorization.executionMode,
      lease,
      candidates: Object.fromEntries(result.map((entry) => [entry.repositoryKey, entry.candidateSha])),
      targetBases: Object.fromEntries(result.map((entry) => [entry.repositoryKey, entry.targetBaseSha])),
    };
  }

  async authorizeIntegration(input: AuthorizeIntegrationInput) {
    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    await this.requireActiveExecutionFence(item.id, input.executionFence);
    if (item.state !== 'APPROVED') {
      fail('INTEGRATION_APPROVAL_STATE_INVALID');
    }
    const actor = input.actor.trim();
    if (!actor.toLowerCase().startsWith('human:') || !actor.slice('human:'.length).trim()) {
      fail('INTEGRATION_HUMAN_APPROVAL_REQUIRED');
    }
    await this.requireManagedAuthorization(item.id);
    const lease = await this.requireActiveExecutionFence(item.id, input.executionFence);
    const workspaces = await this.db.workItemWorkspace.findMany({
      where: { leaseId: lease.id, status: 'ACTIVE' },
      include: { repository: true },
      orderBy: { repository: { key: 'asc' } },
    });
    const expectedKeys = workspaces.map((workspace) => workspace.repository.key).sort();
    const candidateKeys = Object.keys(input.candidates).sort();
    const baseKeys = Object.keys(input.targetBases).sort();
    if (
      JSON.stringify(expectedKeys) !== JSON.stringify(candidateKeys) ||
      JSON.stringify(expectedKeys) !== JSON.stringify(baseKeys)
    ) {
      fail('INTEGRATION_APPROVAL_REPOSITORIES_MISMATCH');
    }
    const workspaceGit = this.workspaceGit();
    for (const workspace of workspaces) {
      const worktree = await this.git.capture(workspace.path);
      const currentCandidate = await workspaceGit.getHead(workspace.path);
      if (
        !workspace.candidateSha ||
        worktree.dirty ||
        worktree.branch !== workspace.branch ||
        currentCandidate !== workspace.candidateSha ||
        input.candidates[workspace.repository.key] !== workspace.candidateSha
      ) {
        fail('INTEGRATION_CANDIDATE_STALE');
      }
      if (!input.targetBases[workspace.repository.key]) {
        fail('INTEGRATION_TARGET_BASE_REQUIRED');
      }
      if (workspace.targetBaseSha && input.targetBases[workspace.repository.key] !== workspace.targetBaseSha) {
        fail('INTEGRATION_TARGET_STALE');
      }
      const target = await this.git.capture(workspace.repository.path);
      if (
        target.dirty ||
        target.sha !== input.targetBases[workspace.repository.key] ||
        (workspace.repository.expectedBranch && target.branch !== workspace.repository.expectedBranch)
      ) {
        fail('INTEGRATION_TARGET_STALE');
      }
    }

    return this.db.$transaction(async (transaction) => {
      await this.lockProjectForWrite(transaction, item.feature.projectId);
      await this.requireActiveExecutionFence(item.id, input.executionFence, transaction);
      await transaction.workItemIntegrationApproval.updateMany({
        where: { workItemId: item.id, status: { in: ['AUTHORIZED', 'IN_PROGRESS'] } },
        data: { status: 'INVALIDATED' },
      });
      const approval = await transaction.workItemIntegrationApproval.create({
        data: {
          workItemId: item.id,
          actor,
          candidatesJson: encodeJson(input.candidates),
          targetBasesJson: encodeJson(input.targetBases),
          status: 'AUTHORIZED',
        },
      });
      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'SLICE_INTEGRATION_AUTHORIZED',
          payloadJson: encodeJson({
            approvalId: approval.id,
            actor,
            candidates: input.candidates,
            targetBases: input.targetBases,
          }),
        },
      });
      return approval;
    });
  }

  async integrateWorkItem(input: IntegrateWorkItemInput) {
    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    if (!['APPROVED', 'CLOSED'].includes(item.state)) {
      fail('INTEGRATION_STATE_INVALID');
    }
    if (item.state !== 'CLOSED') {
      await this.requireActiveExecutionFence(item.id, input.executionFence);
    }
    await this.requireManagedAuthorization(item.id);
    const approval = await this.db.workItemIntegrationApproval.findFirst({
      where: { workItemId: item.id, status: { in: ['AUTHORIZED', 'IN_PROGRESS'] } },
      orderBy: { createdAt: 'desc' },
    });
    if (!approval) {
      fail('INTEGRATION_APPROVAL_REQUIRED');
    }
    const currentApproval = approval as NonNullable<typeof approval>;
    const candidates = decodeJson<Record<string, string>>(
      currentApproval.candidatesJson,
      {},
    );
    const targetBases = decodeJson<Record<string, string>>(
      currentApproval.targetBasesJson,
      {},
    );

    // A process can stop after the Git fast-forward and before the ledger
    // transaction. Reconcile that checkpoint before attempting another merge.
    if (currentApproval.status === 'IN_PROGRESS' && item.state === 'CLOSED') {
      await this.consumeIntegrationApproval(item, currentApproval.id, []);
      const cleanup = await this.cleanupWorkItem(input);
      return { item, integrated: Object.keys(candidates), cleanup };
    }

    const lease = await this.requireActiveExecutionFence(item.id, input.executionFence);
    const workspaces = await this.db.workItemWorkspace.findMany({
      where: { leaseId: lease.id, status: 'ACTIVE' },
      include: { repository: true },
      orderBy: { repository: { key: 'asc' } },
    });
    if (!workspaces.length) {
      fail('WORKTREE_NOT_FOUND');
    }

    const workspaceGit = this.workspaceGit();
    if (currentApproval.status === 'IN_PROGRESS') {
      const progress = await Promise.all(workspaces.map(async (workspace) => ({
        repositoryKey: workspace.repository.key,
        targetSha: (await this.git.capture(workspace.repository.path)).sha,
        candidateSha: candidates[workspace.repository.key],
        targetBaseSha: targetBases[workspace.repository.key],
      })));
      const allAtBase = progress.every((entry) => entry.targetSha === entry.targetBaseSha);
      const allAtCandidate = progress.every((entry) => entry.targetSha === entry.candidateSha);
      if (allAtCandidate) {
        const closed = await this.transitionWorkItem({
          projectKey: input.projectKey,
          featureKey: input.featureKey,
          itemKey: input.itemKey,
          to: 'CLOSED',
          commitSha: progress[0]?.candidateSha,
          integrationApprovalId: currentApproval.id,
          reason: 'Integração fast-forward retomada após checkpoint.',
          executionFence: input.executionFence,
        });
        await this.consumeIntegrationApproval(item, currentApproval.id, progress.map((entry) => ({
          repositoryKey: entry.repositoryKey,
          candidateSha: entry.candidateSha,
          targetBaseSha: entry.targetBaseSha,
        })));
        const cleanup = await this.cleanupWorkItem(input);
        return { item: closed, integrated: progress.map((entry) => entry.repositoryKey), cleanup };
      }
      if (!allAtBase) {
        await this.markIntegrationFailure(item, currentApproval.id, [], 'INTEGRATION_RECOVERY_REQUIRED');
        fail('INTEGRATION_RECOVERY_REQUIRED');
      }
      fail('INTEGRATION_ALREADY_IN_PROGRESS');
    }

    const scope = decodeWorkItemScope(item.scopeJson);
    if (!scope) {
      fail('WORKTREE_SCOPE_REQUIRED');
    }
    const declaredScope = scope as NonNullable<typeof scope>;
    const preflight: Array<{ repositoryKey: string; candidateSha: string; targetBaseSha: string }> = [];
    for (const workspace of workspaces) {
      const target = await this.git.capture(workspace.repository.path);
      const worktree = await this.git.capture(workspace.path);
      const candidateSha = await workspaceGit.getHead(workspace.path);
      if (
        target.dirty ||
        (workspace.repository.expectedBranch && target.branch !== workspace.repository.expectedBranch) ||
        target.sha !== targetBases[workspace.repository.key] ||
        worktree.dirty ||
        worktree.branch !== workspace.branch ||
        candidateSha !== candidates[workspace.repository.key]
      ) {
        await this.invalidateIntegrationApproval(item, currentApproval.id, 'INTEGRATION_CANDIDATE_STALE');
        fail('INTEGRATION_CANDIDATE_STALE');
      }
      const changedFiles = await workspaceGit.diffFiles(
        workspace.repository.path,
        targetBases[workspace.repository.key],
        candidateSha,
      );
      assertCandidateFilesInScope(declaredScope, workspace.repository.key, changedFiles);
      preflight.push({
        repositoryKey: workspace.repository.key,
        candidateSha,
        targetBaseSha: target.sha,
      });
    }

    const closeReason = 'Integração fast-forward aprovada e concluída.';
    const closeContext = await this.getTransitionContext(item, {
      to: 'CLOSED',
      commitSha: preflight[0]?.candidateSha,
      reason: closeReason,
    });
    this.stateMachine.assertTransition('APPROVED', 'CLOSED', {
      ...closeContext,
      commitSha: preflight[0]?.candidateSha,
    });
    await this.markIntegrationInProgress(item, currentApproval.id, preflight);

    const integrated: string[] = [];
    try {
      for (const workspace of workspaces) {
        await workspaceGit.fastForward(workspace.repository.path, workspace.branch);
        integrated.push(workspace.repository.key);
      }
    } catch (error) {
      await this.markIntegrationFailure(
        item,
        currentApproval.id,
        integrated,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }

    let closed;
    try {
      closed = await this.transitionWorkItem({
        projectKey: input.projectKey,
        featureKey: input.featureKey,
        itemKey: input.itemKey,
        to: 'CLOSED',
        commitSha: preflight[0]?.candidateSha,
        integrationApprovalId: currentApproval.id,
        reason: closeReason,
        executionFence: input.executionFence,
      });
    } catch (error) {
      await this.db.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'SLICE_INTEGRATION_COMPLETION_FAILED',
          payloadJson: encodeJson({
            approvalId: currentApproval.id,
            integrated,
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      });
      throw error;
    }
    await this.consumeIntegrationApproval(item, currentApproval.id, preflight);
    const cleanup = await this.cleanupWorkItem(input);
    return { item: closed, integrated, cleanup };
  }

  async cleanupWorkItem(input: CleanupWorkItemInput) {
    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    const allWorkspaces = await this.db.workItemWorkspace.findMany({
      where: { workItemId: item.id, status: { in: ['ACTIVE', 'PROVISIONING', 'ABANDONED', 'CLEANUP_FAILED'] } },
      include: { repository: true },
      orderBy: { createdAt: 'asc' },
    });
    if (
      item.state !== 'CLOSED' &&
      allWorkspaces.some((workspace) => ['ACTIVE', 'PROVISIONING'].includes(workspace.status))
    ) {
      fail('WORKTREE_CLEANUP_STATE_INVALID');
    }
    const workspaces = item.state === 'CLOSED'
      ? allWorkspaces
      : allWorkspaces.filter((workspace) => !['ACTIVE', 'PROVISIONING'].includes(workspace.status));
    if (!workspaces.length) {
      return [];
    }
    const workspaceGit = this.workspaceGit();
    const results: Array<{ id: string; status: string; error?: string }> = [];
    for (const workspace of workspaces) {
      try {
        await workspaceGit.removeWorktree(workspace.repository.path, workspace.path);
        await workspaceGit.deleteBranch(workspace.repository.path, workspace.branch);
        await this.db.workItemWorkspace.update({
          where: { id: workspace.id },
          data: { status: 'REMOVED', removedAt: new Date(), cleanupError: null },
        });
        results.push({ id: workspace.id, status: 'REMOVED' });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.db.workItemWorkspace.update({
          where: { id: workspace.id },
          data: { status: 'CLEANUP_FAILED', cleanupError: message },
        });
        results.push({ id: workspace.id, status: 'CLEANUP_FAILED', error: message });
      }
    }
    if (results.length) {
      await this.db.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'SLICE_WORKTREES_CLEANED',
          payloadJson: encodeJson({ results }),
        },
      });
    }
    return results;
  }

  async getExecutionRepositoryPath(input: {
    projectKey: string;
    featureKey: string;
    itemKey: string;
    repositoryKey: string;
  }): Promise<string> {
    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    const repository = await this.db.repository.findFirst({
      where: { projectId: item.feature.projectId, key: input.repositoryKey },
    });
    if (!repository) {
      fail('REPOSITORY_NOT_FOUND');
    }
    const authorization = await this.db.authorization.findFirst({
      where: { workItemId: item.id },
      orderBy: { createdAt: 'desc' },
    });
    if (authorization?.executionMode !== 'MANAGED_WORKTREE') {
      return (repository as NonNullable<typeof repository>).path;
    }
    const lease = await this.requireActiveLease(item.id);
    const workspace = await this.db.workItemWorkspace.findFirst({
      where: {
        leaseId: lease.id,
        repositoryId: (repository as NonNullable<typeof repository>).id,
        status: 'ACTIVE',
      },
    });
    if (!workspace) {
      fail('WORKTREE_NOT_FOUND');
    }
    return (workspace as NonNullable<typeof workspace>).path;
  }

  private async getExecutionRepositoryPathById(
    itemId: string,
    repositoryId: string,
    fallbackPath: string,
  ): Promise<string> {
    const authorization = await this.db.authorization.findFirst({
      where: { workItemId: itemId },
      orderBy: { createdAt: 'desc' },
    });
    if (authorization?.executionMode !== 'MANAGED_WORKTREE') {
      return fallbackPath;
    }
    const lease = await this.db.workItemLease.findFirst({
      where: { workItemId: itemId, releasedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { acquiredAt: 'desc' },
    });
    if (!lease) {
      return fallbackPath;
    }
    const workspace = await this.db.workItemWorkspace.findFirst({
      where: { leaseId: lease.id, repositoryId, status: 'ACTIVE' },
    });
    return workspace?.path ?? fallbackPath;
  }

  private async requireManagedAuthorization(itemId: string) {
    const authorization = await this.db.authorization.findFirst({
      where: { workItemId: itemId },
      orderBy: { createdAt: 'desc' },
    });
    if (!authorization || authorization.executionMode !== 'MANAGED_WORKTREE') {
      fail('MANAGED_WORKTREE_REQUIRED');
    }
    return authorization as NonNullable<typeof authorization>;
  }

  private async requireActiveLease(itemId: string) {
    const lease = await this.db.workItemLease.findFirst({
      where: { workItemId: itemId, releasedAt: null },
      orderBy: { acquiredAt: 'desc' },
    });
    if (!lease) {
      fail('SLICE_RESERVATION_NOT_FOUND');
    }
    if ((lease as NonNullable<typeof lease>).expiresAt <= new Date()) {
      fail('SLICE_RESERVATION_EXPIRED');
    }
    return lease as NonNullable<typeof lease>;
  }

  private async invalidateIntegrationApproval(
    item: WorkItemWithFeature,
    approvalId: string,
    reason: string,
  ) {
    await this.db.$transaction(async (transaction) => {
      await transaction.workItemIntegrationApproval.update({
        where: { id: approvalId },
        data: { status: 'INVALIDATED' },
      });
      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'SLICE_INTEGRATION_INVALIDATED',
          payloadJson: encodeJson({ approvalId, reason }),
        },
      });
    });
  }

  private async markIntegrationInProgress(
    item: WorkItemWithFeature,
    approvalId: string,
    preflight: Array<{ repositoryKey: string; candidateSha: string; targetBaseSha: string }>,
  ): Promise<void> {
    await this.db.$transaction(async (transaction) => {
      await this.lockProjectForWrite(transaction, item.feature.projectId);
      const updated = await transaction.workItemIntegrationApproval.updateMany({
        where: { id: approvalId, status: 'AUTHORIZED' },
        data: { status: 'IN_PROGRESS' },
      });
      if (updated.count !== 1) {
        const current = await transaction.workItemIntegrationApproval.findUnique({ where: { id: approvalId } });
        if (current?.status === 'IN_PROGRESS') {
          fail('INTEGRATION_ALREADY_IN_PROGRESS');
        }
        fail('INTEGRATION_APPROVAL_STALE');
      }
      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'SLICE_INTEGRATION_STARTED',
          payloadJson: encodeJson({ approvalId, preflight }),
        },
      });
    });
  }

  private async markIntegrationFailure(
    item: WorkItemWithFeature,
    approvalId: string,
    integrated: string[],
    reason: string,
  ): Promise<void> {
    await this.db.$transaction(async (transaction) => {
      await this.lockProjectForWrite(transaction, item.feature.projectId);
      await transaction.workItemIntegrationApproval.updateMany({
        where: { id: approvalId, status: 'IN_PROGRESS' },
        data: { status: integrated.length ? 'PARTIAL' : 'FAILED' },
      });
      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: integrated.length ? 'SLICE_INTEGRATION_PARTIAL' : 'SLICE_INTEGRATION_FAILED',
          payloadJson: encodeJson({ approvalId, integrated, reason }),
        },
      });
    });
  }

  private async consumeIntegrationApproval(
    item: WorkItemWithFeature,
    approvalId: string,
    preflight: Array<{ repositoryKey: string; candidateSha?: string; targetBaseSha?: string }>,
  ): Promise<void> {
    await this.db.$transaction(async (transaction) => {
      await this.lockProjectForWrite(transaction, item.feature.projectId);
      const approval = await transaction.workItemIntegrationApproval.findUnique({ where: { id: approvalId } });
      if (!approval) {
        fail('INTEGRATION_APPROVAL_REQUIRED');
      }
      if ((approval as NonNullable<typeof approval>).status === 'CONSUMED') {
        return;
      }
      if ((approval as NonNullable<typeof approval>).status !== 'IN_PROGRESS') {
        fail('INTEGRATION_APPROVAL_STALE');
      }
      await transaction.workItemIntegrationApproval.update({
        where: { id: approvalId },
        data: { status: 'CONSUMED', consumedAt: new Date() },
      });
      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'SLICE_INTEGRATED',
          payloadJson: encodeJson({ approvalId, preflight }),
        },
      });
    });
  }

  private async invalidateGreenForManagedChange(
    item: WorkItemWithFeature,
    leaseId: string,
    reason: string,
    details: Record<string, unknown>,
  ): Promise<void> {
    await this.db.$transaction(async (transaction) => {
      await this.lockProjectForWrite(transaction, item.feature.projectId);
      const current = await transaction.workItem.findUnique({ where: { id: item.id } });
      if (!current || !['GREEN_CONFIRMED', 'READY_FOR_REVIEW', 'APPROVED'].includes(current.state)) {
        return;
      }
      await transaction.workItem.update({
        where: { id: item.id },
        data: { state: 'IMPLEMENTING' },
      });
      await transaction.workItemWorkspace.updateMany({
        where: { leaseId, status: 'ACTIVE' },
        data: { candidateSha: null, targetBaseSha: null },
      });
      await transaction.workItemIntegrationApproval.updateMany({
        where: { workItemId: item.id, status: { in: ['AUTHORIZED', 'IN_PROGRESS'] } },
        data: { status: 'INVALIDATED' },
      });
      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'GREEN_INVALIDATED',
          payloadJson: encodeJson({
            from: current.state,
            to: 'IMPLEMENTING',
            reason,
            leaseId,
            ...details,
          }),
        },
      });
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

    const capabilities = normalizeCatalogValues(
      input.capabilities ?? [],
      validationCapabilityValues,
      'VALIDATION_CAPABILITY_INVALID',
    );

    return this.db.validationProfile.create({
      data: {
        repositoryId: (repository as NonNullable<typeof repository>).id,
        key: input.key,
        program: input.program,
        argsJson: encodeJson(input.args),
        cwd,
        parser: input.parser,
        capabilitiesJson: encodeJson(capabilities),
        timeoutSeconds: input.timeoutSeconds ?? 60,
        maxOutputBytes: input.maxOutputBytes ?? 2_000_000,
      },
    });
  }

  async recordValidation(input: RecordValidationInput) {
    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    await this.requireActiveExecutionFence(item.id, input.executionFence);
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

    return this.db.$transaction(async (transaction) => {
      await this.lockProjectForWrite(transaction, item.feature.projectId);
      await this.requireActiveExecutionFence(item.id, input.executionFence, transaction);
      return transaction.validationRun.create({
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
    });
  }

  async confirmStructuralRed(input: ConfirmStructuralRedInput) {
    if (!input.reason.trim()) {
      fail('STRUCTURAL_RED_REASON_REQUIRED');
    }

    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    await this.requireActiveExecutionFence(item.id, input.executionFence);
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
      executionFence: input.executionFence,
    });
  }

  async invalidateGreen(input: InvalidateGreenInput) {
    if (!input.reason.trim()) {
      fail('GREEN_INVALIDATION_REASON_REQUIRED');
    }

    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    await this.requireActiveExecutionFence(item.id, input.executionFence);
    if (!['GREEN_CONFIRMED', 'READY_FOR_REVIEW', 'APPROVED'].includes(item.state)) {
      fail('GREEN_INVALIDATION_STATE_INVALID');
    }

    const greenContext = await this.getGreenEvidenceContext(item, true);
    if (!greenContext.greenEvidence) {
      fail('GREEN_EVIDENCE_NOT_FOUND');
    }

    return this.db.$transaction(async (transaction) => {
      await this.lockProjectForWrite(transaction, item.feature.projectId);
      await this.requireActiveExecutionFence(item.id, input.executionFence, transaction);
      const latestGreen = await transaction.validationRun.findFirst({
        where: { workItemId: item.id, purpose: 'GREEN' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
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
            invalidatedThroughValidationId: latestGreen?.id,
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
    await this.requireActiveExecutionFence(item.id, input.executionFence);

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
      await this.lockProjectForWrite(transaction, item.feature.projectId);
      await this.requireActiveExecutionFence(item.id, input.executionFence, transaction);
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
    const requiresExecutionFence = this.transitionRequiresExecutionFence(from, to);
    if (requiresExecutionFence) {
      await this.requireActiveExecutionFence(item.id, input.executionFence);
    }
    if (to === 'CLOSED') {
      const authorization = await this.db.authorization.findFirst({
        where: { workItemId: item.id },
        orderBy: { createdAt: 'desc' },
      });
      if (authorization?.executionMode === 'MANAGED_WORKTREE') {
        const integrationApproval = await this.db.workItemIntegrationApproval.findFirst({
          where: { workItemId: item.id, status: { in: ['AUTHORIZED', 'IN_PROGRESS'] } },
          orderBy: { createdAt: 'desc' },
        });
        if (!integrationApproval) {
          fail('INTEGRATION_APPROVAL_REQUIRED');
        }
        const authorizedApproval = integrationApproval as NonNullable<typeof integrationApproval>;
        if (input.integrationApprovalId !== authorizedApproval.id) {
          fail('MANAGED_WORKTREE_INTEGRATION_REQUIRED');
        }
      }
    }
    const context = await this.getTransitionContext(item, input);

    this.stateMachine.assertTransition(from, to, context);

    return this.db.$transaction(async (transaction) => {
      await this.lockProjectForWrite(transaction, item.feature.projectId);
      if (requiresExecutionFence) {
        await this.requireActiveExecutionFence(item.id, input.executionFence, transaction);
      }
      const updateResult = await transaction.workItem.updateMany({
        where: { id: item.id, state: from },
        data: {
          state: to,
          ...(to === 'CLOSED' && input.commitSha
            ? { currentSha: input.commitSha }
            : {}),
        },
      });
      if (updateResult.count !== 1) {
        fail('WORK_ITEM_STATE_CHANGED_CONCURRENTLY');
      }
      const updated = await transaction.workItem.findUnique({ where: { id: item.id } });
      if (!updated) {
        fail('WORK_ITEM_NOT_FOUND');
      }
      const currentUpdated = updated as NonNullable<typeof updated>;

      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: 'ITEM_TRANSITIONED',
          payloadJson: encodeJson({ from, to, reason: input.reason, commitSha: input.commitSha }),
        },
      });

      if (to === 'CLOSED' || to === 'BLOCKED') {
        if (to === 'BLOCKED') {
          await transaction.workItemWorkspace.updateMany({
            where: { workItemId: item.id, status: 'ACTIVE' },
            data: { status: 'ABANDONED' },
          });
        }
        const released = await transaction.workItemLease.updateMany({
          where: { workItemId: item.id, releasedAt: null },
          data: {
            releasedAt: new Date(),
            endReason: to === 'CLOSED' ? 'ITEM_CLOSED' : 'ITEM_BLOCKED',
          },
        });
        if (released.count > 0) {
          await transaction.workflowEvent.create({
            data: {
              projectId: item.feature.projectId,
              featureId: item.featureId,
              workItemId: item.id,
              type: 'SLICE_LEASE_RELEASED',
              payloadJson: encodeJson({ reason: to === 'CLOSED' ? 'ITEM_CLOSED' : 'ITEM_BLOCKED' }),
            },
          });
        }
      }

      return currentUpdated;
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
      dependencies,
      activeLease,
      latestIntegrationApproval,
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
        this.db.workItemDependency.findMany({
          where: { workItemId: item.id },
          include: { dependsOnItem: { include: { feature: true } } },
          orderBy: { createdAt: 'asc' },
        }),
        this.db.workItemLease.findFirst({
          where: { workItemId: item.id, releasedAt: null },
          include: { workspaces: { include: { repository: true }, orderBy: { createdAt: 'asc' } } },
          orderBy: { acquiredAt: 'desc' },
        }),
        this.db.workItemIntegrationApproval.findFirst({
          where: { workItemId: item.id },
          orderBy: { createdAt: 'desc' },
        }),
      ]);

    const latestValidations = ['RED', 'GREEN', 'CHECK']
      .map((purpose) => validations.find((validation) => validation.purpose === purpose))
      .filter((validation): validation is NonNullable<typeof validation> => Boolean(validation));
    const reviewEventPayload = latestReviewEvent
      ? decodeJson<{ reviewMode?: 'SELF' | 'INDEPENDENT' }>(latestReviewEvent.payloadJson, {})
      : {};
    const currentClose = findClosedTransition(currentEvents);

    const context = buildWorkflowContext(
      {
        current: {
          projectKey: input.projectKey,
          featureKey: item.feature.key,
          phaseKey: item.phaseKey,
          itemKey: item.key,
          taskType: item.taskType === 'PATCH' ? 'PATCH' : 'FEATURE',
          state: item.state,
          nextAllowedTransition: this.nextAllowedTransition(
            item.state as WorkItemState,
            item.taskType === 'PATCH' ? 'PATCH' : 'FEATURE',
          ),
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
              executionMode: authorization.executionMode,
              scope: decodeWorkItemScope(item.scopeJson),
            }
          : undefined,
        lineage: {
          parent: lineage?.parentItem ?? undefined,
          children: lineage?.childItems ?? [],
        },
        dependencies: dependencies.map((dependency) => ({
          featureKey: dependency.dependsOnItem.feature.key,
          itemKey: dependency.dependsOnItem.key,
          title: dependency.dependsOnItem.title,
          state: dependency.dependsOnItem.state,
        })),
        execution: {
          lease: activeLease
            ? {
                id: activeLease.id,
                holder: activeLease.holder,
                expiresAt: activeLease.expiresAt.toISOString(),
              }
            : undefined,
          workspaces: activeLease?.workspaces.map((workspace) => ({
            repository: workspace.repository.key,
            path: workspace.path,
            branch: workspace.branch,
            baseSha: workspace.baseSha,
            targetBaseSha: workspace.targetBaseSha ?? undefined,
            candidateSha: workspace.candidateSha ?? undefined,
            status: workspace.status,
            cleanupError: workspace.cleanupError,
          })) ?? [],
          integrationApproval: latestIntegrationApproval
            ? {
                id: latestIntegrationApproval.id,
                actor: latestIntegrationApproval.actor,
                status: latestIntegrationApproval.status,
                candidates: decodeJson(latestIntegrationApproval.candidatesJson, {}),
                targetBases: decodeJson(latestIntegrationApproval.targetBasesJson, {}),
              }
            : undefined,
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

    return {
      ...context,
      riskTags: decodeJson(item.riskTagsJson, []),
    } as WorkflowContext & { riskTags: string[] };
  }

  async getRecord(input: RecordRequest) {
    const item = await this.requireItem(input.projectKey, input.featureKey, input.itemKey);
    const [useCases, criteria, tests, authorization, snapshots, validations, reviews, decisions, pendingItems, lineage, dependencies, workspaces, integrationApprovals] =
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
        this.db.workItemDependency.findMany({
          where: { workItemId: item.id },
          include: { dependsOnItem: { include: { feature: true } } },
          orderBy: { createdAt: 'asc' },
        }),
        this.db.workItemWorkspace.findMany({
          where: { workItemId: item.id },
          include: { repository: true },
          orderBy: { createdAt: 'asc' },
        }),
        this.db.workItemIntegrationApproval.findMany({
          where: { workItemId: item.id },
          orderBy: { createdAt: 'desc' },
        }),
      ]);

    return {
      item: {
        key: item.key,
        title: item.title,
        phaseKey: item.phaseKey,
        kind: item.kind,
        taskType: item.taskType === 'PATCH' ? 'PATCH' : 'FEATURE',
        state: item.state,
        summary: item.summary,
        tddPolicy: item.tddPolicy,
        currentSha: item.currentSha,
        requirementsComplete: item.requirementsComplete,
        riskTags: decodeJson(item.riskTagsJson, []),
        scope: decodeWorkItemScope(item.scopeJson),
      },
      riskTags: decodeJson(item.riskTagsJson, []),
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
            executionMode: authorization.executionMode,
            scope: decodeWorkItemScope(item.scopeJson),
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
      dependencies: dependencies.map((dependency) => ({
        featureKey: dependency.dependsOnItem.feature.key,
        itemKey: dependency.dependsOnItem.key,
        title: dependency.dependsOnItem.title,
        state: dependency.dependsOnItem.state,
      })),
      workspaces: workspaces.map((workspace) => ({
        id: workspace.id,
        repository: workspace.repository.key,
        path: workspace.path,
        branch: workspace.branch,
        baseSha: workspace.baseSha,
        targetBaseSha: workspace.targetBaseSha,
        candidateSha: workspace.candidateSha,
        status: workspace.status,
        cleanupError: workspace.cleanupError,
      })),
      integrationApprovals: integrationApprovals.map((approval) => ({
        id: approval.id,
        actor: approval.actor,
        status: approval.status,
        candidates: decodeJson(approval.candidatesJson, {}),
        targetBases: decodeJson(approval.targetBasesJson, {}),
        createdAt: approval.createdAt,
        consumedAt: approval.consumedAt,
      })),
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

  async listFeatures(input: string | ListFeaturesInput) {
    const request: ListFeaturesInput = typeof input === 'string'
      ? { projectKey: input }
      : input;
    const includeItems = request.includeItems ?? true;
    const project = await this.requireProject(request.projectKey);
    const features = await this.db.feature.findMany({
      where: {
        projectId: project.id,
        ...(request.featureKey ? { key: request.featureKey } : {}),
        ...(request.taskType ? { taskType: request.taskType } : {}),
      },
      orderBy: { key: 'asc' },
      select: {
        key: true,
        name: true,
        summary: true,
        taskType: true,
        status: true,
        currentPhaseKey: true,
        items: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            parentItemId: true,
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
      features: features.map((feature) => {
        const summary = {
          key: feature.key,
          name: feature.name,
          summary: feature.summary,
          taskType: feature.taskType === 'PATCH' ? 'PATCH' as const : 'FEATURE' as const,
          status: feature.status,
          currentPhaseKey: feature.currentPhaseKey,
          ...deriveFeatureExecution(feature.items),
        };
        if (!includeItems) {
          return summary;
        }

        return {
          ...summary,
          items: feature.items.map(({ id: _id, parentItemId: _parentItemId, ...item }) => ({
            ...item,
            parentItemKey: item.parentItem?.key,
          })),
        };
      }),
    };
  }

  async getReadyFrontier(input: ReadyFrontierRequest): Promise<ReadyFrontierResult> {
    const project = await this.requireProject(input.projectKey);
    const includeEmptyFeatures = input.includeEmptyFeatures ?? false;
    const includeClosedDependencies = input.includeClosedDependencies ?? false;
    const features = await this.db.feature.findMany({
      where: {
        projectId: project.id,
        ...(input.featureKey ? { key: input.featureKey } : {}),
      },
      orderBy: { key: 'asc' },
      select: {
        key: true,
        name: true,
        items: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            key: true,
            title: true,
            state: true,
            parentItemId: true,
            dependencies: {
              include: { dependsOnItem: { include: { feature: true } } },
              orderBy: { createdAt: 'asc' },
            },
            leases: {
              where: { releasedAt: null },
              orderBy: { generation: 'desc' },
              take: 1,
            },
          },
        },
      },
    });
    const now = new Date();

    const result = await Promise.all(features.map(async (feature) => {
      const parentIds = new Set(
        feature.items
          .map((item) => item.parentItemId)
          .filter((parentId): parentId is string => Boolean(parentId)),
      );
      const items: ReadyFrontierResult['features'][number]['items'] = [];

      for (const item of feature.items) {
        if (parentIds.has(item.id) || ['CLOSED', 'SUPERSEDED'].includes(item.state)) {
          continue;
        }

        const dependencies = item.dependencies.map((dependency) => ({
          featureKey: dependency.dependsOnItem.feature.key,
          itemKey: dependency.dependsOnItem.key,
          state: dependency.dependsOnItem.state,
        }));
        const pendingDependencies: typeof item.dependencies = [];
        for (const dependency of item.dependencies) {
          if (!(await this.isEffectivelyClosed(dependency.dependsOnItemId, this.db))) {
            pendingDependencies.push(dependency);
          }
        }
        const lease = item.leases[0];
        const expired = Boolean(lease && lease.expiresAt <= now);
        const leaseInfo = lease
          ? {
              holder: lease.holder,
              generation: lease.generation,
              expiresAt: lease.expiresAt.toISOString(),
              expired,
            }
          : undefined;
        const commandBase = `--project ${project.key} --feature ${feature.key} --item ${item.key}`;
        let kind: ReadyFrontierItem['kind'];
        let nextAction: string;
        let command: string;
        let recoveryCommand: string | undefined;

        if (item.state === 'BLOCKED') {
          kind = 'BLOCKED';
          nextAction = 'Reabrir após registrar uma justificativa humana.';
          command = `item reopen ${commandBase} --actor human:<identidade> --reason <motivo>`;
        } else if (pendingDependencies.length) {
          kind = 'WAITING_DEPENDENCY';
          nextAction = 'Aguardar o fechamento efetivo das dependências.';
          command = `workflow frontier --project ${project.key} --feature ${feature.key}`;
        } else if (item.state === 'DRAFT') {
          kind = 'WAITING_HUMAN';
          nextAction = 'Completar e marcar a fatia como READY.';
          command = `item transition ${commandBase} --to READY`;
        } else if (item.state === 'READY') {
          kind = 'WAITING_HUMAN';
          nextAction = 'Aguardar autorização humana da execução.';
          command = `item authorize ${commandBase} --actor human:<identidade>`;
        } else if (item.state === 'AUTHORIZED' && !lease) {
          kind = 'ACTIONABLE';
          nextAction = 'Reivindicar a fatia e obter o fence de execução.';
          command = `item claim ${commandBase} --holder agent:<identidade>`;
        } else if (expired && lease) {
          kind = 'LEASE_EXPIRED';
          nextAction = 'Recuperar a lease expirada antes de continuar.';
          command = `item recover ${commandBase} --holder agent:<identidade>`;
          recoveryCommand = `item reconcile ${commandBase}`;
        } else if (lease) {
          kind = 'LEASE_ACTIVE';
          nextAction = `Executar a próxima ação com executionFence ${lease.generation}.`;
          command = `item renew ${commandBase} --holder ${lease.holder} --fence ${lease.generation}`;
          recoveryCommand = `item release ${commandBase} --holder ${lease.holder} --fence ${lease.generation}`;
        } else {
          kind = 'LEASE_REQUIRED';
          nextAction = 'Reivindicar a fatia antes de executar qualquer mutação.';
          command = `item claim ${commandBase} --holder agent:<identidade>`;
        }

        const visibleDependencies = includeClosedDependencies
          ? dependencies
          : dependencies.filter((dependency) => pendingDependencies.some((pending) => (
              pending.dependsOnItem.key === dependency.itemKey
              && pending.dependsOnItem.feature.key === dependency.featureKey
            )));

        items.push({
          featureKey: feature.key,
          itemKey: item.key,
          title: item.title,
          state: item.state,
          kind,
          nextAction,
          command,
          ...(recoveryCommand ? { recoveryCommand } : {}),
          dependencies: visibleDependencies,
          ...(leaseInfo ? { lease: leaseInfo } : {}),
        });
      }

      return { featureKey: feature.key, name: feature.name, items };
    }));

    return {
      project: project.key,
      features: result.filter((feature) => (
        feature.items.length > 0 || includeEmptyFeatures || Boolean(input.featureKey)
      )),
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
    const [items, profiles] = await Promise.all([
      this.db.workItem.findMany({
        where: { featureId: currentFeature.id },
        orderBy: { position: 'asc' },
        include: {
          useCases: { select: { key: true, trigger: true, expectedOutcome: true } },
          criteria: {
            where: { required: true },
            select: {
              key: true,
              evidenceKind: true,
              polarity: true,
              useCase: { select: { key: true } },
            },
          },
          tests: {
            select: {
              key: true,
              runnerProfileKey: true,
              criterion: { select: { key: true } },
            },
          },
          snapshots: { select: { repositoryId: true } },
          parentItem: { select: { key: true } },
        },
      }),
      this.db.validationProfile.findMany({
        where: {
          active: true,
          repository: { projectId: currentFeature.projectId },
        },
        select: { key: true, capabilitiesJson: true },
        orderBy: { key: 'asc' },
      }),
    ]);
    const validationProfiles = profiles.map((profile) => ({
      key: profile.key,
      capabilities: decodeJson<string[]>(profile.capabilitiesJson, []),
    }));

    const auditedItems = items.map((item) => {
      const scope = decodeWorkItemScope(item.scopeJson);
      const scopeIssues = scope ? validateWorkItemScope(scope).map((issue) => issue.message) : [];
      const repositoryCount = scope
        ? scope.repositories.length
        : new Set(item.snapshots.map((snapshot) => snapshot.repositoryId)).size;
      const itemRiskTags = decodeJson<string[]>(item.riskTagsJson, []);
      const requiresUiContract = item.kind === 'CODE' && (
        isFrontendUiScope(scope)
        || itemRiskTags.some((tag) => tag === 'FRONTEND' || tag === 'VISUAL_ONLY')
      );
      const semantic = currentFeature.taskType === 'PATCH'
        && item.useCases.length === 0
        && !requiresUiContract
        ? { status: 'OK' as const, issues: [] }
        : assessPlanSemantics({
            useCases: item.useCases,
            criteria: item.criteria.map((criterion) => ({
              key: criterion.key,
              useCaseKey: criterion.useCase?.key,
              evidenceKind: criterion.evidenceKind,
              polarity: criterion.polarity,
            })),
            tests: item.tests.map((test) => ({
              key: test.key,
              criterionKey: test.criterion?.key,
            })),
            requiresTests: item.kind === 'CODE' && item.tddPolicy === 'REQUIRED',
          });
      const validation = assessValidationCoverage({
        riskTags: itemRiskTags,
        tests: item.tests,
        profiles: validationProfiles,
      });
      const assessment = currentFeature.taskType === 'PATCH'
        ? {
            status: 'OK' as const,
            score: 0,
            metrics: {
              useCases: item.useCases.length,
              requiredCriteria: item.criteria.length,
              tests: item.tests.length,
              repositories: repositoryCount,
            },
            violations: [],
            suggestions: [],
          }
        : assessSliceSize({
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
        scope,
        scopeIssues,
        semanticStatus: semantic.status,
        semanticIssues: semantic.issues,
        metrics: assessment.metrics,
        status: assessment.status,
        score: assessment.score,
        violations: assessment.violations,
        suggestions: assessment.suggestions,
        repositoryScope: scope
          ? 'DECLARED' as const
          : repositoryCount > 0
            ? 'CAPTURED' as const
            : 'UNKNOWN' as const,
        riskTags: validation.riskTags,
        requiredCapabilities: validation.requiredCapabilities,
        coveredCapabilities: validation.coveredCapabilities,
        missingCapabilities: validation.missingCapabilities,
        unknownRiskTags: validation.unknownRiskTags,
        missingProfileKeys: validation.missingProfileKeys,
        validationStatus: validation.status,
      };
    });

    return {
      project: project.key,
      feature: {
        key: currentFeature.key,
        name: currentFeature.name,
        summary: currentFeature.summary,
        taskType: currentFeature.taskType === 'PATCH' ? 'PATCH' : 'FEATURE',
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

    const sizeStatus = (assessment as NonNullable<typeof assessment>).status;
    const semanticStatus = (assessment as NonNullable<typeof assessment>).semanticStatus;
    const semanticReplan = sizeStatus === 'OK' && semanticStatus === 'BLOCKED';

    if (sizeStatus === 'OK' && !semanticReplan) {
      fail('SLICE_REPLAN_NOT_REQUIRED');
    }

    this.stateMachine.assertTransition('DRAFT', 'SUPERSEDED', {
      replanReason: input.reason,
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
        data: { state: 'SUPERSEDED' },
      });

      await transaction.workflowEvent.create({
        data: {
          projectId: item.feature.projectId,
          featureId: item.featureId,
          workItemId: item.id,
          type: semanticReplan ? 'SLICE_SEMANTIC_REPLANNED' : 'SLICE_SIZE_REPLANNED',
          payloadJson: encodeJson({
            actor: input.actor.trim(),
            reason: input.reason.trim(),
            status: sizeStatus,
            semanticStatus,
            requestKey,
          }),
        },
      });

      return { assessment, item: updated, pending: resolvedPending };
    });
  }

  private async isEffectivelyClosed(
    itemId: string,
    executor: LedgerExecutor,
    visited = new Set<string>(),
  ): Promise<boolean> {
    if (visited.has(itemId)) {
      return false;
    }

    visited.add(itemId);
    const item = await executor.workItem.findUnique({
      where: { id: itemId },
      select: {
        state: true,
        childItems: { select: { id: true } },
      },
    });
    if (!item) {
      return false;
    }

    if (item.state === 'CLOSED') {
      return true;
    }

    if (item.state !== 'SUPERSEDED' || item.childItems.length === 0) {
      return false;
    }

    for (const child of item.childItems) {
      if (!(await this.isEffectivelyClosed(child.id, executor, visited))) {
        return false;
      }
    }

    return true;
  }

  async listRepositories(input: string | ListRepositoriesInput) {
    const request: ListRepositoriesInput = typeof input === 'string'
      ? { projectKey: input }
      : input;
    const includeProfiles = request.includeProfiles ?? true;
    const project = await this.requireProject(request.projectKey);
    const repositories = await this.db.repository.findMany({
      where: {
        projectId: project.id,
        ...(request.repositoryKey ? { key: request.repositoryKey } : {}),
      },
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
      repositories: repositories.map((repository) => {
        const summary = {
          key: repository.key,
          path: repository.path,
          expectedBranch: repository.expectedBranch,
          profileCount: repository.validationProfiles.length,
          profileKeys: repository.validationProfiles.map((profile) => profile.key),
        };
        if (!includeProfiles) {
          return summary;
        }

        return {
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
        };
      }),
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

  async listDecisions(input: string | ListDecisionsInput) {
    const request: ListDecisionsInput = typeof input === 'string'
      ? { projectKey: input }
      : input;
    const includeContent = request.includeContent ?? true;
    const project = await this.requireProject(request.projectKey);
    if (request.itemKey && !request.featureKey) {
      fail('ITEM_REQUIRES_FEATURE');
    }
    const decisions = await this.db.decision.findMany({
      where: {
        projectId: project.id,
        ...(request.key ? { key: request.key } : {}),
        ...(request.featureKey ? { feature: { key: request.featureKey } } : {}),
        ...(request.itemKey ? { workItem: { key: request.itemKey } } : {}),
      },
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
        ...(includeContent ? { content: decision.content } : {}),
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

  async listPendingItems(input: string | ListPendingItemsInput) {
    const request: ListPendingItemsInput = typeof input === 'string'
      ? { projectKey: input }
      : input;
    const project = await this.requireProject(request.projectKey);
    if (request.itemKey && !request.featureKey) {
      fail('ITEM_REQUIRES_FEATURE');
    }
    const pendingItems = await this.db.pendingItem.findMany({
      where: {
        projectId: project.id,
        ...(request.featureKey ? { feature: { key: request.featureKey } } : {}),
        ...(request.itemKey ? { workItem: { key: request.itemKey } } : {}),
        ...(request.resolution && request.resolution !== 'ALL'
          ? { resolved: request.resolution === 'RESOLVED' }
          : {}),
      },
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
    const [authorization, tests, red, review, greenContext, sliceSizeContext, validationContext] = await Promise.all([
      this.db.authorization.findFirst({
        where: { workItemId: item.id },
        orderBy: { createdAt: 'desc' },
      }),
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
      this.getValidationTransitionContext(item, input.to as WorkItemState),
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
      ? await this.git.capture(await this.getExecutionRepositoryPathById(
        item.id,
        redEvidence.profile.repository.id,
        redEvidence.profile.repository.path,
      ))
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
      taskType: item.taskType === 'PATCH' ? 'PATCH' : 'FEATURE',
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
      validationPlanComplete: validationContext.validationPlanComplete,
      validationEvidenceComplete: validationContext.validationEvidenceComplete,
      riskContractStable: validationContext.riskContractStable,
    };
  }

  private async getValidationTransitionContext(
    item: WorkItemWithFeature,
    target: WorkItemState,
  ): Promise<{
    validationPlanComplete: boolean;
    validationEvidenceComplete: boolean;
    riskContractStable: boolean;
  }> {
    const riskTags = decodeJson<string[]>(item.riskTagsJson, []);
    const requirements = deriveValidationRequirements(riskTags);
    const hasRiskContract = riskTags.length > 0 || requirements.unknownRiskTags.length > 0;
    let validationPlanComplete = true;

    if (hasRiskContract) {
      const project = await this.db.project.findUnique({ where: { id: item.feature.projectId } });
      if (!project) {
        fail('PROJECT_NOT_FOUND');
      }

      const plan = await this.checkPlan({
        projectKey: (project as NonNullable<typeof project>).key,
        featureKey: item.feature.key,
      });
      const auditedItem = plan.items.find((candidate) => candidate.key === item.key);
      validationPlanComplete = Boolean(
        auditedItem &&
        auditedItem.semanticStatus === 'OK' &&
        auditedItem.validationStatus === 'OK',
      );
    }

    const requiresValidationEvidence = [
      'GREEN_CONFIRMED',
      'READY_FOR_REVIEW',
    ].includes(target);
    const validationEvidenceComplete = !requiresValidationEvidence || !hasRiskContract
      ? true
      : (await this.getRequiredCapabilityEvidence(item)).complete;

    const authorizationEvent = await this.db.workflowEvent.findFirst({
      where: { workItemId: item.id, type: 'ITEM_AUTHORIZED' },
      orderBy: { createdAt: 'desc' },
    });
    const authorizationPayload = authorizationEvent
      ? decodeJson<{ riskTags?: string[]; requiredCapabilities?: string[] }>(
          authorizationEvent.payloadJson,
          {},
        )
      : {};
    const riskContractStable = !authorizationEvent || !authorizationPayload.riskTags
      ? true
      : JSON.stringify(authorizationPayload.riskTags) === JSON.stringify(riskTags) &&
        JSON.stringify(authorizationPayload.requiredCapabilities ?? []) === JSON.stringify(
          requirements.requiredCapabilities,
        );

    return {
      validationPlanComplete,
      validationEvidenceComplete,
      riskContractStable,
    };
  }

  private async getRequiredCapabilityEvidence(item: WorkItemWithFeature): Promise<{
    complete: boolean;
    missingCapabilities: string[];
  }> {
    const requirements = deriveValidationRequirements(
      decodeJson<string[]>(item.riskTagsJson, []),
    );
    if (requirements.unknownRiskTags.length) {
      return { complete: false, missingCapabilities: requirements.requiredCapabilities };
    }
    if (!requirements.requiredCapabilities.length) {
      return { complete: true, missingCapabilities: [] };
    }

    const validations = await this.db.validationRun.findMany({
      where: {
        workItemId: item.id,
        purpose: 'GREEN',
        resultKind: 'PASS',
      },
      include: { profile: { include: { repository: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const repositories = new Map<string, { id: string; key: string; path: string }>();
    for (const validation of validations) {
      repositories.set(validation.profile.repository.id, validation.profile.repository);
    }
    const currentSnapshots = new Map<string, Awaited<ReturnType<GitReadPort['capture']>>>();
    for (const repository of repositories.values()) {
      const executionPath = await this.getExecutionRepositoryPathById(
        item.id,
        repository.id,
        repository.path,
      );
      currentSnapshots.set(repository.id, await this.git.capture(executionPath));
    }

    const coveredCapabilities = new Set<string>();
    for (const validation of validations) {
      const summary = decodeJson<{ fingerprint?: string; contentFingerprint?: string }>(
        validation.summaryJson,
        {},
      );
      const currentSnapshot = currentSnapshots.get(validation.profile.repository.id);
      if (!currentSnapshot || !matchesGreenSnapshot(summary, validation, currentSnapshot)) {
        continue;
      }

      for (const capability of decodeJson<string[]>(validation.profile.capabilitiesJson, [])) {
        coveredCapabilities.add(capability);
      }
    }

    const missingCapabilities = requirements.requiredCapabilities.filter(
      (capability) => !coveredCapabilities.has(capability),
    );
    return {
      complete: missingCapabilities.length === 0,
      missingCapabilities,
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
    const [snapshots, allValidations, lastInvalidation] = await Promise.all([
      this.db.repositorySnapshot.findMany({
        where: { workItemId: item.id },
        include: { repository: true },
        orderBy: { capturedAt: 'desc' },
      }),
      this.db.validationRun.findMany({
        where: { workItemId: item.id, purpose: 'GREEN' },
        include: { profile: { include: { repository: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.db.workflowEvent.findFirst({
        where: { workItemId: item.id, type: 'GREEN_INVALIDATED' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    const invalidationPayload = lastInvalidation
      ? decodeJson<{ invalidatedThroughValidationId?: string }>(lastInvalidation.payloadJson, {})
      : {};
    const boundaryIndex = invalidationPayload.invalidatedThroughValidationId
      ? allValidations.findIndex((validation) => validation.id === invalidationPayload.invalidatedThroughValidationId)
      : -1;
    const validations = !lastInvalidation
      ? allValidations
      : boundaryIndex >= 0
        ? allValidations.slice(0, boundaryIndex)
        : allValidations.filter((validation) => validation.createdAt > lastInvalidation.createdAt);
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
        const executionPath = captureCurrent && validation
          ? await this.getExecutionRepositoryPathById(item.id, repository.id, repository.path)
          : undefined;
        const currentSnapshot = executionPath
          ? await this.git.capture(executionPath)
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

  private nextAllowedTransition(
    state: WorkItemState,
    taskType: 'FEATURE' | 'PATCH' = 'FEATURE',
  ): string | undefined {
    const transitions: Partial<Record<WorkItemState, string>> = {
      DRAFT: 'READY',
      READY: 'AUTHORIZED',
      AUTHORIZED: taskType === 'PATCH' ? 'IMPLEMENTING' : 'TESTS_DEFINED',
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

  private transitionRequiresExecutionFence(from: WorkItemState, to: WorkItemState): boolean {
    return (to === 'BLOCKED' && !['DRAFT', 'READY'].includes(from)) ||
      to === 'TESTS_DEFINED' ||
      to === 'RED_CONFIRMED' ||
      to === 'TDD_EXCEPTION_APPROVED' ||
      to === 'IMPLEMENTING' ||
      to === 'GREEN_CONFIRMED' ||
      to === 'READY_FOR_REVIEW' ||
      to === 'APPROVED' ||
      to === 'CHANGES_REQUIRED' ||
      to === 'CLOSED' ||
      from === 'CHANGES_REQUIRED';
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

function hasDependencyPath(
  edges: Array<{ from: string; to: string }>,
  start: string,
  target: string,
): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const values = adjacency.get(edge.from) ?? [];
    values.push(edge.to);
    adjacency.set(edge.from, values);
  }
  const pending = [start];
  const visited = new Set<string>();
  while (pending.length) {
    const current = pending.shift() as string;
    if (current === target) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    pending.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

function findScopeConflicts(
  left: { repositories: Array<{ repositoryKey: string; paths: string[] }> },
  right: { repositories: Array<{ repositoryKey: string; paths: string[] }> },
  repositoryPaths?: Map<string, string>,
): Array<{ repositoryKey: string; leftPath: string; rightPath: string; rightRepositoryKey?: string }> {
  const conflicts: Array<{ repositoryKey: string; leftPath: string; rightPath: string; rightRepositoryKey?: string }> = [];
  for (const leftRepository of left.repositories) {
    for (const rightRepository of right.repositories) {
      const sameRepositoryKey = rightRepository.repositoryKey === leftRepository.repositoryKey;
      const leftRepositoryPath = repositoryPaths?.get(leftRepository.repositoryKey);
      const rightRepositoryPath = repositoryPaths?.get(rightRepository.repositoryKey);
      const repositoriesOverlap = Boolean(
        leftRepositoryPath &&
        rightRepositoryPath &&
        repositoryRootsOverlap(leftRepositoryPath, rightRepositoryPath),
      );
      if (!sameRepositoryKey && !repositoriesOverlap) {
        continue;
      }
      const leftPaths = leftRepository.paths.length ? leftRepository.paths : [''];
      const rightPaths = rightRepository.paths.length ? rightRepository.paths : [''];
      for (const leftPath of leftPaths) {
        for (const rightPath of rightPaths) {
          const overlaps = sameRepositoryKey
            ? scopePathsOverlap(leftPath, rightPath)
            : scopePathsOverlap(
                resolveScopePattern(repositoryPaths?.get(leftRepository.repositoryKey), leftPath),
                resolveScopePattern(repositoryPaths?.get(rightRepository.repositoryKey), rightPath),
              );
          if (overlaps) {
            conflicts.push({
              repositoryKey: leftRepository.repositoryKey,
              leftPath,
              rightPath,
              ...(sameRepositoryKey ? {} : { rightRepositoryKey: rightRepository.repositoryKey }),
            });
          }
        }
      }
    }
  }
  return conflicts;
}

function resolveScopePattern(repositoryPath: string | undefined, pattern: string): string {
  if (!repositoryPath) {
    return pattern;
  }
  return path.resolve(repositoryPath, normalizeScopePath(pattern) || '.');
}

function repositoryRootsOverlap(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return normalizedLeft === normalizedRight
    || normalizedLeft.startsWith(`${normalizedRight}${path.sep}`)
    || normalizedRight.startsWith(`${normalizedLeft}${path.sep}`);
}

function assertCandidateFilesInScope(
  scope: NonNullable<ReturnType<typeof decodeWorkItemScope>>,
  repositoryKey: string,
  changedFiles: string[],
): void {
  const repositoryScope = scope.repositories.find((entry) => entry.repositoryKey === repositoryKey);
  if (!repositoryScope) {
    fail('WORK_ITEM_SCOPE_VIOLATION', 'O candidato alterou um repositório fora do escopo autorizado.', {
      repositoryKey,
      changedFiles,
    });
  }

  const allowedPaths = repositoryScope?.paths.length ? repositoryScope.paths : [''];
  const outsideScope = changedFiles.filter((file) => !allowedPaths.some((pattern) => scopePathContains(pattern, file)));
  if (outsideScope.length) {
    fail(
      'WORK_ITEM_SCOPE_VIOLATION',
      'O candidato contém arquivos fora do escopo técnico declarado.',
      {
        repositoryKey,
        changedFiles: outsideScope,
        allowedPaths,
      },
    );
  }
}

function scopePathContains(pattern: string, file: string): boolean {
  const normalizedPattern = normalizeScopePath(pattern);
  const normalizedFile = normalizeScopePath(file);
  if (!normalizedPattern) {
    return true;
  }
  if (!normalizedFile) {
    return false;
  }
  if (!/[?*]/.test(normalizedPattern)) {
    return normalizedFile === normalizedPattern || normalizedFile.startsWith(`${normalizedPattern}/`);
  }
  return globMatchesPath(normalizedPattern, normalizedFile);
}

function scopePathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeScopePath(left);
  const normalizedRight = normalizeScopePath(right);
  if (!normalizedLeft || !normalizedRight) {
    return true;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }

  const leftGlob = /[*?]/.test(normalizedLeft);
  const rightGlob = /[*?]/.test(normalizedRight);
  if (!leftGlob && !rightGlob) {
    return normalizedLeft.startsWith(`${normalizedRight}/`) || normalizedRight.startsWith(`${normalizedLeft}/`);
  }

  if (leftGlob && !rightGlob) {
    return globMatchesPath(normalizedLeft, normalizedRight);
  }
  if (!leftGlob && rightGlob) {
    return globMatchesPath(normalizedRight, normalizedLeft);
  }

  const leftPrefix = staticGlobPrefix(normalizedLeft);
  const rightPrefix = staticGlobPrefix(normalizedRight);
  if (!leftPrefix || !rightPrefix) {
    return true;
  }
  return leftPrefix === rightPrefix ||
    leftPrefix.startsWith(`${rightPrefix}/`) ||
    rightPrefix.startsWith(`${leftPrefix}/`);
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

function sameContentSnapshot(
  left: { contentFingerprint?: string; sha: string },
  right: { contentFingerprint?: string; sha: string },
): boolean {
  if (left.contentFingerprint && right.contentFingerprint) {
    return left.contentFingerprint === right.contentFingerprint;
  }
  return left.sha === right.sha;
}

function isFrontendUiScope(scope: CreatePointTaskInput['scope']): boolean {
  return Boolean(scope?.repositories.some((repository) => (
    repository.repositoryKey === 'front'
    && repository.paths.some((filePath) => (
      filePath === 'src/**'
      || filePath === 'src/App.tsx'
      || /^src\/(pages|components|layouts)\//.test(filePath)
    ))
  )));
}

function sanitizeGitSegment(value: string): string {
  const sanitized = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-');
  return sanitized || 'item';
}

function normalizeCatalogValues<T extends string>(
  values: readonly string[],
  catalog: readonly T[],
  invalidCode: string,
): T[] {
  const allowed = new Set<string>(catalog);
  const normalized: T[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (!allowed.has(value)) {
      fail(invalidCode);
    }
    if (!seen.has(value)) {
      seen.add(value);
      normalized.push(value as T);
    }
  }

  return normalized;
}

function isUniqueConstraintError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === 'P2002';
}

function sliceSizeApprovalKey(featureKey: string, itemKey: string): string {
  return `SLICE-SIZE-APPROVAL-${featureKey}-${itemKey}`;
}

export function sliceSizeRequestKey(featureKey: string, itemKey: string): string {
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

export function deriveFeatureExecution(
  items: Array<{ id: string; parentItemId: string | null; state: string }>,
): { executionStatus: FeatureExecutionStatus; executionCounts: FeatureExecutionCounts } {
  const parentIds = new Set(
    items
      .map((item) => item.parentItemId)
      .filter((parentId): parentId is string => Boolean(parentId)),
  );
  const leaves = items.filter((item) => !parentIds.has(item.id));
  const closedLeaves = leaves.filter((item) => item.state === 'CLOSED').length;
  const executionStatus: FeatureExecutionStatus = leaves.length === 0
    ? 'EMPTY'
    : closedLeaves === leaves.length
      ? 'COMPLETED'
      : 'OPEN';

  return {
    executionStatus,
    executionCounts: {
      totalLeaves: leaves.length,
      closedLeaves,
      openLeaves: leaves.length - closedLeaves,
    },
  };
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
