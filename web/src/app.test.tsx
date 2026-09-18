import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './app';

const snapshot = {
  selection: { projectKey: 'demo', featureKey: 'F1', itemKey: '01', view: 'dashboard' },
  project: { key: 'demo', name: 'Demo' },
  feature: { key: 'F1', name: 'Feature one', summary: 'Resumo', status: 'ACTIVE' },
  overview: { repositories: 1, cleanRepositories: 1, activeFeatures: 1, openItems: 1, walMode: 'wal' },
  item: {
    key: '01',
    title: 'Implementar comportamento',
    phaseKey: 'G1',
    kind: 'CODE',
    state: 'IMPLEMENTING',
    summary: 'Resumo da fatia em execução pelo agente.',
    tddPolicy: 'REQUIRED',
    currentSha: null,
    requirementsComplete: true,
  },
  gates: [
    { key: 'specification', label: 'Especificação & Auth', states: ['DRAFT'], status: 'complete' },
    { key: 'contract', label: 'Contrato TDD', states: ['TESTS_DEFINED'], status: 'complete' },
    { key: 'execution', label: 'Execução', states: ['IMPLEMENTING'], status: 'active' },
    { key: 'audit', label: 'Auditoria & Review', states: ['READY_FOR_REVIEW'], status: 'pending' },
    { key: 'final', label: 'Selamento Ledger', states: ['CLOSED'], status: 'pending' },
  ],
  context: {
    current: { state: 'IMPLEMENTING', nextAllowedTransition: 'GREEN_CONFIRMED' },
    riskTags: ['API_WRITE'],
    journey: {
      useCases: [{ key: 'UC-01', title: 'Persistir', trigger: 'enviar', expectedOutcome: 'persistido' }],
      criteria: [{ key: 'AC-01', statement: 'persistência confirmada', evidenceKind: 'PERSISTENCE', polarity: 'EXPECTED' }],
    },
    validation: {
      status: 'BLOCKED',
      requiredCapabilities: ['API_INTEGRATION', 'READ_AFTER_WRITE'],
      coveredCapabilities: ['API_INTEGRATION'],
      missingCapabilities: ['READ_AFTER_WRITE'],
      unknownRiskTags: [],
      missingProfileKeys: [],
    },
    authorization: {
      instruction: 'Implementar somente o escopo da fatia',
      actor: 'Codex',
      allowedEffects: ['código local'],
      forbiddenEffects: ['produção'],
    },
    acceptanceCriteria: [{ key: 'AC-01', statement: 'O comportamento fica observável na interface.' }],
    unresolvedItems: [{ key: 'P-01', description: 'Confirmar fixture antes do GREEN.', blocking: true }],
    requiredChecks: [{ key: 'T-01', description: 'checagem da fixture', status: 'PENDING' }],
  },
  record: {
    item: {},
    tests: [{ key: 'T-01', name: 'checagem da fixture', purpose: 'CHECK', status: 'PLANNED' }],
    pendingItems: [],
    lineage: {
      parent: { key: '00', title: 'Fatia original', state: 'BLOCKED' },
      children: [{ key: '03', title: 'Derivada do replanejamento', state: 'DRAFT' }],
    },
  },
  lease: { holder: 'agent:codex', generation: 3, acquiredAt: '2026-09-07T10:00:00.000Z', expiresAt: '2099-01-01T12:00:00.000Z', active: true },
  validations: [],
  pendingItems: [],
  recentSlices: [],
  repositories: [{ key: 'api', profiles: [{ key: 'unit', parser: 'GENERIC' }] }],
  availableActions: [
    { id: 'RUN_GREEN', label: 'Executar validação GREEN', kind: 'primary', enabled: true },
    { id: 'BLOCK', label: 'Bloquear ou justificar', kind: 'danger', enabled: true },
    { id: 'REINSPECT', label: 'Reinspecionar árvore Git', kind: 'maintenance', enabled: true },
    { id: 'PLAN_CHECK', label: 'Auditar planejamento', kind: 'maintenance', enabled: true },
  ],
  health: { ok: true, database: 'sqlite', journalMode: 'wal', serverTime: new Date().toISOString() },
} as const;

const planReport = {
  policy: { maxUseCases: 3, maxRequiredCriteria: 9, maxTests: 4 },
  summary: { total: 2, ok: 1 },
  items: [
    {
      key: '01', title: 'Implementar comportamento', status: 'SPLIT_RECOMMENDED',
      metrics: { useCases: 4, requiredCriteria: 10, tests: 4 },
      repositoryScope: 'DECLARED', scopeIssues: [],
      semanticStatus: 'OK', semanticIssues: [],
      riskTags: ['API_WRITE'],
      requiredCapabilities: ['API_INTEGRATION', 'READ_AFTER_WRITE'],
      coveredCapabilities: ['API_INTEGRATION'],
      missingCapabilities: ['READ_AFTER_WRITE'],
      unknownRiskTags: [], missingProfileKeys: [], validationStatus: 'BLOCKED',
      violations: [{ severity: 'WARNING', message: 'A fatia excede o limite de casos de uso.' }],
      suggestions: ['Divida o resultado B em uma fatia derivada.'],
    },
    {
      key: '02', title: 'Próxima etapa', status: 'OK',
      metrics: { useCases: 1, requiredCriteria: 2, tests: 1 },
      repositoryScope: 'DECLARED', scopeIssues: [],
      semanticStatus: 'OK', semanticIssues: [],
      violations: [], suggestions: [],
    },
  ],
};

const catalog = {
  projects: [{
    key: 'demo',
    name: 'Demo',
    status: 'ACTIVE',
    features: [{
      key: 'F1',
      name: 'Feature one',
      status: 'ACTIVE',
      items: [
        { key: '01', title: 'Implementar comportamento', phaseKey: 'G1', state: 'IMPLEMENTING', position: 1 },
        { key: '02', title: 'Próxima etapa', phaseKey: 'G1', state: 'DRAFT', position: 2 },
      ],
    }],
  }],
};

const executionMap = {
  project: { key: 'demo', name: 'Demo' },
  selection: { featureKey: 'F1' },
  classification: 'PARALLEL',
  summary: { totalItems: 4, openItems: 4, closedItems: 0, activeAgents: 1, waveCount: 2, maxParallelism: 2 },
  waves: [
    {
      index: 0,
      items: [
        { featureKey: 'F1', itemKey: 'A', title: 'Base A', state: 'IMPLEMENTING', position: 1, wave: 0, dependencies: [], dependents: [] },
        { featureKey: 'F1', itemKey: 'B', title: 'Base B', state: 'IMPLEMENTING', position: 2, wave: 0, dependencies: [], dependents: [] },
      ],
    },
    {
      index: 1,
      items: [
        { featureKey: 'F1', itemKey: 'C', title: 'Depois de A', state: 'AUTHORIZED', position: 3, wave: 1, dependencies: [{ featureKey: 'F1', itemKey: 'A', title: 'Base A', state: 'IMPLEMENTING' }], dependents: [] },
        { featureKey: 'F1', itemKey: 'D', title: 'Depois de B', state: 'AUTHORIZED', position: 4, wave: 1, dependencies: [{ featureKey: 'F1', itemKey: 'B', title: 'Base B', state: 'IMPLEMENTING' }], dependents: [] },
      ],
    },
  ],
  items: [],
  agents: [{
    holder: 'agent:second', featureKey: 'F1', itemKey: 'B', title: 'Base B', state: 'IMPLEMENTING', generation: 1,
    expiresAt: '2099-01-01T00:00:00.000Z', unlocks: [{ featureKey: 'F1', itemKey: 'D', title: 'Depois de B', state: 'AUTHORIZED' }],
  }],
} as const;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('acompanhamento do workflow', () => {
const stubFetch = () => vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
    ok: true,
    json: async () => String(url).includes('/plan-check')
      ? planReport
      : String(url).includes('/catalog')
        ? catalog
        : String(url).includes('/execution-map')
          ? executionMap
          : snapshot,
  })));

  it('mostra o que o agente está fazendo agora e a entrega', async () => {
    stubFetch();

    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Implementar comportamento' })).toBeTruthy());
    expect(screen.getAllByText('Em execução').length).toBeGreaterThan(0);
    expect(screen.getByText(/Próximo registro esperado: Evidência verde/)).toBeTruthy();
    expect(screen.getByText(/Você autorizou/)).toBeTruthy();
    expect(screen.getByText('O comportamento fica observável na interface.')).toBeTruthy();
    expect(screen.getByText('Confirmar fixture antes do GREEN.')).toBeTruthy();
    expect(screen.getByText('Fatia reservada por um agente')).toBeTruthy();
    expect(screen.getByText(/agent:codex/)).toBeTruthy();
    expect(screen.getByText(/Origem: 00 · Fatia original/)).toBeTruthy();
    expect(screen.getByText(/Derivadas: 03 · Derivada do replanejamento/)).toBeTruthy();
    expect(screen.queryByText('Overview Operacional')).toBeNull();
    expect(screen.queryByText('WAL')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Contrato observável' })).toBeTruthy();
    expect(screen.getByText('API_WRITE')).toBeTruthy();
    expect(screen.getByText(/READ_AFTER_WRITE/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Entrega', exact: true }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Entregas' })).toBeTruthy());
    expect(screen.getAllByText('Feature one').length).toBeGreaterThan(0);
    expect(screen.getByText('0/2 etapas')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Mapa de execução' })).toBeTruthy();
    expect(screen.getAllByText('Em paralelo').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('Onda 1')).toBeTruthy();
    expect(screen.getByText('Onda 2')).toBeTruthy();
    expect(screen.getByText('agent:second')).toBeTruthy();
    expect(screen.getByText(/desbloqueia.*D/)).toBeTruthy();
    expect(screen.getByText('Linha única')).toBeTruthy();
    expect(screen.getByText('Sem classificação')).toBeTruthy();
  });

  it('abre a auditoria do planejamento com política, métricas e sugestões', async () => {
    stubFetch();

    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Implementar comportamento' })).toBeTruthy());

    fireEvent.click(screen.getByRole('button', { name: 'Auditar planejamento' }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Auditoria do planejamento' })).toBeTruthy());

    await waitFor(() => expect(screen.getByText('Divisão recomendada')).toBeTruthy());
    expect(screen.getByText(/2\/2 fatias|1\/2 dentro da política/)).toBeTruthy();
    expect(screen.getByText(/4\/3 casos de uso/)).toBeTruthy();
    expect(screen.getAllByText(/Escopo de repositórios: declarado/).length).toBe(2);
    expect(screen.getByText('A fatia excede o limite de casos de uso.')).toBeTruthy();
    expect(screen.getByText(/Divida o resultado B em uma fatia derivada./)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Fechar' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Auditoria do planejamento' })).toBeNull());
  });

  it('envia o executionFence vigente ao executar uma ação protegida', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => String(url).includes('/catalog')
          ? catalog
          : String(url).includes('/execution-map')
            ? executionMap
            : snapshot,
      };
    }));

    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Implementar comportamento' })).toBeTruthy());
    fireEvent.click(screen.getAllByRole('button', { name: 'Executar validação GREEN' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar ação' }));

    await waitFor(() => {
      const actionCall = calls.find((call) => call.url === '/api/actions');
      expect(actionCall).toBeTruthy();
      expect(JSON.parse(String(actionCall?.init?.body))).toMatchObject({ executionFence: 3 });
    });
  });

  it('usa contagens de folhas no catálogo e não conta o pai substituído', async () => {
    const leafCatalog = {
      projects: [{
        ...catalog.projects[0],
        features: [{
          ...catalog.projects[0].features[0],
          executionStatus: 'OPEN',
          executionCounts: { totalLeaves: 2, closedLeaves: 1, openLeaves: 1 },
          items: [
            { key: '01', title: 'Pai substituído', phaseKey: 'G1', state: 'SUPERSEDED', position: 1 },
            { key: '01a', title: 'Derivada fechada', phaseKey: 'G1', state: 'CLOSED', position: 2, parentItemKey: '01' },
            { key: '02', title: 'Folha aberta', phaseKey: 'G1', state: 'IMPLEMENTING', position: 3 },
          ],
        }],
      }],
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => String(url).includes('/catalog')
        ? leafCatalog
        : String(url).includes('/execution-map')
          ? executionMap
          : snapshot,
    })));

    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Implementar comportamento' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Entrega', exact: true }));
    await waitFor(() => expect(screen.getByText('1/2 etapas')).toBeTruthy());
    expect(screen.queryByText('Pai substituído')).toBeNull();
  });
});
