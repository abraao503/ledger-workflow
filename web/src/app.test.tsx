import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  record: { item: {}, tests: [{ key: 'T-01', name: 'checagem da fixture', purpose: 'CHECK', status: 'PLANNED' }], pendingItems: [] },
  validations: [],
  pendingItems: [],
  recentSlices: [],
  repositories: [{ key: 'api', profiles: [{ key: 'unit', parser: 'GENERIC' }] }],
  availableActions: [
    { id: 'RUN_GREEN', label: 'Executar validação GREEN', kind: 'primary', enabled: true },
    { id: 'BLOCK', label: 'Bloquear ou justificar', kind: 'danger', enabled: true },
    { id: 'REINSPECT', label: 'Reinspecionar árvore Git', kind: 'maintenance', enabled: true },
  ],
  health: { ok: true, database: 'sqlite', journalMode: 'wal', serverTime: new Date().toISOString() },
} as const;

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

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('acompanhamento do workflow', () => {
  it('mostra o que o agente está fazendo agora e a entrega', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => String(url).includes('/catalog') ? catalog : snapshot,
    })));

    render(<App />);
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Implementar comportamento' })).toBeTruthy());
    expect(screen.getAllByText('Em execução').length).toBeGreaterThan(0);
    expect(screen.getByText(/Próximo registro esperado: Evidência verde/)).toBeTruthy();
    expect(screen.getByText(/Você autorizou/)).toBeTruthy();
    expect(screen.getByText('O comportamento fica observável na interface.')).toBeTruthy();
    expect(screen.getByText('Confirmar fixture antes do GREEN.')).toBeTruthy();
    expect(screen.queryByText('Overview Operacional')).toBeNull();
    expect(screen.queryByText('WAL')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Entrega', exact: true }));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Entregas' })).toBeTruthy());
    expect(screen.getAllByText('Feature one').length).toBeGreaterThan(0);
    expect(screen.getByText('0/2 etapas')).toBeTruthy();
  });
});
