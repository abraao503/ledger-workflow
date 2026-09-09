import { spawn, type ChildProcess } from 'node:child_process';
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
} from './types.js';
import { WorkflowLedger } from './workflow-ledger.js';

type ValidationParser = 'JEST' | 'GENERIC';
type ValidationStatus = 'COMPLETED' | 'TIMED_OUT' | 'FAILED_TO_START';
type ValidationResultKind = 'PASS' | 'TEST_FAILURE' | 'INFRASTRUCTURE_ERROR' | 'TIMEOUT';

export type ValidationClassification = {
  status: ValidationStatus;
  resultKind: ValidationResultKind;
  redEvidenceKind?: 'BEHAVIORAL' | 'STRUCTURAL';
  testsTotal?: number;
};

export function classifyRedEvidence(
  output: string,
  parser: ValidationParser,
): Pick<ValidationClassification, 'redEvidenceKind' | 'testsTotal'> {
  if (parser !== 'JEST') {
    return { redEvidenceKind: 'BEHAVIORAL' };
  }

  const tests = output.match(/Tests:\s+.*?(\d+)\s+total/i);
  const testsTotal = tests ? Number(tests[1]) : 0;

  return {
    redEvidenceKind: testsTotal > 0 ? 'BEHAVIORAL' : 'STRUCTURAL',
    testsTotal,
  };
}

export function classifyCommandResult(
  result: CommandResult,
  parser: ValidationParser,
): ValidationClassification {
  if (result.timedOut) {
    return { status: 'TIMED_OUT', resultKind: 'TIMEOUT' };
  }

  if (result.error || result.exitCode === null) {
    return { status: 'FAILED_TO_START', resultKind: 'INFRASTRUCTURE_ERROR' };
  }

  if (result.exitCode === 0) {
    return { status: 'COMPLETED', resultKind: 'PASS' };
  }

  const output = `${result.stdout}\n${result.stderr}`;
  const hasJestTestReport = /(?:Test Suites|Tests):\s+.*(?:failed|passed|total)/i.test(output);
  const hasKnownJestStructuralFailure = parser === 'JEST' && (
    /No tests found/i.test(output) ||
    /Your test suite must contain at least one test/i.test(output)
  );

  if (parser === 'GENERIC' || hasJestTestReport || hasKnownJestStructuralFailure) {
    return { status: 'COMPLETED', resultKind: 'TEST_FAILURE' };
  }

  return { status: 'COMPLETED', resultKind: 'INFRASTRUCTURE_ERROR' };
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
    const coveredTests = await this.db.testSpecification.findMany({
      where: {
        workItemId: currentItem.id,
        purpose: input.purpose,
        OR: [
          { runnerProfileKey: null },
          { runnerProfileKey: input.profileKey },
        ],
      },
      select: { key: true },
      orderBy: { key: 'asc' },
    });

    if (input.purpose === 'CHECK') {
      const reusableGreen = await this.findReusableGreen(
        currentItem.id,
        currentProfile.id,
        snapshotBefore.fingerprint,
        snapshotBefore.contentFingerprint,
      );

      if (reusableGreen) {
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
            fingerprint: snapshotBefore.fingerprint,
            ...(snapshotBefore.contentFingerprint
              ? { contentFingerprint: snapshotBefore.contentFingerprint }
              : {}),
            dirty: snapshotBefore.dirty,
            changedFileCount: snapshotBefore.changedFiles.length,
            coveredTestKeys: coveredTests.map((test) => test.key),
            reusedFromValidationId: reusableGreen.id,
            reusedFromPurpose: 'GREEN',
          },
        });

        return {
          validation,
          classification: { status: 'COMPLETED', resultKind: 'PASS' } as ValidationClassification,
          reused: true,
          itemState: currentItem.state,
          pendingRepositoryKeys: undefined,
        };
      }
    }

    const args = [
      currentProfile.program,
      ...decodeJson<string[]>(currentProfile.argsJson, []),
    ];
    const request: CommandRequest = {
      executable: 'rtk',
      args,
      cwd: workingDirectory,
      timeoutMs: currentProfile.timeoutSeconds * 1_000,
      maxOutputBytes: currentProfile.maxOutputBytes,
    };
    const startedAt = Date.now();
    const commandResult = await this.runner.run(request);
    const durationMs = Date.now() - startedAt;
    const parser: ValidationParser = currentProfile.parser === 'JEST' ? 'JEST' : 'GENERIC';
    const snapshotAfter = await this.git.capture(repositoryPath);
    const baseClassification = classifyCommandResult(commandResult, parser);
    const worktreeChanged = snapshotBefore.fingerprint !== snapshotAfter.fingerprint;
    const classification: ValidationClassification = worktreeChanged
      ? { status: 'COMPLETED', resultKind: 'INFRASTRUCTURE_ERROR' }
      : {
          ...baseClassification,
          ...(input.purpose === 'RED' && baseClassification.resultKind === 'TEST_FAILURE'
            ? classifyRedEvidence(`${commandResult.stdout}\n${commandResult.stderr}`, parser)
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
        coveredTestKeys: coveredTests.map((test) => test.key),
        redEvidenceKind: classification.redEvidenceKind,
        testsTotal: classification.testsTotal,
      },
      log: `${commandResult.stdout}${commandResult.stderr ? `\n${commandResult.stderr}` : ''}`,
    });

    let itemState = currentItem.state;
    let actionRequired: string | undefined;
    let pendingRepositoryKeys: string[] | undefined;

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
        });
        itemState = updated.state;
      }
    }

    if (input.purpose === 'GREEN' && classification.resultKind === 'PASS') {
      try {
        const updated = await this.ledger.transitionWorkItem({
          projectKey: input.projectKey,
          featureKey: input.featureKey,
          itemKey: input.itemKey,
          to: 'GREEN_CONFIRMED',
          reason: 'GREEN confirmado automaticamente',
        });
        itemState = updated.state;
      } catch (error) {
        if (!(error instanceof WorkflowTransitionError) || error.code !== 'GREEN_EVIDENCE_INCOMPLETE') {
          throw error;
        }

        actionRequired = 'GREEN_REPOSITORIES_PENDING';
        pendingRepositoryKeys = Array.isArray(error.details?.pendingRepositoryKeys)
          ? error.details.pendingRepositoryKeys.filter((key): key is string => typeof key === 'string')
          : undefined;
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
    };
  }

  private async findReusableGreen(
    workItemId: string,
    profileId: string,
    fingerprint: string,
    contentFingerprint?: string,
  ) {
    const validations = await this.db.validationRun.findMany({
      where: {
        workItemId,
        profileId,
        purpose: 'GREEN',
        resultKind: 'PASS',
      },
      orderBy: { createdAt: 'desc' },
    });

    return validations.find((validation) => {
      const summary = decodeJson<{ fingerprint?: string; contentFingerprint?: string }>(
        validation.summaryJson,
        {},
      );

      return summary.contentFingerprint && contentFingerprint
        ? summary.contentFingerprint === contentFingerprint
        : summary.fingerprint === fingerprint;
    });
  }
}

export function createCommandRunner(): CommandRunner {
  return {
    run: runCommand,
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
