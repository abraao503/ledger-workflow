import { Command } from 'commander';

import { WorkflowApplicationError } from '../../application/errors.js';
import type { WorkflowApp } from '../../application/workflow-app.js';
import { parseWorkflowImport } from '../../application/workflow-importer.js';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

type Output = {
  write: (value: string) => boolean;
};

export type CliDependencies = {
  app: WorkflowApp;
  stdout?: Output;
};

export function createCli({ app, stdout = process.stdout }: CliDependencies): Command {
  const program = new Command();

  program
    .name('workflow')
    .description('Ledger local de execução para fluxos de implementação')
    .option('--json', 'emite a resposta como JSON')
    .showHelpAfterError();

  const project = program.command('project').description('Gerencia projetos');
  project
    .command('create')
    .requiredOption('--key <key>')
    .requiredOption('--name <name>')
    .requiredOption('--root <path>')
    .action(async (options, command) => {
      emit(command, await app.ledger.createProject({
        key: options.key,
        name: options.name,
        rootPath: options.root,
      }), stdout);
    });

  const repository = program.command('repository').description('Gerencia repositórios registrados');
  repository
    .command('add')
    .requiredOption('--project <key>')
    .requiredOption('--key <key>')
    .requiredOption('--path <path>')
    .option('--branch <branch>')
    .action(async (options, command) => {
      emit(command, await app.ledger.addRepository({
        projectKey: options.project,
        key: options.key,
        path: options.path,
        expectedBranch: options.branch,
      }), stdout);
    });

  const template = program.command('template').description('Gerencia templates versionados');
  template
    .command('create')
    .requiredOption('--project <key>')
    .requiredOption('--key <key>')
    .requiredOption('--name <name>')
    .requiredOption('--definition <json>')
    .action(async (options, command) => {
      emit(command, await app.ledger.createTemplate({
        projectKey: options.project,
        key: options.key,
        name: options.name,
        definition: parseJson(options.definition, 'definition'),
      }), stdout);
    });

  const feature = program.command('feature').description('Gerencia features');
  feature
    .command('create')
    .requiredOption('--project <key>')
    .requiredOption('--template <key>')
    .option('--version <number>', 'template version', parseNumber)
    .requiredOption('--key <key>')
    .requiredOption('--name <name>')
    .requiredOption('--summary <summary>')
    .action(async (options, command) => {
      emit(command, await app.ledger.createFeature({
        projectKey: options.project,
        templateKey: options.template,
        templateVersion: options.version,
        key: options.key,
        name: options.name,
        summary: options.summary,
      }), stdout);
    });

  const item = program.command('item').description('Define, autoriza e avança fatias');
  item
    .command('define')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--key <key>')
    .requiredOption('--phase <key>')
    .requiredOption('--position <number>', 'posição da fatia', parseNumber)
    .requiredOption('--title <title>')
    .option('--kind <kind>', 'CODE|DOCUMENTATION|VALIDATION|OTHER', 'CODE')
    .option('--summary <summary>')
    .option('--tdd <policy>', 'REQUIRED|OPTIONAL|EXEMPT')
    .requiredOption('--use-cases <json>')
    .requiredOption('--criteria <json>')
    .requiredOption('--tests <json>')
    .action(async (options, command) => {
      emit(command, await app.ledger.defineWorkItem({
        projectKey: options.project,
        featureKey: options.feature,
        key: options.key,
        phaseKey: options.phase,
        position: options.position,
        title: options.title,
        kind: options.kind,
        summary: options.summary,
        tddPolicy: options.tdd,
        useCases: parseJson(options.useCases, 'use-cases'),
        criteria: parseJson(options.criteria, 'criteria'),
        tests: parseJson(options.tests, 'tests'),
      }), stdout);
    });

  item
    .command('authorize')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .requiredOption('--instruction <text>')
    .requiredOption('--actor <actor>')
    .requiredOption('--repositories <keys>', 'chaves separadas por vírgula')
    .option('--allowed <effects>', 'efeitos separados por vírgula', '')
    .option('--forbidden <effects>', 'efeitos separados por vírgula', '')
    .action(async (options, command) => {
      emit(command, await app.ledger.authorizeWorkItem({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        instruction: options.instruction,
        actor: options.actor,
        allowedEffects: splitCsv(options.allowed),
        forbiddenEffects: splitCsv(options.forbidden),
        repositoryKeys: splitCsv(options.repositories),
      }), stdout);
    });

  item
    .command('transition')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .requiredOption('--to <state>')
    .option('--reason <reason>')
    .option('--commit <sha>')
    .action(async (options, command) => {
      emit(command, await app.ledger.transitionWorkItem({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        to: options.to,
        reason: options.reason,
        commitSha: options.commit,
      }), stdout);
    });

  const validationProfile = program
    .command('validation-profile')
    .description('Registra comandos de validação allowlistados');
  validationProfile
    .command('add')
    .requiredOption('--project <key>')
    .requiredOption('--repository <key>')
    .requiredOption('--key <key>')
    .requiredOption('--program <program>')
    .requiredOption('--args <json>')
    .option('--cwd <path>', '.',)
    .option('--parser <parser>', 'JEST|GENERIC', 'JEST')
    .option('--timeout <seconds>', 'timeout em segundos', parseNumber)
    .option('--max-output <bytes>', 'limite de saída em bytes', parseNumber)
    .action(async (options, command) => {
      emit(command, await app.ledger.createValidationProfile({
        projectKey: options.project,
        repositoryKey: options.repository,
        key: options.key,
        program: options.program,
        args: parseJson(options.args, 'args'),
        cwd: options.cwd,
        parser: options.parser,
        timeoutSeconds: options.timeout,
        maxOutputBytes: options.maxOutput,
      }), stdout);
    });

  const validate = program.command('validate').description('Executa e registra validações');
  validate
    .command('run')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .requiredOption('--repository <key>')
    .requiredOption('--profile <key>')
    .requiredOption('--purpose <purpose>', 'RED|GREEN|CHECK')
    .action(async (options, command) => {
      const result = await app.validation.run({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        repositoryKey: options.repository,
        profileKey: options.profile,
        purpose: options.purpose,
      });
      emit(command, {
        id: result.validation.id,
        status: result.validation.status,
        resultKind: result.validation.resultKind,
        sha: result.validation.sha,
        durationMs: result.validation.durationMs,
        classification: result.classification,
      }, stdout);
    });

  const review = program.command('review').description('Registra revisão');
  review
    .command('submit')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .requiredOption('--reviewer <name>')
    .requiredOption('--verdict <verdict>', 'APPROVED|CHANGES_REQUIRED|BLOCKED')
    .requiredOption('--summary <summary>')
    .option('--findings <json>', '[]')
    .action(async (options, command) => {
      emit(command, await app.ledger.submitReview({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        reviewer: options.reviewer,
        verdict: options.verdict,
        summary: options.summary,
        findings: parseJson(options.findings, 'findings'),
      }), stdout);
    });

  program
    .command('context')
    .requiredOption('--project <key>')
    .option('--feature <key>')
    .option('--item <key>')
    .option('--max-chars <number>', 'limite do contexto', parseNumber)
    .action(async (options, command) => {
      emit(command, await app.ledger.getContext({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        maxChars: options.maxChars,
      }), stdout);
    });

  program
    .command('compact')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--active <item-key>')
    .option('--keep-recent <number>', 'quantidade de fatias recentes', parseNumber, 2)
    .action(async (options, command) => {
      emit(command, await app.ledger.compactHistory({
        projectKey: options.project,
        featureKey: options.feature,
        activeItemKey: options.active,
        keepRecent: options.keepRecent,
      }), stdout);
    });

  program
    .command('purge-logs')
    .action(async (_options, command) => {
      emit(command, await app.ledger.purgeExpiredLogs(), stdout);
    });

  program
    .command('doctor')
    .action(async (_options, command) => {
      await app.db.$queryRaw`SELECT 1`;
      emit(command, { ok: true, database: 'sqlite' }, stdout);
    });

  program
    .command('import')
    .description('Importa um documento estruturado de workflow uma única vez')
    .requiredOption('--file <path>')
    .action(async (options, command) => {
      const content = await readFile(path.resolve(options.file), 'utf8');
      const document = parseWorkflowImport(JSON.parse(content) as unknown);
      emit(command, await app.importer.import(document), stdout);
    });

  program
    .command('import-carara')
    .description('Importa o snapshot estruturado inicial do Carará')
    .option('--root <path>', 'raiz do workspace')
    .action(async (options, command) => {
      const workspaceRoot = options.root
        ? path.resolve(options.root)
        : path.basename(process.cwd()) === 'workflow'
          ? path.resolve(process.cwd(), '..')
          : process.cwd();
      const { createCararaImport } = await import('../../application/carara-import.js');
      emit(command, await app.importer.import(createCararaImport(workspaceRoot)), stdout);
    });

  return program;
}

function parseNumber(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new WorkflowApplicationError('NUMBER_INVALID', `Número inválido: ${value}`);
  }

  return parsed;
}

function parseJson<T>(value: string, field: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new WorkflowApplicationError(
      'JSON_INVALID',
      `JSON inválido em ${field}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function splitCsv(value: string): string[] {
  return value.split(',').map((entry) => entry.trim()).filter(Boolean);
}

function emit(command: Command, value: unknown, stdout: Output): void {
  const options = command.optsWithGlobals<{ json?: boolean }>();
  const output = options.json ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  stdout.write(`${output}\n`);
}
