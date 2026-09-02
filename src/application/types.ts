import type { PrismaClient } from '@prisma/client';

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
};

export type GitSnapshot = {
  branch: string;
  sha: string;
  dirty: boolean;
  changedFiles: string[];
};

export type GitReadPort = {
  capture: (repositoryPath: string) => Promise<GitSnapshot>;
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

export type CompactHistoryInput = {
  projectKey: string;
  featureKey: string;
  activeItemKey: string;
  keepRecent?: number;
};
