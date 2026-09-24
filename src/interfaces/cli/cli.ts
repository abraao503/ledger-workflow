import { Command } from 'commander';

import { WorkflowApplicationError } from '../../application/errors.js';
import type { WorkflowApp } from '../../application/workflow-app.js';
import { parseWorkflowImport } from '../../application/workflow-importer.js';
import { createE2EPreflight } from '../../application/cycle-metrics.js';
import { formatValidationResult } from '../validation-output.js';
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

  project
    .command('list')
    .description('Lista projetos registrados no ledger')
    .action(async (options, command) => {
      emit(command, await app.ledger.listProjects(), stdout);
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

  repository
    .command('list')
    .description('Lista repositórios em formato compacto; use --include-profiles para detalhes')
    .requiredOption('--project <key>')
    .option('--repository <key>', 'restringe a um repositório')
    .option('--include-profiles', 'inclui comandos completos dos perfis ativos')
    .action(async (options, command) => {
      emit(command, await app.ledger.listRepositories({
        projectKey: options.project,
        repositoryKey: options.repository,
        includeProfiles: options.includeProfiles ?? false,
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

  feature
    .command('list')
    .description('Lista features em formato compacto; use --include-items para as fatias')
    .requiredOption('--project <key>')
    .option('--feature <key>', 'restringe a uma feature')
    .option('--include-items', 'inclui as fatias e estados da feature')
    .action(async (options, command) => {
      emit(command, await app.ledger.listFeatures({
        projectKey: options.project,
        featureKey: options.feature,
        includeItems: options.includeItems ?? false,
      }), stdout);
    });

  feature
    .command('show')
    .description('Mostra uma feature específica com suas fatias')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .action(async (options, command) => {
      emit(command, await app.ledger.listFeatures({
        projectKey: options.project,
        featureKey: options.feature,
        includeItems: true,
      }), stdout);
    });

  const task = program.command('task').description('Cria e consulta tarefas FEATURE ou PATCH');
  task
    .command('create')
    .description('FEATURE usa o modelo atual; PATCH cria uma mudança pontual já pronta para autorização')
    .requiredOption('--project <key>')
    .requiredOption('--type <type>', 'FEATURE|PATCH')
    .requiredOption('--key <key>')
    .requiredOption('--title <title>')
    .requiredOption('--summary <summary>')
    .option('--template <key>', 'template obrigatório para FEATURE')
    .option('--version <number>', 'versão do template para FEATURE', parseNumber)
    .option('--kind <kind>', 'CODE|DOCUMENTATION|VALIDATION|OTHER', 'CODE')
    .option('--scope <json>', 'escopo técnico com repositórios e padrões de caminho')
    .option('--risk-tags <json>', 'tags de risco para PATCH')
    .option('--use-cases <json>', 'jornadas observáveis para PATCH')
    .option('--criteria <json>', 'critérios de aceite para PATCH')
    .option('--tests <json>', 'testes e perfis para PATCH')
    .action(async (options, command) => {
      const taskType = String(options.type).toUpperCase();
      if (taskType !== 'FEATURE' && taskType !== 'PATCH') {
        throw new WorkflowApplicationError('TASK_TYPE_INVALID', 'Tipo de tarefa inválido. Use FEATURE ou PATCH.');
      }
      emit(command, await app.ledger.createTask({
        projectKey: options.project,
        type: taskType as 'FEATURE' | 'PATCH',
        templateKey: options.template,
        templateVersion: options.version,
        key: options.key,
        title: options.title,
        summary: options.summary,
        kind: options.kind,
        scope: options.scope ? parseJson(options.scope, 'scope') : undefined,
        riskTags: options.riskTags ? parseJson(options.riskTags, 'risk-tags') : undefined,
        useCases: options.useCases ? parseJson(options.useCases, 'use-cases') : undefined,
        criteria: options.criteria ? parseJson(options.criteria, 'criteria') : undefined,
        tests: options.tests ? parseJson(options.tests, 'tests') : undefined,
      }), stdout);
    });

  task
    .command('list')
    .description('Lista tarefas por tipo; sem filtro, lista FEATURE e PATCH')
    .requiredOption('--project <key>')
    .option('--type <type>', 'FEATURE|PATCH')
    .option('--include-items', 'inclui as etapas')
    .action(async (options, command) => {
      const taskType = options.type ? String(options.type).toUpperCase() : undefined;
      if (taskType && taskType !== 'FEATURE' && taskType !== 'PATCH') {
        throw new WorkflowApplicationError('TASK_TYPE_INVALID', 'Tipo de tarefa inválido. Use FEATURE ou PATCH.');
      }
      emit(command, await app.ledger.listFeatures({
        projectKey: options.project,
        taskType: taskType as 'FEATURE' | 'PATCH' | undefined,
        includeItems: options.includeItems ?? false,
      }), stdout);
    });

  task
    .command('show')
    .description('Mostra uma tarefa e suas etapas')
    .requiredOption('--project <key>')
    .requiredOption('--key <key>')
    .action(async (options, command) => {
      emit(command, await app.ledger.listFeatures({
        projectKey: options.project,
        featureKey: options.key,
        includeItems: true,
      }), stdout);
    });

  const quick = program.command('quick').description('Registra ajustes rápidos fora do ciclo de fatias');
  quick
    .command('start')
    .description('Autoriza e abre um ajuste rápido com baseline Git limpo')
    .requiredOption('--project <key>')
    .requiredOption('--key <key>')
    .requiredOption('--title <title>')
    .requiredOption('--summary <summary>')
    .requiredOption('--requested-by <actor>', 'ator humano no formato human:<identidade>')
    .requiredOption('--reason <reason>', 'por que a mudança é local, reversível e diretamente verificável')
    .requiredOption('--repository <key>')
    .requiredOption('--paths <json>', 'lista JSON de paths relativos; máximo de cinco')
    .option('--risk-tags <json>', 'tags de risco permitidas no caminho rápido')
    .option('--guard <reference>', 'permissão existente reutilizada em mudanças ROLE_VISIBILITY')
    .action(async (options, command) => {
      emit(command, await app.quickChanges.start({
        projectKey: options.project,
        key: options.key,
        title: options.title,
        summary: options.summary,
        requestedBy: options.requestedBy,
        eligibilityReason: options.reason,
        repositoryKey: options.repository,
        paths: parseJson(options.paths, 'paths'),
        riskTags: options.riskTags ? parseJson(options.riskTags, 'risk-tags') : undefined,
        guardReference: options.guard,
      }), stdout);
    });

  quick
    .command('finish')
    .description('Fecha o ajuste rápido no commit atual após verificar o diff e o escopo')
    .requiredOption('--project <key>')
    .requiredOption('--key <key>')
    .requiredOption('--completed-by <actor>')
    .requiredOption('--verification-kind <kind>', 'DIFF|COMMAND|MANUAL')
    .requiredOption('--verification <summary>')
    .action(async (options, command) => {
      emit(command, await app.quickChanges.finish({
        projectKey: options.project,
        key: options.key,
        completedBy: options.completedBy,
        verificationKind: options.verificationKind,
        verificationSummary: options.verification,
      }), stdout);
    });

  quick
    .command('promote')
    .description('Encerra o ajuste rápido e o vincula a um PATCH governado já criado')
    .requiredOption('--project <key>')
    .requiredOption('--key <key>')
    .requiredOption('--patch <key>')
    .requiredOption('--actor <actor>')
    .requiredOption('--reason <reason>')
    .action(async (options, command) => {
      emit(command, await app.quickChanges.promote({
        projectKey: options.project,
        key: options.key,
        patchKey: options.patch,
        actor: options.actor,
        reason: options.reason,
      }), stdout);
    });

  quick
    .command('cancel')
    .description('Cancela um ajuste rápido aberto e libera seu escopo')
    .requiredOption('--project <key>')
    .requiredOption('--key <key>')
    .requiredOption('--actor <actor>')
    .requiredOption('--reason <reason>')
    .action(async (options, command) => {
      emit(command, await app.quickChanges.cancel({
        projectKey: options.project,
        key: options.key,
        actor: options.actor,
        reason: options.reason,
      }), stdout);
    });

  quick
    .command('list')
    .description('Lista ajustes rápidos; por padrão mostra somente os abertos')
    .requiredOption('--project <key>')
    .option('--key <key>')
    .option('--status <status>', 'OPEN|CLOSED|PROMOTED|CANCELLED|ALL', 'OPEN')
    .action(async (options, command) => {
      emit(command, await app.quickChanges.list({
        projectKey: options.project,
        key: options.key,
        status: options.status,
      }), stdout);
    });

  program
    .command('frontier')
    .description('Mostra a fronteira de trabalho acionável e o próximo comando de cada folha')
    .requiredOption('--project <key>')
    .option('--feature <key>')
    .option('--include-empty', 'inclui features sem folhas abertas')
    .option('--include-closed-dependencies', 'inclui dependências já fechadas')
    .action(async (options, command) => {
      emit(command, await app.ledger.getReadyFrontier({
        projectKey: options.project,
        featureKey: options.feature,
        includeEmptyFeatures: options.includeEmpty ?? false,
        includeClosedDependencies: options.includeClosedDependencies ?? false,
      }), stdout);
    });

  const plan = program.command('plan').description('Audita a granularidade do planejamento');
  plan
    .command('check')
    .description('Avalia o tamanho das fatias de uma feature sem alterar o ledger')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .action(async (options, command) => {
      emit(command, await app.ledger.checkPlan({
        projectKey: options.project,
        featureKey: options.feature,
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
    .option('--parent <key>', 'fatia original bloqueada pelo replanejamento')
    .option('--scope <json>', 'escopo técnico com repositórios e padrões de caminho')
    .option('--depends-on <dependency>', 'dependência feature:item (repetível)', collect, [])
    .option('--risk-tags <json>', 'tags de risco')
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
        parentItemKey: options.parent,
        scope: options.scope ? parseJson(options.scope, 'scope') : undefined,
        dependsOn: parseDependencies(options.dependsOn),
        riskTags: options.riskTags ? parseJson(options.riskTags, 'risk-tags') : undefined,
        useCases: parseJson(options.useCases, 'use-cases'),
        criteria: parseJson(options.criteria, 'criteria'),
        tests: parseJson(options.tests, 'tests'),
      }), stdout);
    });

  item
    .command('amend-validation-plan')
    .description('Atualiza riscos e testes/perfis de validação enquanto a fatia está em DRAFT')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .requiredOption('--risk-tags <json>')
    .requiredOption('--tests <json>')
    .action(async (options, command) => {
      emit(command, await app.ledger.amendDraftValidationPlan({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        riskTags: parseJson(options.riskTags, 'risk-tags'),
        tests: parseJson(options.tests, 'tests'),
      }), stdout);
    });

  item
    .command('bind-test-selectors')
    .description('Associa seletores reais do runner a testes planejados sem alterar critérios ou riscos')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .requiredOption('--tests <json>', 'lista de {key,testSelector,runnerProfileKey?}')
    .option('--fence <generation>', 'geração vigente da lease', parseNumber)
    .action(async (options, command) => {
      emit(command, await app.ledger.bindTestSelectors({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        tests: parseJson(options.tests, 'tests'),
        executionFence: options.fence,
      }), stdout);
    });

  item
    .command('claim')
    .description('Reserva uma fatia autorizada para um agente por um período')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .requiredOption('--holder <holder>')
    .option('--duration <seconds>')
    .action(async (options, command) => {
      emit(command, await app.ledger.claimWorkItem({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        holder: options.holder,
        durationSeconds: options.duration ? Number(options.duration) : undefined,
      }), stdout);
    });

  item
    .command('recover')
    .description('Recupera uma reserva expirada para outro agente')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .requiredOption('--holder <holder>')
    .option('--duration <seconds>')
    .action(async (options, command) => {
      emit(command, await app.ledger.recoverWorkItemLease({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        holder: options.holder,
        durationSeconds: options.duration ? Number(options.duration) : undefined,
      }), stdout);
    });

  item
    .command('renew')
    .description('Renova uma lease ativa com holder e geração vigentes')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .requiredOption('--holder <holder>')
    .requiredOption('--fence <generation>', 'geração vigente da lease', parseNumber)
    .option('--duration <seconds>', 'novo TTL em segundos', parseNumber)
    .action(async (options, command) => {
      emit(command, await app.ledger.renewWorkItemLease({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        holder: options.holder,
        executionFence: options.fence,
        durationSeconds: options.duration,
      }), stdout);
    });

  item
    .command('release')
    .description('Libera uma lease ativa com holder e geração vigentes')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .requiredOption('--holder <holder>')
    .requiredOption('--fence <generation>', 'geração vigente da lease', parseNumber)
    .option('--reason <reason>', 'motivo da liberação', 'EXPLICIT_RELEASE')
    .action(async (options, command) => {
      emit(command, await app.ledger.releaseWorkItemLease({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        holder: options.holder,
        executionFence: options.fence,
        reason: options.reason,
      }), stdout);
    });

  item
    .command('reconcile')
    .description('Reconcilia leases expiradas e abandona workspaces ativos de forma idempotente')
    .requiredOption('--project <key>')
    .option('--feature <key>')
    .option('--item <key>')
    .action(async (options, command) => {
      emit(command, await app.ledger.reconcileWorkItemLeases({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
      }), stdout);
    });

  item
    .command('replan')
    .description('Bloqueia uma fatia grande ou semanticamente inválida para replanejamento')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .requiredOption('--actor <actor>')
    .requiredOption('--reason <reason>')
    .action(async (options, command) => {
      emit(command, await app.ledger.replanWorkItem({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        actor: options.actor,
        reason: options.reason,
      }), stdout);
    });

  item
    .command('request-size-exception')
    .description('Solicita uma exceção de granularidade sem liberar a fatia')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .requiredOption('--actor <actor>')
    .requiredOption('--reason <reason>')
    .action(async (options, command) => {
      emit(command, await app.ledger.requestSliceSizeException({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        actor: options.actor,
        reason: options.reason,
      }), stdout);
    });

  item
    .command('approve-size')
    .description('OPERATOR-ONLY: aprova uma exceção solicitada por uma fatia acima da política')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .requiredOption('--actor <actor>')
    .requiredOption('--reason <reason>')
    .action(async (options, command) => {
      emit(command, await app.ledger.approveSliceSize({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        actor: options.actor,
        reason: options.reason,
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
    .option('--execution-mode <mode>', 'SHARED|MANAGED_WORKTREE', 'SHARED')
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
        executionMode: options.executionMode,
      }), stdout);
    });

  const dependency = item.command('dependency').description('Gerencia dependências entre fatias');
  dependency
    .command('add')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .requiredOption('--depends-on <dependency>', 'feature:item')
    .action(async (options, command) => {
      const [featureKey, itemKey] = parseDependency(options.dependsOn);
      emit(command, await app.ledger.addWorkItemDependency({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        dependsOn: { featureKey, itemKey },
      }), stdout);
    });

  dependency
    .command('remove')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .requiredOption('--depends-on <dependency>', 'feature:item')
    .action(async (options, command) => {
      const [featureKey, itemKey] = parseDependency(options.dependsOn);
      emit(command, await app.ledger.removeWorkItemDependency({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        dependsOn: { featureKey, itemKey },
      }), stdout);
    });

  dependency
    .command('list')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .action(async (options, command) => {
      emit(command, await app.ledger.listWorkItemDependencies({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
      }), stdout);
    });

  item
    .command('prepare-integration')
    .description('Rebase e registra candidatos exatos para integração')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .option('--fence <generation>', 'geração vigente da lease', parseNumber)
    .action(async (options, command) => {
      emit(command, await app.ledger.prepareIntegration({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        executionFence: options.fence,
      }), stdout);
    });

  item
    .command('authorize-integration')
    .description('Autoriza integração para SHAs candidatos exatos')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .requiredOption('--actor <actor>')
    .requiredOption('--candidates <json>')
    .requiredOption('--target-bases <json>')
    .option('--fence <generation>', 'geração vigente da lease', parseNumber)
    .action(async (options, command) => {
      emit(command, await app.ledger.authorizeIntegration({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        actor: options.actor,
        candidates: parseJson(options.candidates, 'candidates'),
        targetBases: parseJson(options.targetBases, 'target-bases'),
        executionFence: options.fence,
      }), stdout);
    });

  item
    .command('integrate')
    .description('Integra branches gerenciadas por fast-forward e fecha a fatia')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .option('--fence <generation>', 'geração vigente da lease', parseNumber)
    .action(async (options, command) => {
      emit(command, await app.ledger.integrateWorkItem({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        executionFence: options.fence,
      }), stdout);
    });

  item
    .command('cleanup-worktrees')
    .description('Tenta remover worktrees e branches gerenciadas sem força')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .action(async (options, command) => {
      emit(command, await app.ledger.cleanupWorkItem({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
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
    .option('--fence <generation>', 'geração vigente da lease', parseNumber)
    .action(async (options, command) => {
      emit(command, await app.ledger.transitionWorkItem({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        to: options.to,
        reason: options.reason,
        commitSha: options.commit,
        executionFence: options.fence,
      }), stdout);
    });

  item
    .command('reopen')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .requiredOption('--actor <actor>')
    .requiredOption('--reason <reason>')
    .action(async (options, command) => {
      emit(command, await app.ledger.reopenWorkItem({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        actor: options.actor,
        reason: options.reason,
      }), stdout);
    });

  item
    .command('record')
    .description('Mostra o registro detalhado da fatia, incluindo ids de validações')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .action(async (options, command) => {
      emit(command, await app.ledger.getRecord({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
      }), stdout);
    });

  item
    .command('invalidate-green')
    .description('Invalida GREEN obsoleto e retorna a fatia para IMPLEMENTING')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .requiredOption('--reason <reason>')
    .option('--fence <generation>', 'geração vigente da lease', parseNumber)
    .action(async (options, command) => {
      emit(command, await app.ledger.invalidateGreen({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        reason: options.reason,
        executionFence: options.fence,
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
    .option('--parser <parser>', 'JEST|JEST_JSON|PLAYWRIGHT_JSON|GENERIC', 'JEST')
    .option('--timeout <seconds>', 'timeout em segundos', parseNumber)
    .option('--max-output <bytes>', 'limite de saída em bytes', parseNumber)
    .option('--capabilities <json>', 'capacidades verificáveis')
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
        capabilities: options.capabilities ? parseJson(options.capabilities, 'capabilities') : undefined,
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
    .option('--reason <text>', 'explicação obrigatória para RED estrutural')
    .option('--fence <generation>', 'geração vigente da lease', parseNumber)
    .action(async (options, command) => {
      const result = await app.validation.run({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        repositoryKey: options.repository,
        profileKey: options.profile,
        purpose: options.purpose,
        reason: options.reason,
        executionFence: options.fence,
      });
      emit(command, await formatValidationResult(app, {
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        repositoryKey: options.repository,
        profileKey: options.profile,
        purpose: options.purpose,
        reason: options.reason,
        executionFence: options.fence,
      }, result), stdout);
    });

  validate
    .command('confirm-red')
    .description('Confirma um RED estrutural já registrado sem executar os testes novamente')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .requiredOption('--validation <id>')
    .requiredOption('--reason <reason>')
    .option('--fence <generation>', 'geração vigente da lease', parseNumber)
    .action(async (options, command) => {
      emit(command, await app.ledger.confirmStructuralRed({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        validationId: options.validation,
        reason: options.reason,
        executionFence: options.fence,
      }), stdout);
    });

  validate
    .command('list')
    .description('Lista validações registradas da fatia, com os ids para validate log')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .option('--purpose <purpose>', 'filtra por RED|GREEN|CHECK')
    .action(async (options, command) => {
      emit(command, await app.ledger.listValidations({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        purpose: options.purpose,
      }), stdout);
    });

  validate
    .command('log')
    .description('Lê o log retido de uma validação sem executar o perfil')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .requiredOption('--validation <id>')
    .option('--raw', 'emite somente o texto bruto do log')
    .action(async (options, command) => {
      const result = await app.ledger.getValidationLog({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        validationId: options.validation,
      });
      if (options.raw) {
        stdout.write(result.text.endsWith('\n') ? result.text : `${result.text}\n`);
        return;
      }

      emit(command, result, stdout);
    });

  const review = program.command('review').description('Registra revisão');
  review
    .command('submit')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .requiredOption('--reviewer <name>')
    .option('--mode <mode>', 'SELF|INDEPENDENT', 'SELF')
    .requiredOption('--verdict <verdict>', 'APPROVED|CHANGES_REQUIRED|BLOCKED')
    .requiredOption('--summary <summary>')
    .option('--findings <json>', 'achados da revisão em JSON', '[]')
    .option('--fence <generation>', 'geração vigente da lease', parseNumber)
    .action(async (options, command) => {
      emit(command, await app.ledger.submitReview({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        reviewer: options.reviewer,
        reviewMode: options.mode,
        verdict: options.verdict,
        summary: options.summary,
        findings: parseJson(options.findings, 'findings'),
        executionFence: options.fence,
      }), stdout);
    });

  const decision = program.command('decision').description('Registra e consulta decisões');
  decision
    .command('add')
    .requiredOption('--project <key>')
    .requiredOption('--key <key>')
    .requiredOption('--title <title>')
    .requiredOption('--content <text>')
    .option('--feature <key>')
    .option('--item <key>')
    .option('--not-durable', 'registra como decisão não durável', false)
    .option('--pin', 'protege a decisão da retenção de histórico', false)
    .action(async (options, command) => {
      emit(command, await app.ledger.recordDecision({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        key: options.key,
        title: options.title,
        content: options.content,
        durable: !options.notDurable,
        pinned: options.pin,
      }), stdout);
    });

  decision
    .command('list')
    .description('Lista decisões em formato compacto e filtrável')
    .requiredOption('--project <key>')
    .option('--feature <key>')
    .option('--item <key>')
    .option('--key <key>')
    .option('--include-content', 'inclui o conteúdo completo das decisões')
    .action(async (options, command) => {
      emit(command, await app.ledger.listDecisions({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        key: options.key,
        includeContent: options.includeContent ?? false,
      }), stdout);
    });

  const pending = program.command('pending').description('Registra e resolve pendências');
  pending
    .command('add')
    .requiredOption('--project <key>')
    .requiredOption('--key <key>')
    .requiredOption('--description <text>')
    .option('--feature <key>')
    .option('--item <key>')
    .option('--blocking', 'marca a pendência como bloqueante', false)
    .option('--pin', 'protege a pendência da retenção de histórico', false)
    .action(async (options, command) => {
      emit(command, await app.ledger.recordPendingItem({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        key: options.key,
        description: options.description,
        blocking: options.blocking,
        pinned: options.pin,
      }), stdout);
    });

  pending
    .command('list')
    .description('Lista pendências abertas por padrão, com filtros de escopo')
    .requiredOption('--project <key>')
    .option('--feature <key>')
    .option('--item <key>')
    .option('--status <status>', 'OPEN|RESOLVED|ALL', 'OPEN')
    .action(async (options, command) => {
      emit(command, await app.ledger.listPendingItems({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
        resolution: parsePendingResolution(options.status),
      }), stdout);
    });

  pending
    .command('resolve')
    .requiredOption('--project <key>')
    .requiredOption('--key <key>')
    .option('--reason <reason>', 'justificativa da resolução')
    .action(async (options, command) => {
      emit(command, await app.ledger.resolvePendingItem({
        projectKey: options.project,
        key: options.key,
        reason: options.reason,
      }), stdout);
    });

  program
    .command('context')
    .description('Mostra o contexto da feature e da fatia selecionada')
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
    .command('metrics')
    .description('Mostra métricas de tempo, transições e validações de uma fatia')
    .requiredOption('--project <key>')
    .requiredOption('--feature <key>')
    .requiredOption('--item <key>')
    .action(async (options, command) => {
      emit(command, await app.ledger.getCycleMetrics({
        projectKey: options.project,
        featureKey: options.feature,
        itemKey: options.item,
      }), stdout);
    });

  const preflight = program
    .command('preflight')
    .description('Gera verificações somente leitura antes de um E2E');
  preflight
    .command('e2e')
    .requiredOption('--target <target>')
    .action(async (options, command) => {
      emit(command, createE2EPreflight(options.target), stdout);
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

function parsePendingResolution(value: string): 'OPEN' | 'RESOLVED' | 'ALL' {
  if (value === 'OPEN' || value === 'RESOLVED' || value === 'ALL') {
    return value;
  }

  throw new WorkflowApplicationError(
    'PENDING_RESOLUTION_INVALID',
    `Status de pendência inválido: ${value}. Use OPEN, RESOLVED ou ALL.`,
  );
}

function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

function parseDependency(value: string): [string, string] {
  const separator = value.indexOf(':');
  if (separator <= 0 || separator === value.length - 1) {
    throw new WorkflowApplicationError(
      'DEPENDENCY_FORMAT_INVALID',
      `Dependência inválida: ${value}. Use feature:item.`,
    );
  }
  return [value.slice(0, separator), value.slice(separator + 1)];
}

function parseDependencies(values: string[]): Array<{ featureKey: string; itemKey: string }> {
  return values.map((value) => {
    const [featureKey, itemKey] = parseDependency(value);
    return { featureKey, itemKey };
  });
}

function emit(command: Command, value: unknown, stdout: Output): void {
  const options = command.optsWithGlobals<{ json?: boolean }>();
  const output = options.json ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  stdout.write(`${output}\n`);
}
