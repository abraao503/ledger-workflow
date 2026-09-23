import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

import type { PrismaClient } from '@prisma/client';

import { WorkflowTransitionError } from '../domain/workflow-state.js';
import { GitReadAdapter } from './git-read-adapter.js';
import { fail } from './errors.js';
import { decodeJson } from './json.js';
import type {
  CommandRequest,
  CommandResult,
  CommandRunner,
  ExecuteValidationInput,
  GitReadPort,
  ValidationParser,
} from './types.js';
import { WorkflowLedger } from './workflow-ledger.js';

type ValidationStatus = 'COMPLETED' | 'TIMED_OUT' | 'FAILED_TO_START';
type ValidationResultKind = 'PASS' | 'TEST_FAILURE' | 'INFRASTRUCTURE_ERROR' | 'TIMEOUT';
export type ObservedTestStatus = 'PASSED' | 'FAILED' | 'SKIPPED';
export type ObservedTestResult = { selector: string; status: ObservedTestStatus };

export type ValidationClassification = {
  status: ValidationStatus;
  resultKind: ValidationResultKind;
  redEvidenceKind?: 'BEHAVIORAL' | 'STRUCTURAL';
  testsTotal?: number;
};

export function classifyRedEvidence(
  output: string,
  parser: ValidationParser,
  plannedSelectors: string[] = [],
  repositoryRoot = process.cwd(),
): Pick<ValidationClassification, 'redEvidenceKind' | 'testsTotal'> {
  if (isStructuredParser(parser)) {
    try {
      const tests = parseStructuredTestReport(output, parser, repositoryRoot);
      return {
        redEvidenceKind: tests.some((test) => (
          test.status === 'FAILED' && plannedSelectors.includes(test.selector)
        )) ? 'BEHAVIORAL' : 'STRUCTURAL',
        testsTotal: tests.length,
      };
    } catch {
      return { redEvidenceKind: 'STRUCTURAL', testsTotal: 0 };
    }
  }

  const tests = parser === 'JEST' ? output.match(/Tests:\s+.*?(\d+)\s+total/i) : null;
  return {
    redEvidenceKind: 'STRUCTURAL',
    testsTotal: tests ? Number(tests[1]) : 0,
  };
}

export function classifyCommandResult(
  result: CommandResult,
  parser: ValidationParser,
  structuredReport?: ObservedTestResult[] | null,
): ValidationClassification {
  if (result.timedOut) {
    return { status: 'TIMED_OUT', resultKind: 'TIMEOUT' };
  }

  if (result.error || result.exitCode === null) {
    return { status: 'FAILED_TO_START', resultKind: 'INFRASTRUCTURE_ERROR' };
  }

  if (isStructuredParser(parser)) {
    let report = structuredReport;
    if (report === undefined) {
      try {
        report = parseStructuredTestReport(result.stdout, parser);
      } catch {
        report = null;
      }
    }
    if (!report || report.length === 0) {
      return { status: 'COMPLETED', resultKind: 'INFRASTRUCTURE_ERROR' };
    }
    if (report.some((test) => test.status === 'FAILED')) {
      return { status: 'COMPLETED', resultKind: 'TEST_FAILURE' };
    }
    return result.exitCode === 0
      ? { status: 'COMPLETED', resultKind: 'PASS' }
      : { status: 'COMPLETED', resultKind: 'INFRASTRUCTURE_ERROR' };
  }

  if (result.exitCode === 0) {
    return { status: 'COMPLETED', resultKind: 'PASS' };
  }

  const output = `${result.stdout}\n${result.stderr}`;
  const hasJestTestReport = parser === 'JEST' && /(?:Test Suites|Tests):\s+.*(?:failed|passed|total)/i.test(output);
  const hasKnownJestStructuralFailure = parser === 'JEST' && (
    /No tests found/i.test(output) ||
    /Your test suite must contain at least one test/i.test(output)
  );

  if (hasJestTestReport || hasKnownJestStructuralFailure) {
    return { status: 'COMPLETED', resultKind: 'TEST_FAILURE' };
  }

  return { status: 'COMPLETED', resultKind: 'INFRASTRUCTURE_ERROR' };
}

export function parseStructuredTestReport(
  output: string,
  parser: 'JEST_JSON' | 'PLAYWRIGHT_JSON',
  repositoryRoot = process.cwd(),
): ObservedTestResult[] {
  const report: unknown = extractStructuredJson(
    output,
    parser === 'JEST_JSON' ? 'testResults' : 'suites',
  );
  if (parser === 'JEST_JSON') {
    return parseJestReport(report, repositoryRoot);
  }
  return parsePlaywrightReport(report, repositoryRoot);
}

function extractStructuredJson(output: string, expectedRootKey: string): unknown {
  for (let start = 0; start < output.length; start += 1) {
    if (output[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    let completedObject = false;
    for (let end = start; end < output.length; end += 1) {
      const character = output[end];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (character === '\\') {
          escaped = true;
        } else if (character === '"') {
          inString = false;
        }
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === '{') {
        depth += 1;
      } else if (character === '}') {
        depth -= 1;
        if (depth === 0) {
          completedObject = true;
          try {
            const candidate: unknown = JSON.parse(output.slice(start, end + 1));
            if (isRecord(candidate) && expectedRootKey in candidate) return candidate;
          } catch {
            // Allow process wrappers before the one complete report object.
          }
          start = end;
          break;
        }
      }
    }
    if (!completedObject) break;
  }
  throw new Error('STRUCTURED_TEST_REPORT_INVALID');
}

export function assessTestEvidence(
  planned: Array<{ key: string; selector?: string }>,
  observed: ObservedTestResult[],
): { complete: boolean; missingKeys: string[]; failedKeys: string[] } {
  const results = new Map(observed.map((test) => [test.selector, test.status]));
  const missingKeys: string[] = [];
  const failedKeys: string[] = [];

  for (const test of planned) {
    if (!test.selector) {
      missingKeys.push(test.key);
      continue;
    }
    const status = results.get(test.selector);
    if (status === 'FAILED') {
      failedKeys.push(test.key);
    } else if (status !== 'PASSED') {
      missingKeys.push(test.key);
    }
  }

  return {
    complete: missingKeys.length === 0 && failedKeys.length === 0,
    missingKeys,
    failedKeys,
  };
}

function parseJestReport(report: unknown, repositoryRoot: string): ObservedTestResult[] {
  if (!isRecord(report) || !Array.isArray(report.testResults)) {
    throw new Error('JEST_JSON_REPORT_INVALID');
  }

  const observed: ObservedTestResult[] = [];
  for (const suite of report.testResults) {
    if (!isRecord(suite) || typeof suite.name !== 'string' || !Array.isArray(suite.assertionResults)) {
      throw new Error('JEST_JSON_SUITE_INVALID');
    }
    const file = normalizeReportFile(suite.name, repositoryRoot);
    for (const assertion of suite.assertionResults) {
      if (!isRecord(assertion) || typeof assertion.status !== 'string') {
        throw new Error('JEST_JSON_ASSERTION_INVALID');
      }
      const fullName = typeof assertion.fullName === 'string' && assertion.fullName.trim()
        ? assertion.fullName.trim()
        : [
            ...(Array.isArray(assertion.ancestorTitles)
              ? assertion.ancestorTitles.filter((title): title is string => typeof title === 'string')
              : []),
            typeof assertion.title === 'string' ? assertion.title : '',
          ].filter(Boolean).join(' ');
      if (!fullName) {
        throw new Error('JEST_JSON_ASSERTION_NAME_MISSING');
      }
      observed.push({
        selector: `${file}::${fullName}`,
        status: normalizeJestStatus(assertion.status),
      });
    }
  }
  return dedupeObservedTests(observed);
}

function parsePlaywrightReport(report: unknown, repositoryRoot: string): ObservedTestResult[] {
  if (!isRecord(report) || !Array.isArray(report.suites)) {
    throw new Error('PLAYWRIGHT_JSON_REPORT_INVALID');
  }

  const observed: ObservedTestResult[] = [];
  const visit = (suite: Record<string, unknown>, inheritedFile?: string, titles: string[] = []) => {
    const fileValue = typeof suite.file === 'string' ? suite.file : inheritedFile;
    const file = fileValue ? normalizeReportFile(fileValue, repositoryRoot) : undefined;
    const suiteTitle = typeof suite.title === 'string' ? suite.title.trim() : '';
    const isFileTitle = file && suiteTitle === path.basename(file);
    const nestedTitles = suiteTitle && !isFileTitle ? [...titles, suiteTitle] : titles;

    if (suite.specs !== undefined && !Array.isArray(suite.specs)) {
      throw new Error('PLAYWRIGHT_JSON_SPECS_INVALID');
    }
    for (const spec of (suite.specs ?? []) as unknown[]) {
      if (!isRecord(spec) || typeof spec.title !== 'string' || !Array.isArray(spec.tests) || !file) {
        throw new Error('PLAYWRIGHT_JSON_SPEC_INVALID');
      }
      const title = [...nestedTitles, spec.title.trim()].filter(Boolean).join(' ');
      for (const test of spec.tests) {
        if (!isRecord(test) || !Array.isArray(test.results)) {
          throw new Error('PLAYWRIGHT_JSON_TEST_INVALID');
        }
        const project = typeof test.projectName === 'string' ? test.projectName.trim() : '';
        const results = test.results.filter(isRecord);
        const lastResult = results.at(-1);
        const status = lastResult
          ? normalizePlaywrightStatus(lastResult.status, test.expectedStatus)
          : test.expectedStatus === 'skipped'
            ? 'SKIPPED'
            : 'SKIPPED';
        observed.push({
          selector: `${file}::${title}${project ? `::${project}` : ''}`,
          status,
        });
      }
    }

    if (suite.suites !== undefined && !Array.isArray(suite.suites)) {
      throw new Error('PLAYWRIGHT_JSON_SUITES_INVALID');
    }
    for (const child of (suite.suites ?? []) as unknown[]) {
      if (!isRecord(child)) {
        throw new Error('PLAYWRIGHT_JSON_SUITE_INVALID');
      }
      visit(child, fileValue, nestedTitles);
    }
  };

  for (const suite of report.suites) {
    if (!isRecord(suite)) {
      throw new Error('PLAYWRIGHT_JSON_SUITE_INVALID');
    }
    visit(suite);
  }
  return dedupeObservedTests(observed);
}

function normalizeJestStatus(status: string): ObservedTestStatus {
  if (status === 'passed') return 'PASSED';
  if (status === 'failed') return 'FAILED';
  if (['pending', 'todo', 'disabled'].includes(status)) return 'SKIPPED';
  throw new Error('JEST_JSON_STATUS_INVALID');
}

function normalizePlaywrightStatus(status: unknown, expectedStatus: unknown): ObservedTestStatus {
  if (status === expectedStatus && typeof expectedStatus === 'string') return 'PASSED';
  if (status === 'passed') return 'PASSED';
  if (status === 'skipped') return 'SKIPPED';
  if (['failed', 'timedOut', 'interrupted'].includes(String(status))) return 'FAILED';
  throw new Error('PLAYWRIGHT_JSON_STATUS_INVALID');
}

function normalizeReportFile(file: string, repositoryRoot: string): string {
  const absolute = path.isAbsolute(file) ? path.normalize(file) : path.resolve(repositoryRoot, file);
  const relative = path.relative(repositoryRoot, absolute);
  return relative.split(path.sep).join('/');
}

function dedupeObservedTests(tests: ObservedTestResult[]): ObservedTestResult[] {
  const bySelector = new Map<string, ObservedTestResult>();
  for (const test of tests) {
    const previous = bySelector.get(test.selector);
    if (!previous || test.status === 'FAILED' || previous.status === 'SKIPPED') {
      bySelector.set(test.selector, test);
    }
  }
  return [...bySelector.values()];
}

function isStructuredParser(parser: ValidationParser): parser is 'JEST_JSON' | 'PLAYWRIGHT_JSON' {
  return parser === 'JEST_JSON' || parser === 'PLAYWRIGHT_JSON';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class ValidationExecutor {
  constructor(
    private readonly db: PrismaClient,
    private readonly ledger: WorkflowLedger,
    private readonly git: GitReadPort = new GitReadAdapter(),
    private readonly runner: CommandRunner = createCommandRunner(),
  ) {}

  async run(input: ExecuteValidationInput) {
    const item = await this.db.workItem.findFirst({
      where: {
        key: input.itemKey,
        feature: {
          key: input.featureKey,
          project: { key: input.projectKey },
        },
      },
      include: { feature: true },
    });

    if (!item) {
      fail('WORK_ITEM_NOT_FOUND');
    }

    await this.ledger.verifyExecutionFence({
      projectKey: input.projectKey,
      featureKey: input.featureKey,
      itemKey: input.itemKey,
      executionFence: input.executionFence,
    });

    const repository = await this.db.repository.findFirst({
      where: {
        projectId: (item as NonNullable<typeof item>).feature.projectId,
        key: input.repositoryKey,
      },
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

    const currentItem = item as NonNullable<typeof item>;
    const currentRepository = repository as NonNullable<typeof repository>;
    const currentProfile = profile as NonNullable<typeof profile>;
    const authorizedRepository = await this.db.repositorySnapshot.findFirst({
      where: {
        workItemId: currentItem.id,
        repositoryId: currentRepository.id,
      },
    });

    if (!authorizedRepository) {
      fail('VALIDATION_REPOSITORY_NOT_AUTHORIZED');
    }

    assertPurposeState(input.purpose, currentItem.state);

    const repositoryPath = path.resolve(await this.ledger.getExecutionRepositoryPath({
      projectKey: input.projectKey,
      featureKey: input.featureKey,
      itemKey: input.itemKey,
      repositoryKey: input.repositoryKey,
    }));
    const workingDirectory = path.resolve(repositoryPath, currentProfile.cwd);

    if (!isWithin(repositoryPath, workingDirectory)) {
      fail('VALIDATION_CWD_INVALID');
    }

    const snapshotBefore = await this.git.capture(repositoryPath);
    const parser = currentProfile.parser as ValidationParser;
    if (!['JEST', 'JEST_JSON', 'PLAYWRIGHT_JSON', 'GENERIC'].includes(parser)) {
      fail('VALIDATION_PARSER_INVALID');
    }
    const testSpecifications = await this.db.testSpecification.findMany({
      where: { workItemId: currentItem.id },
      select: {
        key: true,
        name: true,
        purpose: true,
        runnerProfileKey: true,
        testSelector: true,
        criterion: { select: { key: true } },
      },
      orderBy: { key: 'asc' },
    });
    const applicableTests = testSpecifications.filter((test) => (
      test.runnerProfileKey === null || test.runnerProfileKey === input.profileKey
    ));
    const purposeTests = applicableTests.filter((test) => test.purpose === input.purpose);
    const criteria = await this.db.acceptanceCriterion.findMany({
      where: { workItemId: currentItem.id },
      select: { key: true, statement: true, required: true, evidenceKind: true, polarity: true },
      orderBy: { key: 'asc' },
    });
    const testPlanFingerprint = stableFingerprint({
      riskTagsJson: currentItem.riskTagsJson,
      scopeJson: currentItem.scopeJson,
      criteria,
      tests: testSpecifications.map((test) => ({
        key: test.key,
        name: test.name,
        purpose: test.purpose,
        runnerProfileKey: test.runnerProfileKey,
        testSelector: test.testSelector,
        criterionKey: test.criterion?.key ?? null,
      })),
    });
    const profileFingerprint = stableFingerprint({
      id: currentProfile.id,
      key: currentProfile.key,
      parser,
      program: currentProfile.program,
      args: decodeJson<string[]>(currentProfile.argsJson, []),
      cwd: currentProfile.cwd,
      timeoutSeconds: currentProfile.timeoutSeconds,
      maxOutputBytes: currentProfile.maxOutputBytes,
    });
    const strictTestKeys = isStructuredParser(parser)
      ? purposeTests.map((test) => test.key)
      : [];

    if (input.purpose === 'CHECK') {
      const requiresCompleteGreenTestEvidence = applicableTests.some((test) => test.purpose === 'GREEN');
      const reusableGreen = await this.findReusableGreen(
        currentItem.id,
        currentProfile.id,
        snapshotBefore.fingerprint,
        snapshotBefore.contentFingerprint,
        testPlanFingerprint,
        profileFingerprint,
        requiresCompleteGreenTestEvidence,
        strictTestKeys,
      );

      if (reusableGreen) {
        const reusableSummary = decodeJson<{
          coveredTestKeys?: string[];
          coveredTestResults?: Array<{ key: string; selector: string; status: ObservedTestStatus }>;
        }>(reusableGreen.summaryJson, {});
        const validation = await this.ledger.recordValidation({
          projectKey: input.projectKey,
          featureKey: input.featureKey,
          itemKey: input.itemKey,
          repositoryKey: input.repositoryKey,
          profileKey: input.profileKey,
          purpose: 'CHECK',
          status: 'COMPLETED',
          resultKind: 'PASS',
          exitCode: 0,
          sha: snapshotBefore.sha,
          durationMs: 0,
          summary: {
            parser: currentProfile.parser,
            profileKey: input.profileKey,
            validationCapabilities: decodeJson<string[]>(currentProfile.capabilitiesJson, []),
            fingerprint: snapshotBefore.fingerprint,
            ...(snapshotBefore.contentFingerprint
              ? { contentFingerprint: snapshotBefore.contentFingerprint }
              : {}),
            dirty: snapshotBefore.dirty,
            changedFileCount: snapshotBefore.changedFiles.length,
            testPlanFingerprint,
            profileFingerprint,
            coveredTestKeys: reusableSummary.coveredTestKeys ?? [],
            coveredTestResults: reusableSummary.coveredTestResults ?? [],
            reusedFromValidationId: reusableGreen.id,
            reusedFromPurpose: 'GREEN',
          },
          executionFence: input.executionFence,
        });

        return {
          validation,
          classification: { status: 'COMPLETED', resultKind: 'PASS' } as ValidationClassification,
          reused: true,
          itemState: currentItem.state,
          pendingRepositoryKeys: undefined,
          pendingTestKeys: undefined,
        };
      }
    }

    const args = decodeJson<string[]>(currentProfile.argsJson, []);
    const command = buildValidationCommand(currentProfile.program, args);
    const request: CommandRequest = {
      ...command,
      cwd: workingDirectory,
      timeoutMs: currentProfile.timeoutSeconds * 1_000,
      maxOutputBytes: currentProfile.maxOutputBytes,
    };
    const startedAt = Date.now();
    const commandResult = await this.runner.run(request);
    const durationMs = Date.now() - startedAt;
    let observedTests: ObservedTestResult[] | undefined;
    let structuredReport: ObservedTestResult[] | null | undefined;
    if (isStructuredParser(parser) && !commandResult.error && commandResult.exitCode !== null) {
      try {
        observedTests = parseStructuredTestReport(commandResult.stdout, parser, repositoryPath);
        structuredReport = observedTests;
      } catch {
        structuredReport = null;
      }
    }
    const snapshotAfter = await this.git.capture(repositoryPath);
    const baseClassification = classifyCommandResult(commandResult, parser, structuredReport);
    const observedBySelector = new Map((observedTests ?? []).map((test) => [test.selector, test]));
    const coveredTestResults = applicableTests.flatMap((test) => {
      if (!test.testSelector) return [];
      const observed = observedBySelector.get(test.testSelector);
      return observed
        ? [{ key: test.key, selector: test.testSelector, status: observed.status }]
        : [];
    });
    const coveredTestKeys = coveredTestResults.map((test) => test.key);
    const requiresObservedTestEvidence = isStructuredParser(parser) || (
      input.purpose === 'GREEN' && purposeTests.length > 0
    );
    const testEvidence = requiresObservedTestEvidence
      ? assessTestEvidence(purposeTests.map((test) => ({
          key: test.key,
          selector: test.testSelector ?? undefined,
        })), observedTests ?? [])
      : { complete: true, missingKeys: [], failedKeys: [] };
    const worktreeChanged = snapshotBefore.fingerprint !== snapshotAfter.fingerprint;
    const classification: ValidationClassification = worktreeChanged
      ? { status: 'COMPLETED', resultKind: 'INFRASTRUCTURE_ERROR' }
      : {
          ...baseClassification,
          ...(input.purpose === 'RED' && baseClassification.resultKind === 'TEST_FAILURE'
            ? classifyRedEvidence(
                isStructuredParser(parser) ? commandResult.stdout : `${commandResult.stdout}\n${commandResult.stderr}`,
                parser,
                purposeTests.flatMap((test) => test.testSelector ? [test.testSelector] : []),
                repositoryPath,
              )
            : {}),
        };
    const validation = await this.ledger.recordValidation({
      projectKey: input.projectKey,
      featureKey: input.featureKey,
      itemKey: input.itemKey,
      repositoryKey: input.repositoryKey,
      profileKey: input.profileKey,
      purpose: input.purpose,
      status: classification.status,
      resultKind: classification.resultKind,
      exitCode: commandResult.exitCode ?? undefined,
      sha: snapshotAfter.sha,
      durationMs,
      summary: {
        parser,
        profileKey: input.profileKey,
        validationCapabilities: decodeJson<string[]>(currentProfile.capabilitiesJson, []),
        program: currentProfile.program,
        args: decodeJson<string[]>(currentProfile.argsJson, []),
        cwd: currentProfile.cwd,
        exitCode: commandResult.exitCode,
        timedOut: commandResult.timedOut,
        error: commandResult.error,
        stdoutBytes: Buffer.byteLength(commandResult.stdout),
        stderrBytes: Buffer.byteLength(commandResult.stderr),
        dirty: snapshotAfter.dirty,
        changedFileCount: snapshotAfter.changedFiles.length,
        fingerprint: snapshotAfter.fingerprint,
        ...(snapshotAfter.contentFingerprint
          ? { contentFingerprint: snapshotAfter.contentFingerprint }
          : {}),
        worktreeChangedDuringValidation: worktreeChanged,
        testPlanFingerprint,
        profileFingerprint,
        observedTests,
        testEvidence,
        coveredTestKeys,
        coveredTestResults,
        redEvidenceKind: classification.redEvidenceKind,
        testsTotal: classification.testsTotal,
      },
      log: `${commandResult.stdout}${commandResult.stderr ? `\n${commandResult.stderr}` : ''}`,
      executionFence: input.executionFence,
    });

    let itemState = currentItem.state;
    let actionRequired: string | undefined;
    let pendingRepositoryKeys: string[] | undefined;
    let pendingTestKeys: string[] | undefined;

    if (requiresObservedTestEvidence && !testEvidence.complete) {
      actionRequired = input.purpose === 'GREEN'
        ? 'GREEN_TEST_EVIDENCE_INCOMPLETE'
        : `${input.purpose}_TEST_EVIDENCE_INCOMPLETE`;
      pendingTestKeys = [...testEvidence.missingKeys, ...testEvidence.failedKeys];
    }

    if (input.purpose === 'RED' && classification.resultKind === 'TEST_FAILURE') {
      if (classification.redEvidenceKind === 'STRUCTURAL' && !input.reason?.trim()) {
        actionRequired = 'STRUCTURAL_RED_REASON_REQUIRED';
      } else {
        const updated = await this.ledger.transitionWorkItem({
          projectKey: input.projectKey,
          featureKey: input.featureKey,
          itemKey: input.itemKey,
          to: 'RED_CONFIRMED',
          reason: input.reason ?? 'RED comportamental confirmado automaticamente',
          executionFence: input.executionFence,
        });
        itemState = updated.state;
      }
    }

    if (input.purpose === 'GREEN' && classification.resultKind === 'PASS' && testEvidence.complete) {
      try {
        const updated = await this.ledger.transitionWorkItem({
          projectKey: input.projectKey,
          featureKey: input.featureKey,
          itemKey: input.itemKey,
          to: 'GREEN_CONFIRMED',
          reason: 'GREEN confirmado automaticamente',
          executionFence: input.executionFence,
        });
        itemState = updated.state;
      } catch (error) {
        if (!(error instanceof WorkflowTransitionError) || ![
          'GREEN_EVIDENCE_INCOMPLETE',
          'VALIDATION_EVIDENCE_INCOMPLETE',
        ].includes(error.code)) {
          throw error;
        }

        actionRequired = Array.isArray(error.details?.pendingTestKeys)
          ? 'GREEN_TEST_EVIDENCE_INCOMPLETE'
          : 'GREEN_REPOSITORIES_PENDING';
        pendingRepositoryKeys = Array.isArray(error.details?.pendingRepositoryKeys)
          ? error.details.pendingRepositoryKeys.filter((key): key is string => typeof key === 'string')
          : undefined;
        pendingTestKeys = Array.isArray(error.details?.pendingTestKeys)
          ? error.details.pendingTestKeys.filter((key): key is string => typeof key === 'string')
          : pendingTestKeys;
      }
    }

    return {
      validation,
      classification,
      request,
      reused: false,
      itemState,
      actionRequired,
      pendingRepositoryKeys,
      pendingTestKeys,
    };
  }

  private async findReusableGreen(
    workItemId: string,
    profileId: string,
    fingerprint: string,
    contentFingerprint?: string,
    testPlanFingerprint?: string,
    profileFingerprint?: string,
    requiresCompleteTestEvidence = false,
    requiredTestKeys: string[] = [],
  ) {
    const [allValidations, lastInvalidation] = await Promise.all([
      this.db.validationRun.findMany({
        where: {
          workItemId,
          profileId,
          purpose: 'GREEN',
          resultKind: 'PASS',
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      this.db.workflowEvent.findFirst({
        where: { workItemId, type: 'GREEN_INVALIDATED' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    const invalidationPayload = lastInvalidation
      ? decodeJson<{ invalidatedThroughValidationId?: string }>(lastInvalidation.payloadJson, {})
      : {};
    const boundaryIndex = invalidationPayload.invalidatedThroughValidationId
      ? allValidations.findIndex((validation) => (
          validation.id === invalidationPayload.invalidatedThroughValidationId
        ))
      : -1;
    const validations = !lastInvalidation
      ? allValidations
      : boundaryIndex >= 0
        ? allValidations.slice(0, boundaryIndex)
        : allValidations.filter((validation) => validation.createdAt > lastInvalidation.createdAt);

    return validations.find((validation) => {
      const summary = decodeJson<{
        fingerprint?: string;
        contentFingerprint?: string;
        testPlanFingerprint?: string;
        profileFingerprint?: string;
        testEvidence?: { complete?: boolean };
        coveredTestResults?: Array<{ key: string; status: ObservedTestStatus }>;
      }>(
        validation.summaryJson,
        {},
      );

      const sameSnapshot = summary.contentFingerprint && contentFingerprint
        ? summary.contentFingerprint === contentFingerprint
        : summary.fingerprint === fingerprint;
      const samePlan = !testPlanFingerprint || summary.testPlanFingerprint === testPlanFingerprint;
      const sameProfile = !profileFingerprint || summary.profileFingerprint === profileFingerprint;
      const results = new Map((summary.coveredTestResults ?? []).map((test) => [test.key, test.status]));
      const requiredTestsCovered = requiredTestKeys.every((key) => results.get(key) === 'PASSED');
      const testEvidenceComplete = !requiresCompleteTestEvidence || summary.testEvidence?.complete === true;
      return sameSnapshot && samePlan && sameProfile && requiredTestsCovered && testEvidenceComplete;
    });
  }
}

export function createCommandRunner(): CommandRunner {
  return {
    run: runCommand,
  };
}

export function buildValidationCommand(
  program: string,
  args: string[],
): Pick<CommandRequest, 'executable' | 'args'> {
  // When a validation is itself launched through rtk, the direct node path
  // can lose piped stdout/stderr. `proxy` keeps the profile output available
  // to the parser without changing the registered command or its allowlist.
  return {
    executable: 'rtk',
    args: program === 'node' ? ['proxy', program, ...args] : [program, ...args],
  };
}

function runCommand(request: CommandRequest): Promise<CommandResult> {
  return new Promise((resolve) => {
    let child: ChildProcess | undefined;
    let settled = false;
    let timedOut = false;
    let outputLimitExceeded = false;
    let totalBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timeoutHandle: NodeJS.Timeout | undefined;
    let killHandle: NodeJS.Timeout | undefined;

    const finish = (result: CommandResult) => {
      if (settled) {
        return;
      }

      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (killHandle) {
        clearTimeout(killHandle);
      }
      resolve(result);
    };

    const append = (target: Buffer[], chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(request.maxOutputBytes - totalBytes, 0);

      if (remaining > 0) {
        target.push(buffer.subarray(0, remaining));
      }

      totalBytes += buffer.length;
      if (totalBytes > request.maxOutputBytes && !outputLimitExceeded) {
        outputLimitExceeded = true;
        child?.kill('SIGTERM');
      }
    };

    try {
      child = spawn(request.executable, request.args, {
        cwd: request.cwd,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    child.stdout?.on('data', (chunk: Buffer | string) => append(stdout, chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => append(stderr, chunk));
    child.once('error', (error) => {
      finish({
        exitCode: null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        error: outputLimitExceeded ? 'OUTPUT_LIMIT_EXCEEDED' : error.message,
      });
    });
    child.once('close', (exitCode) => {
      finish({
        exitCode,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        timedOut,
        error: outputLimitExceeded ? 'OUTPUT_LIMIT_EXCEEDED' : undefined,
      });
    });

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      killHandle = setTimeout(() => child.kill('SIGKILL'), 250);
    }, request.timeoutMs);
  });
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertPurposeState(purpose: ExecuteValidationInput['purpose'], state: string): void {
  if (purpose === 'RED' && state !== 'TESTS_DEFINED') {
    fail('VALIDATION_PURPOSE_STATE_INVALID', 'RED exige TESTS_DEFINED; retorne para esse estado após CHANGES_REQUIRED');
  }

  if (purpose === 'GREEN' && state !== 'IMPLEMENTING') {
    fail('VALIDATION_PURPOSE_STATE_INVALID', 'GREEN exige IMPLEMENTING');
  }

  if (purpose === 'CHECK' && state === 'CLOSED') {
    fail('VALIDATION_PURPOSE_STATE_INVALID', 'CHECK não é executado em item fechado');
  }
}
