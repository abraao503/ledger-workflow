import path from 'node:path';

import { parseWorkflowImport, type WorkflowImport } from './workflow-importer.js';

export function createCararaImport(workspaceRoot: string): WorkflowImport {
  const root = path.resolve(workspaceRoot);
  const closedItemData = [
    {
      key: '01',
      title: 'Persistência, contratos e segurança da Clara',
      summary: 'Sessão, execution, configuração versionada e cifrador preparados.',
      currentSha: '5a27805',
      commit: '5a27805',
    },
    {
      key: '02',
      title: 'Administração operacional e configuração da Clara',
      summary: 'Endpoints tenant-scoped, options, secrets write-only e allowlist.',
      currentSha: 'be70b64',
      commit: 'be70b64',
    },
    {
      key: '03',
      title: 'Ownership e sessão operacional',
      summary: 'Rota Assistant, fallback estrutural, ciclo de sessão e auditoria.',
      currentSha: '9fd620a',
      commit: '9fd620a',
    },
    {
      key: '04',
      title: 'Runtime operacional, buffer e execution',
      summary: 'Contexto sem Deal, buffer por ciclo, outbox e execution idempotente.',
      currentSha: '60c0a81',
      commit: '60c0a81',
    },
  ];

  const items: Array<Record<string, unknown>> = closedItemData.map((item, index) => ({
    key: item.key,
    phaseKey: 'G3',
    position: index + 1,
    title: item.title,
    kind: 'CODE' as const,
    state: 'CLOSED' as const,
    summary: item.summary,
    tddPolicy: 'REQUIRED' as const,
    requirementsComplete: true,
    currentSha: item.currentSha,
    useCases: [{
      key: `UC-E6-${item.key}`,
      title: item.title,
      actor: 'Responsável pela implementação',
      preconditions: 'Plano E6/G3 autorizado para a fatia.',
      trigger: 'Execução da fatia vertical.',
      expectedOutcome: item.summary,
    }],
    criteria: [{
      key: `AC-E6-${item.key}`,
      statement: 'A fatia permanece tenant-safe, testável e sem provider real.',
    }],
    tests: [
      {
        key: `T-E6-${item.key}-RED`,
        name: 'cenários inválidos e de segurança',
        purpose: 'RED' as const,
        criterionKey: `AC-E6-${item.key}`,
        runnerProfileKey: 'related-tests',
      },
      {
        key: `T-E6-${item.key}-GREEN`,
        name: 'fluxo aprovado da fatia',
        purpose: 'GREEN' as const,
        criterionKey: `AC-E6-${item.key}`,
        runnerProfileKey: 'related-tests',
      },
    ],
    authorization: {
      instruction: `Implementar E6/G3/fatia ${item.key} no escopo autorizado.`,
      actor: 'responsável',
      allowedEffects: ['alterar código local', 'executar testes relacionados'],
      forbiddenEffects: ['migration aplicada', 'provider real', 'mensagem externa'],
      baselines: [{
        repositoryKey: 'api',
        branch: 'dev',
        sha: item.currentSha,
        dirty: false,
      }],
    },
    validations: [{
      repositoryKey: 'api',
      profileKey: 'related-tests',
      purpose: 'CHECK' as const,
      status: 'COMPLETED' as const,
      resultKind: 'PASS' as const,
      exitCode: 0,
      sha: item.currentSha,
      durationMs: 0,
      summary: { imported: true, commit: item.commit },
    }],
  }));

  items.push({
    key: '05',
    phaseKey: 'G3',
    position: 5,
    title: 'Catálogo de tools do núcleo e execução controlada',
    kind: 'CODE',
    state: 'READY',
    summary: 'Próxima fatia: tools fechadas, guards e efeitos idempotentes do núcleo.',
    tddPolicy: 'REQUIRED',
    requirementsComplete: true,
    useCases: [
      {
        key: 'UC-E6-05-01',
        title: 'Expor catálogo operacional fechado',
        actor: 'Assistant operacional',
        preconditions: 'Execution ativa, sessão válida e ownership vigente.',
        trigger: 'Runtime solicita as tools do núcleo.',
        expectedOutcome: 'Somente tools operacionais aprovadas são disponibilizadas.',
      },
      {
        key: 'UC-E6-05-02',
        title: 'Executar tool com guard de versão',
        actor: 'Assistant operacional',
        preconditions: 'Attendance no mesmo tenant e versão observada.',
        trigger: 'Tool mutável é chamada pelo provider.',
        expectedOutcome: 'Efeito válido é persistido uma vez; stale não produz efeito.',
      },
    ],
    criteria: [
      { key: 'AC-E6-05-01', statement: 'Tools comerciais e acesso direto a Prisma não são expostos.', useCaseKey: 'UC-E6-05-01' },
      { key: 'AC-E6-05-02', statement: 'Cada efeito valida tenant, sessão, ownership, versão e idempotência.', useCaseKey: 'UC-E6-05-02' },
    ],
    tests: [
      { key: 'T-E6-05-RED', name: 'catálogo e guards falham antes da implementação', purpose: 'RED', criterionKey: 'AC-E6-05-01', runnerProfileKey: 'related-tests' },
      { key: 'T-E6-05-GREEN', name: 'tools do núcleo executam efeitos controlados', purpose: 'GREEN', criterionKey: 'AC-E6-05-02', runnerProfileKey: 'related-tests' },
      { key: 'T-E6-05-CHECK', name: 'replay e stale não duplicam efeitos', purpose: 'CHECK', criterionKey: 'AC-E6-05-02', runnerProfileKey: 'related-tests' },
    ],
    authorization: undefined,
    validations: [],
  });

  for (const [index, item] of [
    ['06', 'Gateway Clara, resposta normalizada e fallback'],
    ['07', 'Outbound operacional de Assistant'],
    ['08', 'Administração operacional no frontend'],
    ['09', 'Estação operacional e observabilidade sanitizada'],
    ['10', 'Regressão comercial, gates e fechamento de E6'],
  ] as const) {
    items.push({
      key: index,
      phaseKey: 'G3',
      position: Number(index),
      title: item,
      kind: 'CODE',
      state: 'DRAFT',
      summary: 'Fatia prevista no plano E6; ainda não autorizada.',
      tddPolicy: 'REQUIRED',
      requirementsComplete: true,
      useCases: [{
        key: `UC-E6-${index}`,
        title: item,
        actor: 'Responsável pela implementação',
        preconditions: 'Dependências anteriores fechadas e autorização própria.',
        trigger: 'Abertura da fatia.',
        expectedOutcome: 'Contrato da fatia validado e implementado.',
      }],
      criteria: [{ key: `AC-E6-${index}`, statement: 'Escopo e riscos permanecem registrados no ledger.' }],
      tests: [{ key: `T-E6-${index}`, name: 'caso de uso da fatia', purpose: 'CHECK', criterionKey: `AC-E6-${index}`, runnerProfileKey: 'related-tests' }],
      authorization: undefined,
      validations: [],
    });
  }

  const decisions = [
    ['D-E6-01', 'Runtime selecionado pelo tipo do workspace'],
    ['D-E6-02', 'Ownership do Attendance autoriza cada efeito'],
    ['D-E6-03', 'Usuário e Assistant são mutuamente exclusivos'],
    ['D-E6-04', 'Rota Assistant preserva fallback estrutural'],
    ['D-E6-05', 'Transferência para IA é aditiva no endpoint existente'],
    ['D-E6-06', 'Sessão operacional é própria e escopada ao ciclo'],
    ['D-E6-07', 'Execution e deduplicação são persistidas'],
    ['D-E6-08', 'Resposta usa o outbound de Attendance'],
    ['D-E6-09', 'Catálogo de tools é fechado por estratégia'],
    ['D-E6-10', 'Comandos de IA têm versão e idempotência derivadas'],
    ['D-E6-11', 'Clara é ferramenta, nunca autoridade'],
    ['D-E6-12', 'Configuração da Clara é server-side e versionada'],
    ['D-E6-13', 'Timeout/retry da Clara não duplica efeito'],
    ['D-E6-14', 'Fallback é comando idempotente do núcleo'],
    ['D-E6-15', 'Observabilidade não expõe dados sensíveis'],
    ['D-E6-16', 'Frontend operacional não abre superfície comercial'],
  ].map(([key, title]) => ({
    featureKey: 'E6',
    key,
    title,
    content: 'Decisão congelada no G2; divergência estrutural retorna ao planejamento.',
    durable: true,
    pinned: true,
  }));

  const summaries = ['E0', 'E1', 'E2', 'E3', 'E4', 'E5', 'E5.1'].map((key) => ({
    featureKey: 'E6',
    scopeKey: `legacy:${key}`,
    state: 'CLOSED',
    result: 'PASS',
    delivered: { summary: `${key} encerrada conforme histórico legado.` },
    commits: [],
    validations: [],
    limitations: ['Detalhes preservados somente nos documentos legados versionados.'],
    pinned: false,
  }));

  return parseWorkflowImport({
    schemaVersion: 1,
    importKey: 'carara-2026-09-02',
    project: {
      key: 'carara',
      name: 'Carará — módulo operacional',
      rootPath: root,
    },
    repositories: [
      { key: 'api', path: path.join(root, 'api'), expectedBranch: 'dev' },
      { key: 'front', path: path.join(root, 'front'), expectedBranch: 'dev' },
      { key: 'planning', path: root, expectedBranch: 'master' },
    ],
    templates: [{
      key: 'carara-gates',
      version: 1,
      name: 'Carará G0-G7',
      definition: {
        phases: ['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7'],
        retention: { active: true, recentDetailed: 2, pinnedNeverCompact: true },
        tdd: { codingRequiresRedEvidence: true, exceptionRequiresReason: true },
      },
    }],
    plans: [{
      featureKey: 'E6',
      key: 'E6',
      version: 1,
      title: 'Assistentes de IA nativos e Clara',
      summary: 'Runtime operacional, catálogo fechado, Clara read-only, fallback e frontend.',
      constraints: ['Sem provider real antes de autorização própria.', 'Sem migration aplicada durante G3.'],
      outOfScope: ['Clara HTTP real sem wire contract aprovado.', 'Piloto, SIGA e tráfego externo.'],
      sourceRef: 'carara-atendimento/docs/planejamento/PLANO-E6-ASSISTENTES-DE-IA-E-CLARA.md',
    }],
    features: [{
      key: 'E6',
      templateKey: 'carara-gates',
      name: 'Assistentes de IA nativos e Clara',
      summary: 'G0-G2 PASS; G3 em andamento nas fatias 01-04, próxima 05.',
      status: 'ACTIVE',
      currentPhaseKey: 'G3',
      items,
    }],
    validationProfiles: [
      {
        repositoryKey: 'api',
        key: 'related-tests',
        program: 'npm',
        args: ['run', 'test:modified'],
        cwd: '.',
        parser: 'JEST',
        timeoutSeconds: 300,
        maxOutputBytes: 2_000_000,
      },
      {
        repositoryKey: 'front',
        key: 'lint',
        program: 'npm',
        args: ['run', 'lint'],
        cwd: '.',
        parser: 'GENERIC',
        timeoutSeconds: 120,
        maxOutputBytes: 1_000_000,
      },
    ],
    decisions,
    pendingItems: [{
      featureKey: 'E6',
      key: 'P-E6-CLARA-WIRE-CONTRACT',
      description: 'URL, autenticação, schemas, erros, limites e ambiente não produtivo da Clara ainda não foram fornecidos.',
      blocking: false,
      resolved: false,
      pinned: true,
    }],
    summaries,
  });
}
