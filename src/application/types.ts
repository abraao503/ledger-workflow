import type { PrismaClient } from '@prisma/client';

import type {
  SliceSizeMetrics,
  SliceSizePolicy,
  SliceSizeViolation,
} from '../domain/slice-sizing.js';
import type { WorkItemScope } from '../domain/work-item-scope.js';
import type {
  SemanticIssue,
  SemanticStatus,
} from '../domain/planning-semantics.js';

export type DatabaseClient = PrismaClient;

export type CreateProjectInput = {
  key: string;
  name: string;
  rootPath: string;
};

export type AddRepositoryInput = {
  projectKey: string;
  key: string;
  path: string;
  expectedBranch?: string;
};

export type CreateTemplateInput = {
  projectKey: string;
  key: string;
  name: string;
  definition: Record<string, unknown>;
};

export type CreateFeatureInput = {
  projectKey: string;
  templateKey: string;
  templateVersion?: number;
  key: string;
  name: string;
  summary: string;
};

export type UseCaseInput = {
  key: string;
  title: string;
  actor: string;
  preconditions: string;
  trigger: string;
  expectedOutcome: string;
  invariants?: string[];
};

export type AcceptanceCriterionInput = {
  key: string;
  statement: string;
  useCaseKey?: string;
  required?: boolean;
};

export type TestSpecificationInput = {
  key: string;
  name: string;
  purpose: 'RED' | 'GREEN' | 'CHECK';
  runnerProfileKey?: string;
  criterionKey?: string;
};

export type DefineWorkItemInput = {
  projectKey: string;
  featureKey: string;
  key: string;
  phaseKey: string;
  position: number;
  title: string;
  kind?: 'CODE' | 'DOCUMENTATION' | 'VALIDATION' | 'OTHER';
  summary?: string;
  tddPolicy?: 'REQUIRED' | 'OPTIONAL' | 'EXEMPT';
  parentItemKey?: string;
  scope?: WorkItemScope;
  dependsOn?: WorkItemDependencyRef[];
  useCases: UseCaseInput[];
  criteria: AcceptanceCriterionInput[];
  tests: TestSpecificationInput[];
};

export type RepositoryBaselineInput = {
  repositoryKey: string;
  branch: string;
  sha: string;
  dirty: boolean;
  changedFiles?: string[];
};

export type AuthorizeWorkItemInput = {
  projectKey: string;
  featureKey: string;
  itemKey: string;
  instruction: string;
  actor: string;
  allowedEffects: string[];
  forbiddenEffects: string[];
  repositoryKeys: string[];
  executionMode?: 'SHARED' | 'MANAGED_WORKTREE';
};

export type GitSnapshot = {
  branch: string;
  sha: string;
  dirty: boolean;
  changedFiles: string[];
  fingerprint: string;
  contentFingerprint?: string;
};

export type GitReadPort = {
  capture: (repositoryPath: string) => Promise<GitSnapshot>;
};

export type GitWorkspacePort = GitReadPort & {
  createWorktree: (input: {
    repositoryPath: string;
    worktreePath: string;
    branch: string;
    sha: string;
  }) => Promise<void>;
  removeWorktree: (repositoryPath: string, worktreePath: string) => Promise<void>;
  deleteBranch: (repositoryPath: string, branch: string) => Promise<void>;
  rebaseWorktree: (worktreePath: string, targetBranch: string) => Promise<void>;
  getHead: (repositoryPath: string) => Promise<string>;
  diffFiles: (repositoryPath: string, baseSha: string, candidateSha: string) => Promise<string[]>;
  fastForward: (repositoryPath: string, branch: string) => Promise<void>;
};

export type CreateValidationProfileInput = {
  projectKey: string;
  repositoryKey: string;
  key: string;
  program: string;
  args: string[];
  cwd?: string;
  parser: 'JEST' | 'GENERIC';
  timeoutSeconds?: number;
  maxOutputBytes?: number;
};

export type RecordValidationInput = {
  projectKey: string;
  featureKey: string;
  itemKey: string;
  repositoryKey: string;
  profileKey: string;
  purpose: 'RED' | 'GREEN' | 'CHECK';
  status: 'COMPLETED' | 'TIMED_OUT' | 'FAILED_TO_START';
  resultKind: 'PASS' | 'TEST_FAILURE' | 'INFRASTRUCTURE_ERROR' | 'TIMEOUT';
  exitCode?: number;
  sha: string;
  durationMs: number;
  summary: Record<string, unknown>;
  log?: string;
};

export type ExecuteValidationInput = {
  projectKey: string;
  featureKey: string;
  itemKey: string;
  repositoryKey: string;
  profileKey: string;
  purpose: 'RED' | 'GREEN' | 'CHECK';
  reason?: string;
};

export type ConfirmStructuralRedInput = {
  projectKey: string;
  featureKey: string;
  itemKey: string;
  validationId: string;
  reason: string;
};

export type InvalidateGreenInput = {
  projectKey: string;
  featureKey: string;
  itemKey: string;
  reason: string;
};

export type CommandRequest = {
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
};

export type CommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error?: string;
};

export type CommandRunner = {
  run: (request: CommandRequest) => Promise<CommandResult>;
};

export type ReviewFindingInput = {
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  location: string;
  evidence: string;
  risk: string;
  correction: string;
  testNeeded: string;
  resolved?: boolean;
};

export type SubmitReviewInput = {
  projectKey: string;
  featureKey: string;
  itemKey: string;
  reviewer: string;
  reviewMode?: 'SELF' | 'INDEPENDENT';
  verdict: 'APPROVED' | 'CHANGES_REQUIRED' | 'BLOCKED';
  summary: string;
  findings: ReviewFindingInput[];
};

export type TransitionWorkItemInput = {
  projectKey: string;
  featureKey: string;
  itemKey: string;
  to: string;
  reason?: string;
  commitSha?: string;
  integrationApprovalId?: string;
};

export type ReopenWorkItemInput = {
  projectKey: string;
  featureKey: string;
  itemKey: string;
  actor: string;
  reason: string;
};

export type ReplanWorkItemInput = {
  projectKey: string;
  featureKey: string;
  itemKey: string;
  actor: string;
  reason: string;
};

export type ClaimWorkItemInput = {
  projectKey: string;
  featureKey: string;
  itemKey: string;
  holder: string;
  durationSeconds?: number;
};

export type RecoverWorkItemLeaseInput = ClaimWorkItemInput;

export type WorkItemDependencyRef = {
  featureKey: string;
  itemKey: string;
};

export type AddWorkItemDependencyInput = {
  projectKey: string;
  featureKey: string;
  itemKey: string;
  dependsOn: WorkItemDependencyRef;
};

export type RemoveWorkItemDependencyInput = AddWorkItemDependencyInput;

export type PrepareIntegrationInput = {
  projectKey: string;
  featureKey: string;
  itemKey: string;
};

export type AuthorizeIntegrationInput = {
  projectKey: string;
  featureKey: string;
  itemKey: string;
  actor: string;
  candidates: Record<string, string>;
  targetBases: Record<string, string>;
};

export type IntegrateWorkItemInput = {
  projectKey: string;
  featureKey: string;
  itemKey: string;
};

export type CleanupWorkItemInput = {
  projectKey: string;
  featureKey: string;
  itemKey: string;
};

export type ContextRequest = {
  projectKey: string;
  featureKey?: string;
  itemKey?: string;
  maxChars?: number;
};

export type RecordRequest = {
  projectKey: string;
  featureKey: string;
  itemKey: string;
};

export type PlanCheckRequest = {
  projectKey: string;
  featureKey: string;
};

export type ApproveSliceSizeInput = {
  projectKey: string;
  featureKey: string;
  itemKey: string;
  actor: string;
  reason: string;
};

export type RequestSliceSizeExceptionInput = {
  projectKey: string;
  featureKey: string;
  itemKey: string;
  actor: string;
  reason: string;
};

export type PlanCheckItem = {
  key: string;
  title: string;
  phaseKey: string;
  state: string;
  parentItemKey?: string;
  scope?: WorkItemScope;
  scopeIssues: string[];
  semanticStatus: SemanticStatus;
  semanticIssues: SemanticIssue[];
  metrics: SliceSizeMetrics;
  status: 'OK' | 'SPLIT_RECOMMENDED' | 'EXCEPTION_REQUIRED';
  score: number;
  violations: SliceSizeViolation[];
  suggestions: string[];
  repositoryScope: 'DECLARED' | 'CAPTURED' | 'UNKNOWN';
};

export type PlanCheckResult = {
  project: string;
  feature: {
    key: string;
    name: string;
    summary: string;
  };
  policy: SliceSizePolicy;
  summary: {
    total: number;
    ok: number;
    splitRecommended: number;
    exceptionRequired: number;
  };
  items: PlanCheckItem[];
};

export type ListValidationsInput = {
  projectKey: string;
  featureKey: string;
  itemKey: string;
  purpose?: 'RED' | 'GREEN' | 'CHECK';
};

export type RecordDecisionInput = {
  projectKey: string;
  featureKey?: string;
  itemKey?: string;
  key: string;
  title: string;
  content: string;
  durable?: boolean;
  pinned?: boolean;
};

export type RecordPendingItemInput = {
  projectKey: string;
  featureKey?: string;
  itemKey?: string;
  key: string;
  description: string;
  blocking?: boolean;
  pinned?: boolean;
};

export type ResolvePendingItemInput = {
  projectKey: string;
  key: string;
  reason?: string;
};

export type CompactHistoryInput = {
  projectKey: string;
  featureKey: string;
  activeItemKey: string;
  keepRecent?: number;
};

export type DashboardSelection = {
  projectKey?: string;
  featureKey?: string;
  itemKey?: string;
};

export type DashboardCatalogItem = {
  key: string;
  title: string;
  phaseKey: string;
  state: string;
  position: number;
};

export type FeatureExecutionStatus = 'EMPTY' | 'OPEN' | 'COMPLETED';

export type FeatureExecutionCounts = {
  totalLeaves: number;
  closedLeaves: number;
  openLeaves: number;
};

export type DashboardCatalogFeature = {
  key: string;
  name: string;
  status: string;
  currentPhaseKey?: string;
  executionStatus: FeatureExecutionStatus;
  executionCounts: FeatureExecutionCounts;
  items: DashboardCatalogItem[];
};

export type DashboardCatalogProject = {
  key: string;
  name: string;
  status: string;
  features: DashboardCatalogFeature[];
};

export type DashboardActionId =
  | 'CLAIM'
  | 'RECOVER'
  | 'MARK_READY'
  | 'AUTHORIZE'
  | 'MARK_TESTS_DEFINED'
  | 'RUN_RED'
  | 'APPROVE_TDD_EXCEPTION'
  | 'START_IMPLEMENTING'
  | 'RUN_GREEN'
  | 'MARK_READY_FOR_REVIEW'
  | 'SUBMIT_REVIEW'
  | 'RETURN_TO_TESTS'
  | 'CLOSE'
  | 'BLOCK'
  | 'REOPEN'
  | 'INVALIDATE_GREEN'
  | 'RUN_CHECK'
  | 'PREPARE_INTEGRATION'
  | 'AUTHORIZE_INTEGRATION'
  | 'INTEGRATE'
  | 'CLEANUP_WORKTREES'
  | 'REINSPECT'
  | 'COMPACT_HISTORY'
  | 'PLAN_CHECK'
  | 'REQUEST_SIZE_EXCEPTION'
  | 'APPROVE_SIZE'
  | 'REPLAN';

export type DashboardAction = {
  id: DashboardActionId;
  label: string;
  kind: 'primary' | 'secondary' | 'danger' | 'maintenance';
  enabled: boolean;
  reason?: string;
  options?: {
    repositoryKeys?: string[];
    profileKeys?: string[];
  };
};

export type DashboardHealth = {
  ok: boolean;
  database: 'sqlite';
  journalMode: string;
  serverTime: string;
};

export type DashboardValidation = {
  id: string;
  purpose: string;
  status: string;
  resultKind: string;
  exitCode: number | null;
  sha: string;
  durationMs: number;
  summary: Record<string, unknown>;
  profileKey: string;
  createdAt: string;
  logAvailable: boolean;
  logExpiresAt?: string;
};

export type DashboardGate = {
  key: string;
  label: string;
  states: string[];
  status: 'complete' | 'active' | 'pending' | 'blocked';
};

export type DashboardSnapshot = {
  selection: {
    projectKey: string;
    featureKey: string;
    itemKey: string;
    view: string;
  };
  project: { key: string; name: string; rootPath?: string };
  feature: { key: string; name: string; summary: string; status: string };
  overview: {
    repositories: number;
    cleanRepositories: number;
    activeFeatures: number;
    openItems: number;
    walMode: string;
  };
  item: {
    key: string;
    title: string;
    phaseKey: string;
    kind: string;
    state: string;
    summary?: string | null;
    tddPolicy: string;
    currentSha?: string | null;
    requirementsComplete: boolean;
  };
  gates: DashboardGate[];
  context: Record<string, unknown>;
  record: Record<string, unknown>;
  validations: DashboardValidation[];
  pendingItems: Array<{
    key: string;
    description: string;
    blocking: boolean;
    resolved: boolean;
  }>;
  recentSlices: Array<{
    key: string;
    title: string;
    state: string;
    summary?: string | null;
    currentSha?: string | null;
    position: number;
  }>;
  repositories: Array<{
    key: string;
    expectedBranch?: string | null;
    profiles: Array<{ key: string; parser: string }>;
  }>;
  lease?: {
    holder: string;
    acquiredAt: string;
    expiresAt: string;
    active: boolean;
  } | null;
  execution?: {
    mode: string;
    workspaces: Array<{
      repository: string;
      path: string;
      branch: string;
      baseSha: string;
      targetBaseSha?: string | null;
      candidateSha?: string | null;
      status: string;
      cleanupError?: string | null;
    }>;
    integrationApproval?: {
      id: string;
      actor: string;
      status: string;
      candidates: Record<string, string>;
      targetBases: Record<string, string>;
    };
  };
  availableActions: DashboardAction[];
  health: DashboardHealth;
};
