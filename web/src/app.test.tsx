import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './app';

const snapshot = {
  selection: { projectKey: 'demo', featureKey: 'F1', itemKey: '01', view: 'dashboard' },
  project: { key: 'demo', name: 'Demo' },
  feature: { key: 'F1', name: 'Feature one', summary: 'Resumo', status: 'ACTIVE' },
  overview: { repositories: 1, cleanRepositories: 1, activeFeatures: 1, openItems: 1, walMode: 'wal' },
  item: { key: '01', title: 'Implementar comportamento', phaseKey: 'G1', kind: 'CODE', state: 'DRAFT', summary: 'Resumo da fatia', tddPolicy: 'REQUIRED', currentSha: null, requirementsComplete: true },
  gates: [
    { key: 'specification', label: 'Especificação & Auth', states: ['DRAFT'], status: 'active' },
    { key: 'contract', label: 'Contrato TDD', states: ['TESTS_DEFINED'], status: 'pending' },
    { key: 'execution', label: 'Execução', states: ['IMPLEMENTING'], status: 'pending' },
    { key: 'audit', label: 'Auditoria & Review', states: ['READY_FOR_REVIEW'], status: 'pending' },
    { key: 'final', label: 'Selamento Ledger', states: ['CLOSED'], status: 'pending' },
  ],
  context: { current: { state: 'DRAFT' }, baselines: [] },
  record: { item: {}, tests: [], pendingItems: [] },
  validations: [],
  pendingItems: [],
  recentSlices: [],
  repositories: [{ key: 'api', profiles: [{ key: 'unit', parser: 'GENERIC' }] }],
  availableActions: [{ id: 'MARK_READY', label: 'Avançar para READY', kind: 'primary', enabled: true }, { id: 'BLOCK', label: 'Bloquear ou justificar', kind: 'danger', enabled: true }, { id: 'REINSPECT', label: 'Reinspecionar árvore Git', kind: 'maintenance', enabled: true }, { id: 'COMPACT_HISTORY', label: 'Compactar histórico', kind: 'maintenance', enabled: true }],
  health: { ok: true, database: 'sqlite', journalMode: 'wal', serverTime: new Date().toISOString() },
} as const;

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, '', '/');
});

describe('ledger dashboard', () => {
  it('renders the operational snapshot and switches page filters', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => url.includes('/catalog')
        ? { projects: [{ key: 'demo', name: 'Demo', status: 'ACTIVE', features: [{ key: 'F1', name: 'Feature one', status: 'ACTIVE', items: [{ key: '01', title: 'Implementar comportamento', phaseKey: 'G1', state: 'DRAFT', position: 1 }] }] }] }
        : snapshot,
    })));

    render(<App />);
    await waitFor(() => expect(screen.getByText('Overview Operacional')).toBeTruthy());
    expect(screen.getByText('Implementar comportamento')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Features', exact: true }));
    await waitFor(() => expect(screen.getByText('FEATURES · VISÃO DE EXECUÇÃO')).toBeTruthy());
  });
});
