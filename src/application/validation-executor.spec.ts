import { gunzipSync } from 'node:zlib';

import type { PrismaClient } from '@prisma/client';

import type { CommandRequest, CommandRunner, GitReadPort } from './types.js';
import {
  classifyCommandResult,
  classifyRedEvidence,
  createCommandRunner,
  ValidationExecutor,
} from './validation-executor.js';
import { WorkflowLedger } from './workflow-ledger.js';
import { createTestDatabase, type TestDatabase } from '../infrastructure/db/test-database.js';

describe('validation executor', () => {
  describe('classifyCommandResult', () => {
    it('classifies a Jest non-zero result with test output as a test failure', () => {
      expect(
        classifyCommandResult(
          {
            exitCode: 1,
            stdout: 'Test Suites: 1 failed, 1 total\nTests: 1 failed, 1 total',
            stderr: '',
            timedOut: false,
          },
          'JEST',
        ),
      ).toEqual({ status: 'COMPLETED', resultKind: 'TEST_FAILURE' });
    });

    it('keeps timeout and infrastructure failures distinct', () => {
      expect(
        classifyCommandResult(
          { exitCode: null, stdout: '', stderr: '', timedOut: true },
          'JEST',
        ),
      ).toEqual({ status: 'TIMED_OUT', resultKind: 'TIMEOUT' });
      expect(
        classifyCommandResult(
          { exitCode: null, stdout: '', stderr: '', timedOut: false, error: 'spawn failed' },
          'GENERIC',
        ),
      ).toEqual({ status: 'FAILED_TO_START', resultKind: 'INFRASTRUCTURE_ERROR' });
    });

    it('does not call a Jest assertion a test failure when the runner lacks Jest output', () => {
      expect(
        classifyCommandResult({
          exitCode: 1,
          stdout: 'Error: Cannot find module',
          stderr: '',
          timedOut: false,
        }, 'JEST'),
      ).toEqual({ status: 'COMPLETED', resultKind: 'INFRASTRUCTURE_ERROR' });
      expect(
        classifyCommandResult({
          exitCode: 2,
          stdout: 'validator reported an invalid result',
          stderr: '',
          timedOut: false,
        }, 'GENERIC'),
      ).toEqual({ status: 'COMPLETED', resultKind: 'TEST_FAILURE' });
    });

    it('distinguishes a behavioral RED from a structural RED', () => {
      expect(classifyRedEvidence(
        'Test Suites: 1 failed, 1 total\nTests: 1 failed, 3 total',
        'JEST',
      )).toEqual({ redEvidenceKind: 'BEHAVIORAL', testsTotal: 3 });
      expect(classifyRedEvidence(
        'Test Suites: 1 failed, 1 total\nTests: 0 total\nCannot find module',
        'JEST',
      )).toEqual({ redEvidenceKind: 'STRUCTURAL', testsTotal: 0 });
    });
  });

  it('caps process output and terminates a timed-out child without a shell', async () => {
    const runner = createCommandRunner();
    const output = await runner.run({
      executable: 'printf',
      args: ['%s', 'x'.repeat(4_096)],
      cwd: process.cwd(),
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
    });
    expect(output.error).toBe('OUTPUT_LIMIT_EXCEEDED');
    expect(Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr)).toBeLessThanOrEqual(1_024);

    const timeout = await runner.run({
      executable: 'sleep',
      args: ['1'],
      cwd: process.cwd(),
      timeoutMs: 50,
      maxOutputBytes: 1_024,
    });
    expect(timeout.timedOut).toBe(true);
  });

  describe('run', () => {
    let database: TestDatabase;
    let client: PrismaClient;
    let ledger: WorkflowLedger;
    let executor: ValidationExecutor;
    let requests: CommandRequest[];
    let currentFingerprint: string;
    let nextResult: {
      exitCode: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
      error?: string;
    };

    beforeAll(async () => {
      database = createTestDatabase();
      client = database.client;
      currentFingerprint = 'fingerprint-1';
      const git: GitReadPort = {
        capture: async () => ({
          branch: 'dev',
          sha: 'sha-1',
          dirty: false,
          changedFiles: [],
          fingerprint: currentFingerprint,
        }),
      };
      ledger = new WorkflowLedger(client, git);
      requests = [];
      nextResult = {
        exitCode: 1,
        stdout: 'Test Suites: 1 failed, 1 total\nTests: 1 failed, 1 total',
        stderr: '',
        timedOut: false,
      };
      const runner: CommandRunner = {
        run: async (request) => {
          requests.push(request);
          return nextResult;
        },
      };
      executor = new ValidationExecutor(client, ledger, git, runner);

      await ledger.createProject({
        key: 'carara',
        name: 'Carará',
        rootPath: '/tmp/carara',
      });
      await ledger.addRepository({
        projectKey: 'carara',
        key: 'api',
        path: '/tmp/carara/api',
      });
      await ledger.createTemplate({
        projectKey: 'carara',
        key: 'default',
        name: 'Default',
        definition: { phases: ['G0', 'G1'] },
      });
      await ledger.createFeature({
        projectKey: 'carara',
        templateKey: 'default',
        key: 'E6',
        name: 'Assistentes',
        summary: 'Runtime',
      });
      await ledger.defineWorkItem({
        projectKey: 'carara',
        featureKey: 'E6',
        key: '01',
        phaseKey: 'G1',
        position: 1,
        title: 'Fatia',
        useCases: [
          {
            key: 'UC-01',
            title: 'Executar',
            actor: 'agent',
            preconditions: 'item autorizado',
            trigger: 'comando',
            expectedOutcome: 'resultado',
          },
        ],
        criteria: [{ key: 'AC-01', statement: 'Valida o resultado' }],
        tests: [{ key: 'T-RED', name: 'falha esperada', purpose: 'RED' }],
      });
      await ledger.transitionWorkItem({
        projectKey: 'carara',
        featureKey: 'E6',
        itemKey: '01',
        to: 'READY',
      });
      await ledger.authorizeWorkItem({
        projectKey: 'carara',
        featureKey: 'E6',
        itemKey: '01',
        instruction: 'executar fatia',
        actor: 'owner',
        allowedEffects: ['código'],
        forbiddenEffects: ['produção'],
        repositoryKeys: ['api'],
      });
      await ledger.transitionWorkItem({
        projectKey: 'carara',
        featureKey: 'E6',
        itemKey: '01',
        to: 'TESTS_DEFINED',
      });
      await ledger.createValidationProfile({
        projectKey: 'carara',
        repositoryKey: 'api',
        key: 'related',
        program: 'npm',
        args: ['test', '--', 'src/feature.spec.ts'],
        cwd: '.',
        parser: 'JEST',
      });
    });

    beforeEach(async () => {
      requests.length = 0;
      currentFingerprint = 'fingerprint-1';
      nextResult = {
        exitCode: 1,
        stdout: 'Test Suites: 1 failed, 1 total\nTests: 1 failed, 1 total',
        stderr: '',
        timedOut: false,
      };
      await client.validationRun.deleteMany();
      await client.workItem.updateMany({
        where: { key: '01', feature: { key: 'E6' } },
        data: { state: 'TESTS_DEFINED', currentSha: 'sha-1' },
      });
    });

    afterAll(async () => {
      await database.close();
    });

    it('runs the registered profile through rtk and records RED without raw output in the summary', async () => {
      const result = await executor.run({
        projectKey: 'carara',
        featureKey: 'E6',
        itemKey: '01',
        repositoryKey: 'api',
        profileKey: 'related',
        purpose: 'RED',
      });

      expect(result.validation.resultKind).toBe('TEST_FAILURE');
      expect(requests[0]).toMatchObject({
        executable: 'rtk',
        args: ['npm', 'test', '--', 'src/feature.spec.ts'],
        cwd: '/tmp/carara/api',
      });
      expect(result.validation.summaryJson).not.toContain('Test Suites:');
      expect(result.validation.logBlob).toBeInstanceOf(Uint8Array);
      expect(result.classification.redEvidenceKind).toBe('BEHAVIORAL');
      expect(result.itemState).toBe('RED_CONFIRMED');
      await expect(client.workItem.findFirstOrThrow({ where: { key: '01' } }))
        .resolves.toMatchObject({ state: 'RED_CONFIRMED' });
    });

    it('keeps a structural RED pending until the agent explains it', async () => {
      nextResult = {
        exitCode: 1,
        stdout: 'Test Suites: 1 failed, 1 total\nTests: 0 total\nCannot find module',
        stderr: '',
        timedOut: false,
      };

      const pending = await executor.run({
        projectKey: 'carara',
        featureKey: 'E6',
        itemKey: '01',
        repositoryKey: 'api',
        profileKey: 'related',
        purpose: 'RED',
      });
      expect(pending.classification.redEvidenceKind).toBe('STRUCTURAL');
      expect(pending.itemState).toBe('TESTS_DEFINED');
      expect(pending.actionRequired).toBe('STRUCTURAL_RED_REASON_REQUIRED');

      const confirmed = await executor.run({
        projectKey: 'carara',
        featureKey: 'E6',
        itemKey: '01',
        repositoryKey: 'api',
        profileKey: 'related',
        purpose: 'RED',
        reason: 'o módulo testado ainda não existe',
      });
      expect(confirmed.itemState).toBe('RED_CONFIRMED');
    });

    it('advances GREEN automatically and reuses it for an identical CHECK', async () => {
      await client.workItem.updateMany({
        where: { key: '01', feature: { key: 'E6' } },
        data: { state: 'IMPLEMENTING' },
      });
      nextResult = {
        exitCode: 0,
        stdout: 'Test Suites: 2 passed, 2 total\nTests: 4 passed, 4 total',
        stderr: '',
        timedOut: false,
      };

      const green = await executor.run({
        projectKey: 'carara',
        featureKey: 'E6',
        itemKey: '01',
        repositoryKey: 'api',
        profileKey: 'related',
        purpose: 'GREEN',
      });
      expect(green.itemState).toBe('GREEN_CONFIRMED');
      await ledger.transitionWorkItem({
        projectKey: 'carara',
        featureKey: 'E6',
        itemKey: '01',
        to: 'READY_FOR_REVIEW',
      });

      const callsBeforeCheck = requests.length;
      const check = await executor.run({
        projectKey: 'carara',
        featureKey: 'E6',
        itemKey: '01',
        repositoryKey: 'api',
        profileKey: 'related',
        purpose: 'CHECK',
      });
      expect(requests).toHaveLength(callsBeforeCheck);
      expect(check.reused).toBe(true);
      expect(check.validation.durationMs).toBe(0);
      expect(JSON.parse(check.validation.summaryJson)).toMatchObject({
        reusedFromPurpose: 'GREEN',
        fingerprint: 'fingerprint-1',
      });

      currentFingerprint = 'fingerprint-2';
      const changedCheck = await executor.run({
        projectKey: 'carara',
        featureKey: 'E6',
        itemKey: '01',
        repositoryKey: 'api',
        profileKey: 'related',
        purpose: 'CHECK',
      });
      expect(requests).toHaveLength(callsBeforeCheck + 1);
      expect(changedCheck.reused).toBe(false);
    });

    it('rejects a purpose that does not match the item state before invoking the runner', async () => {
      const callsBefore = requests.length;

      await expect(executor.run({
        projectKey: 'carara',
        featureKey: 'E6',
        itemKey: '01',
        repositoryKey: 'api',
        profileKey: 'related',
        purpose: 'GREEN',
      })).rejects.toMatchObject({ code: 'VALIDATION_PURPOSE_STATE_INVALID' });
      expect(requests).toHaveLength(callsBefore);
    });

    it('bounds the persisted log and records timeout without pretending it passed', async () => {
      await ledger.createValidationProfile({
        projectKey: 'carara',
        repositoryKey: 'api',
        key: 'bounded',
        program: 'npm',
        args: ['test'],
        parser: 'GENERIC',
        maxOutputBytes: 1_024,
      });
      nextResult = {
        exitCode: 1,
        stdout: 'x'.repeat(4_096),
        stderr: 'stderr',
        timedOut: false,
      };
      const failed = await executor.run({
        projectKey: 'carara',
        featureKey: 'E6',
        itemKey: '01',
        repositoryKey: 'api',
        profileKey: 'bounded',
        purpose: 'RED',
      });
      expect(failed.validation.resultKind).toBe('TEST_FAILURE');
      expect(gunzipSync(Buffer.from(failed.validation.logBlob as Uint8Array)).byteLength)
        .toBeLessThanOrEqual(1_024);

      nextResult = {
        exitCode: null,
        stdout: '',
        stderr: '',
        timedOut: true,
      };
      await client.workItem.updateMany({
        where: { key: '01', feature: { key: 'E6' } },
        data: { state: 'TESTS_DEFINED' },
      });
      const timeout = await executor.run({
        projectKey: 'carara',
        featureKey: 'E6',
        itemKey: '01',
        repositoryKey: 'api',
        profileKey: 'bounded',
        purpose: 'RED',
      });
      expect(timeout.validation.status).toBe('TIMED_OUT');
      expect(timeout.validation.resultKind).toBe('TIMEOUT');
    });

    it('rejects a profile working directory that escapes its repository', async () => {
      const repository = await client.repository.findFirstOrThrow();
      await client.validationProfile.create({
        data: {
          repositoryId: repository.id,
          key: 'escape',
          program: 'npm',
          argsJson: JSON.stringify(['test']),
          cwd: '../outside',
          parser: 'JEST',
        },
      });

      await expect(executor.run({
        projectKey: 'carara',
        featureKey: 'E6',
        itemKey: '01',
        repositoryKey: 'api',
        profileKey: 'escape',
        purpose: 'RED',
      })).rejects.toMatchObject({ code: 'VALIDATION_CWD_INVALID' });
    });
  });
});
