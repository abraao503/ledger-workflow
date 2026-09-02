import type { PrismaClient } from '@prisma/client';

import { GitReadPort, CommandRequest, CommandRunner } from './types.js';
import {
  classifyCommandResult,
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
  });

  describe('run', () => {
    let database: TestDatabase;
    let client: PrismaClient;
    let ledger: WorkflowLedger;
    let executor: ValidationExecutor;
    let requests: CommandRequest[];
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
      const git: GitReadPort = {
        capture: async () => ({
          branch: 'dev',
          sha: 'sha-1',
          dirty: false,
          changedFiles: [],
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
    });
  });
});
