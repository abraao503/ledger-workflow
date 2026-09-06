import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import type {
  DashboardAction,
  DashboardActionId,
  DashboardCatalogProject,
  DashboardSnapshot,
} from '../../../src/application/types.js';

type View = 'dashboard' | 'features' | 'execution' | 'review' | 'context';
type Selection = { projectKey?: string; featureKey?: string; itemKey?: string };
type ModalState = { action: DashboardAction; logValidationId?: string } | null;

const navItems: Array<{ id: View; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'features', label: 'Features' },
  { id: 'execution', label: 'Fatia em Execução' },
  { id: 'review', label: 'Revisão' },
  { id: 'context', label: 'Contexto' },
];

export function App() {
  const [catalog, setCatalog] = useState<DashboardCatalogProject[]>([]);
  const [dashboard, setDashboard] = useState<DashboardSnapshot | null>(null);
  const [selection, setSelection] = useState<Selection>(() => readSelection());
  const [view, setView] = useState<View>(() => readView());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [logText, setLogText] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [inspection, setInspection] = useState<Record<string, unknown> | null>(null);
  const requestRef = useRef<AbortController | null>(null);

  const loadCatalog = useCallback(async () => {
    const response = await fetch('/api/catalog', { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Não foi possível carregar os projetos');
    const payload = await response.json() as { projects: DashboardCatalogProject[] };
    setCatalog(payload.projects);
    return payload.projects;
  }, []);

  const loadDashboard = useCallback(async (silent = false) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    if (silent) setRefreshing(true); else setLoading(true);
    try {
      const query = new URLSearchParams();
      if (selection.projectKey) query.set('projectKey', selection.projectKey);
      if (selection.featureKey) query.set('featureKey', selection.featureKey);
      if (selection.itemKey) query.set('itemKey', selection.itemKey);
      query.set('view', view);
      const response = await fetch(`/api/dashboard?${query.toString()}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(payload.message ?? 'Não foi possível carregar o dashboard');
      }
      const payload = await response.json() as DashboardSnapshot;
      setDashboard(payload);
      setSelection({
        projectKey: payload.selection.projectKey,
        featureKey: payload.selection.featureKey,
        itemKey: payload.selection.itemKey,
      });
      writeSelection(payload.selection);
      setError(null);
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      setError(cause instanceof Error ? cause.message : 'Erro inesperado');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [selection.featureKey, selection.itemKey, selection.projectKey, view]);

  useEffect(() => {
    void loadCatalog().catch((cause) => setError(cause instanceof Error ? cause.message : 'Erro inesperado'));
  }, [loadCatalog]);

  useEffect(() => {
    void loadDashboard();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void loadDashboard(true);
    };
    document.addEventListener('visibilitychange', onVisibility);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !modal) void loadDashboard(true);
    }, 5000);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      requestRef.current?.abort();
    };
  }, [loadDashboard, modal]);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('view', view);
    if (dashboard) {
      url.searchParams.set('projectKey', dashboard.selection.projectKey);
      url.searchParams.set('featureKey', dashboard.selection.featureKey);
      url.searchParams.set('itemKey', dashboard.selection.itemKey);
    }
    window.history.replaceState({}, '', url);
  }, [dashboard, view]);

  const selectProject = (projectKey: string) => {
    const project = catalog.find((candidate) => candidate.key === projectKey);
    const feature = project?.features[0];
    const item = feature?.items.find((candidate) => candidate.state !== 'CLOSED') ?? feature?.items.at(-1);
    setSelection({ projectKey, featureKey: feature?.key, itemKey: item?.key });
  };
  const selectFeature = (featureKey: string) => {
    const project = catalog.find((candidate) => candidate.key === (selection.projectKey ?? dashboard?.selection.projectKey));
    const feature = project?.features.find((candidate) => candidate.key === featureKey);
    const item = feature?.items.find((candidate) => candidate.state !== 'CLOSED') ?? feature?.items.at(-1);
    setSelection({
      projectKey: project?.key,
      featureKey,
      itemKey: item?.key,
    });
  };
  const selectItem = (itemKey: string) => setSelection({ ...selection, itemKey });

  const runAction = async (action: DashboardActionId, fields: Record<string, unknown>) => {
    if (!dashboard) return;
    setNotice(null);
    const response = await fetch('/api/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        action,
        projectKey: dashboard.selection.projectKey,
        featureKey: dashboard.selection.featureKey,
        itemKey: dashboard.selection.itemKey,
        expectedState: dashboard.item.state,
        ...fields,
      }),
    });
    const payload = await response.json().catch(() => ({})) as { message?: string; snapshot?: DashboardSnapshot; result?: unknown };
    if (!response.ok) throw new Error(payload.message ?? 'A ação foi rejeitada pelo ledger');
    if (payload.snapshot) setDashboard(payload.snapshot);
    void loadCatalog().catch(() => undefined);
    if (action === 'REINSPECT' && payload.result && typeof payload.result === 'object') {
      const result = payload.result as { snapshot?: Record<string, unknown> };
      setInspection(result.snapshot ?? null);
    }
    setNotice('Ação registrada no ledger.');
  };

  const submitAction = async (fields: Record<string, unknown>) => {
    if (!modal) return;
    try {
      const normalized = { ...fields };
      if (modal.action.id === 'AUTHORIZE') {
        normalized.repositoryKeys = String(fields.repositoryKeys ?? '').split(',').map((value) => value.trim()).filter(Boolean);
      }
      if (modal.action.id === 'COMPACT_HISTORY') {
        normalized.keepRecent = Number(fields.keepRecent ?? 2);
      }
      await runAction(modal.action.id, normalized);
      setModal(null);
      setLogText(null);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : 'Ação rejeitada');
    }
  };

  const openLog = async (validationId: string) => {
    if (!dashboard) return;
    setModal({ action: { id: 'REINSPECT', label: 'Log de validação', kind: 'maintenance', enabled: true }, logValidationId: validationId });
    setLogLoading(true);
    try {
      const query = new URLSearchParams({
        projectKey: dashboard.selection.projectKey,
        featureKey: dashboard.selection.featureKey,
        itemKey: dashboard.selection.itemKey,
      });
      const response = await fetch(`/api/validations/${encodeURIComponent(validationId)}/log?${query}`);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(payload.message ?? 'Log indisponível');
      }
      setLogText(await response.text());
    } catch (cause) {
      setLogText(cause instanceof Error ? cause.message : 'Log indisponível');
    } finally {
      setLogLoading(false);
    }
  };

  const primaryAction = useMemo(() => {
    if (!dashboard) return undefined;
    return dashboard.availableActions.find((action) => action.kind === 'primary')
      ?? dashboard.availableActions.find((action) => action.kind === 'danger');
  }, [dashboard]);

  if (loading && !dashboard) return <LoadingShell />;

  return (
    <div className="app-shell">
      <Header
        catalog={catalog}
        dashboard={dashboard}
        selection={selection}
        view={view}
        refreshing={refreshing}
        onProject={selectProject}
        onFeature={selectFeature}
        onItem={selectItem}
        onView={(next) => { setView(next); writeView(next); }}
        onRefresh={() => void loadDashboard(true)}
      />
      <main className="page-shell">
        {error && <InlineNotice tone="error" message={error} onClose={() => setError(null)} />}
        {notice && <InlineNotice tone="success" message={notice} onClose={() => setNotice(null)} />}
        {!dashboard ? (
          <EmptyState title="Nenhuma fatia disponível" detail="Importe um workflow pelo CLI ou MCP para iniciar o ledger." />
        ) : (
          <>
            <Overview dashboard={dashboard} catalog={catalog} />
            {(view === 'dashboard' || view === 'features') && <Pipeline dashboard={dashboard} />}
            {view === 'dashboard' && <DashboardGrid dashboard={dashboard} onAction={(action) => setModal({ action })} onOpenLog={openLog} onInspect={() => setModal({ action: findAction(dashboard, 'REINSPECT') })} inspection={inspection} />}
            {view === 'features' && <FeaturesView dashboard={dashboard} catalog={catalog} onFeature={selectFeature} onItem={selectItem} />}
            {view === 'execution' && <ExecutionView dashboard={dashboard} primaryAction={primaryAction} onAction={(action) => setModal({ action })} onOpenLog={openLog} />}
            {view === 'review' && <ReviewView dashboard={dashboard} onAction={(action) => setModal({ action })} onOpenLog={openLog} />}
            {view === 'context' && <ContextView dashboard={dashboard} />}
            <ShortcutBar dashboard={dashboard} onAction={(action) => setModal({ action })} />
          </>
        )}
      </main>
      <Footer dashboard={dashboard} />
      {modal && (
        <ActionDialog
          modal={modal}
          dashboard={dashboard}
          logLoading={logLoading}
          logText={logText}
          onClose={() => { setModal(null); setLogText(null); }}
          onSubmit={submitAction}
        />
      )}
    </div>
  );
}

function Header(props: {
  catalog: DashboardCatalogProject[];
  dashboard: DashboardSnapshot | null;
  selection: Selection;
  view: View;
  refreshing: boolean;
  onProject: (key: string) => void;
  onFeature: (key: string) => void;
  onItem: (key: string) => void;
  onView: (view: View) => void;
  onRefresh: () => void;
}) {
  const projectKey = props.dashboard?.selection.projectKey ?? props.selection.projectKey ?? '';
  const featureKey = props.dashboard?.selection.featureKey ?? props.selection.featureKey ?? '';
  const itemKey = props.dashboard?.selection.itemKey ?? props.selection.itemKey ?? '';
  const project = props.catalog.find((candidate) => candidate.key === projectKey);
  const feature = project?.features.find((candidate) => candidate.key === featureKey);
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand-lockup">
          <div className="brand-mark">W</div>
          <span className="brand-name">Workflow Ledger</span>
          <span className="slash">/</span>
          <select aria-label="Projeto" className="repo-select" value={projectKey} onChange={(event) => props.onProject(event.target.value)}>
            <option value="">Selecionar projeto</option>
            {props.catalog.map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.key} · {candidate.name}</option>)}
          </select>
        </div>
        <nav className="main-nav" aria-label="Módulos do ledger">
          {navItems.map((item) => (
            <button key={item.id} className={`nav-button ${props.view === item.id ? 'active' : ''}`} onClick={() => props.onView(item.id)}>{item.label}{item.id === 'execution' && <span className="live-dot" />}</button>
          ))}
        </nav>
        <div className="topbar-tools">
          <span className="daemon-status"><i /> daemon:4117</span>
          <button className="key-hint" onClick={props.onRefresh} title="Atualizar dashboard">{props.refreshing ? '…' : '⌘R'}</button>
          <button className="icon-button" onClick={props.onRefresh} aria-label="Atualizar dashboard">↻</button>
        </div>
      </div>
      {project && feature && (
        <div className="context-selectors">
          <label>FEATURE<select aria-label="Feature" value={featureKey} onChange={(event) => props.onFeature(event.target.value)}>{project.features.map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.key} · {candidate.name}</option>)}</select></label>
          <label>FATIA<select aria-label="Fatia" value={itemKey} onChange={(event) => props.onItem(event.target.value)}>{feature.items.map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.key} · {candidate.state}</option>)}</select></label>
        </div>
      )}
    </header>
  );
}

function Overview({ dashboard, catalog }: { dashboard: DashboardSnapshot; catalog: DashboardCatalogProject[] }) {
  const project = catalog.find((candidate) => candidate.key === dashboard.selection.projectKey);
  const featureCount = project?.features.length ?? dashboard.overview.activeFeatures;
  return (
    <section className="overview section-rule">
      <div>
        <div className="eyebrow-row"><h1>Overview Operacional</h1><span className="tag">ENGINE DETERMINÍSTICO TDD</span></div>
        <p>Monitoramento de integridade da árvore, permissões de sandbox e transições estritas do ledger.</p>
      </div>
      <div className="metric-strip">
        <Metric label="REPOSITÓRIOS" value={`${dashboard.overview.cleanRepositories}/${dashboard.overview.repositories} limpos`} healthy={dashboard.overview.cleanRepositories === dashboard.overview.repositories} />
        <Metric label="FEATURES" value={`${featureCount} no catálogo`} />
        <Metric label="FATIAS ABERTAS" value={`${dashboard.overview.openItems}`} />
        <Metric label="FATIA ATUAL" value={`${dashboard.feature.key}/${dashboard.item.key}`} accent />
        <Metric label="WAL" value={dashboard.overview.walMode.toUpperCase()} />
      </div>
    </section>
  );
}

function Metric({ label, value, healthy, accent }: { label: string; value: string; healthy?: boolean; accent?: boolean }) {
  return <div className={`metric ${accent ? 'accent' : ''}`}><span>{label}</span><strong>{value}</strong>{healthy !== undefined && <i className={healthy ? 'ok' : 'warn'} />}</div>;
}

function Pipeline({ dashboard }: { dashboard: DashboardSnapshot }) {
  return (
    <section className="panel pipeline-panel">
      <PanelHeader title="ESPINHA DORSAL DE PORTÕES" icon="⌘" meta={`CONTRATO: RULESET_TDD_STRICT · ${dashboard.feature.key}`} />
      <div className="gate-grid">
        {dashboard.gates.map((gate, index) => (
          <div key={gate.key} className={`gate-card ${gate.status}`}>
            <div className="gate-top"><span>0{index + 1} {gate.label.toUpperCase()}</span><StatusDot status={gate.status} /></div>
            <strong>{gate.states.includes(dashboard.item.state) ? dashboard.item.state.replaceAll('_', ' ') : gate.label}</strong>
            <p>{gate.status === 'complete' ? 'Evidência confirmada no ledger.' : gate.status === 'active' ? 'Próxima transição operacional.' : gate.status === 'blocked' ? 'Ação bloqueada até reabertura.' : 'Aguardando evidência anterior.'}</p>
            <footer>{gate.states.join(' · ')}</footer>
          </div>
        ))}
      </div>
    </section>
  );
}

function DashboardGrid({ dashboard, onAction, onOpenLog, onInspect, inspection }: { dashboard: DashboardSnapshot; onAction: (action: DashboardAction) => void; onOpenLog: (id: string) => void; onInspect: () => void; inspection: Record<string, unknown> | null }) {
  const context = dashboard.context as { currentEvidence?: { outcome?: string; commitRef?: string; validations?: Array<{ purpose: string; result: string; profileKey: string; durationMs: number; reused: boolean }> }; authorization?: { instruction: string; allowedEffects: string[]; forbiddenEffects: string[] }; baselines?: Array<{ repository: string; branch: string; sha: string; dirty: boolean }>; acceptanceCriteria?: Array<{ key: string; statement: string }>; durableDecisions?: Array<{ key: string; title: string }> };
  const record = dashboard.record as { tests?: Array<{ key: string; name: string; purpose: string }>; reviews?: Array<{ verdict: string; reviewer: string; summary: string }> };
  return (
    <div className="dashboard-grid">
      <div className="stack">
        <section className="panel workbench-panel">
          <PanelHeader title={`${dashboard.item.key} · ${dashboard.feature.key}`} meta={`sha: ${dashboard.item.currentSha ?? '—'} · fase: ${dashboard.item.phaseKey}`} />
          <div className="workbench-content"><div className="workbench-heading"><span className="state-badge">{dashboard.item.state}</span><span className="mono muted">TDD: {dashboard.item.tddPolicy}</span></div><h2>{dashboard.item.title}</h2><p>{dashboard.item.summary ?? dashboard.feature.summary}</p></div>
          <div className="directive"><div className="directive-top"><span className="directive-label">→ PRÓXIMA AÇÃO REQUERIDA NO LEDGER</span><span className="chip">EXPECTED: {dashboard.availableActions.find((action) => action.kind === 'primary')?.label ?? 'INSPEÇÃO'}</span></div><p>{context.currentEvidence?.outcome ?? 'Acompanhe o estado e registre a próxima evidência autorizada.'}</p><div className="directive-meta"><span>Baselines: {context.baselines?.length ?? 0}</span><span>Próximos: <b>{dashboard.item.state}</b></span></div></div>
          <div className="action-row"><div className="button-group">{dashboard.availableActions.filter((action) => ['primary', 'danger'].includes(action.kind)).slice(0, 2).map((action) => <ActionButton key={action.id} action={action} onClick={() => onAction(action)} />)}</div><span className="worktree-status"><i /> Worktree isolada monitorada</span></div>
        </section>
        <Harness dashboard={dashboard} context={context} record={record} />
      </div>
      <div className="stack">
        <Evidence dashboard={dashboard} onOpenLog={onOpenLog} />
        <Pending dashboard={dashboard} onAction={onAction} onInspect={onInspect} inspection={inspection} />
        <RecentSlices dashboard={dashboard} />
      </div>
    </div>
  );
}

function Harness({ dashboard, context, record }: { dashboard: DashboardSnapshot; context: { currentEvidence?: { validations?: Array<{ purpose: string; result: string; durationMs: number }> }; baselines?: Array<{ dirty: boolean }> }; record: { tests?: Array<{ key: string; name: string }> } }) {
  const failed = dashboard.validations.find((validation) => validation.resultKind !== 'PASS');
  const passing = dashboard.validations.filter((validation) => validation.resultKind === 'PASS').length;
  const evidenceTotal = Math.max(dashboard.validations.length, record.tests?.length ?? 0);
  return <section className="panel harness-panel"><PanelHeader title="DIAGNÓSTICO DO HARNESS TDD" icon="⌁" meta={`${passing}/${evidenceTotal} evidências`} /><div className="diagnostic-grid"><Diagnostic label="TARGET SPEC" value={record.tests?.[0]?.name ?? 'testes do work item'} detail={`${record.tests?.length ?? 0} testes definidos`} /><Diagnostic label="FAILING ASSERTION" value={failed?.resultKind ?? 'Nenhuma falha'} detail={failed ? `${failed.purpose} · ${formatDuration(failed.durationMs)}` : 'baseline verde'} danger={Boolean(failed)} /><Diagnostic label="ÚLTIMA EXECUÇÃO" value={dashboard.validations[0] ? formatTime(dashboard.validations[0].createdAt) : 'Ainda não executado'} detail={`${context.baselines?.filter((baseline) => !baseline.dirty).length ?? 0} baseline(s) limpa(s)`} /></div></section>;
}

function Diagnostic({ label, value, detail, danger }: { label: string; value: string; detail: string; danger?: boolean }) { return <div className={`diagnostic ${danger ? 'danger' : ''}`}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>; }

function Evidence({ dashboard, onOpenLog }: { dashboard: DashboardSnapshot; onOpenLog: (id: string) => void }) {
  return <section className="panel evidence-panel"><PanelHeader title="COMPROVANTES AUDITÁVEIS" icon="▣" meta={<span className="sync"><i /> SYNC ATIVO</span>} />{dashboard.validations.length ? <div className="evidence-list">{dashboard.validations.slice(0, 4).map((validation) => <article className={`evidence ${validation.resultKind === 'PASS' ? 'pass' : validation.resultKind === 'TEST_FAILURE' ? 'fail' : 'warn'}`} key={validation.id}><div className="evidence-head"><span><StatusDot status={validation.resultKind === 'PASS' ? 'complete' : validation.resultKind === 'TEST_FAILURE' ? 'blocked' : 'pending'} /> <b>{validation.purpose} · {validation.resultKind.replaceAll('_', ' ')}</b></span><time>{formatTime(validation.createdAt)}</time></div><p>{validation.summary.testsTotal ? `${validation.summary.testsTotal} teste(s) analisado(s).` : `Perfil ${validation.profileKey} executado com resultado ${validation.resultKind}.`}</p><div className="evidence-code"><span>&gt; {validation.profileKey} · {formatDuration(validation.durationMs)}</span><b>{validation.resultKind === 'PASS' ? 'PASS' : validation.resultKind}</b></div>{validation.logAvailable && <button className="text-button" onClick={() => onOpenLog(validation.id)}>Abrir log retido</button>}</article>)}</div> : <EmptyState title="Sem validações registradas" detail="A primeira evidência aparecerá após a execução autorizada." />}</section>;
}

function Pending({ dashboard, onAction, onInspect, inspection }: { dashboard: DashboardSnapshot; onAction: (action: DashboardAction) => void; onInspect: () => void; inspection: Record<string, unknown> | null }) {
  const block = dashboard.availableActions.find((action) => action.id === 'BLOCK');
  const reinspect = dashboard.availableActions.find((action) => action.id === 'REINSPECT');
  return <section className="panel pending-panel"><PanelHeader title="PENDÊNCIAS & AVISOS" icon="△" meta={`${dashboard.pendingItems.filter((item) => !item.resolved).length} pendentes`} />{dashboard.pendingItems.length ? <div className="pending-list">{dashboard.pendingItems.map((item) => <article key={item.key} className={item.blocking ? 'blocking' : ''}><div className="pending-head"><b>{item.key}</b><span>{item.blocking ? 'BLOQUEANTE' : 'AVISO'}</span></div><p>{item.description}</p></article>)}</div> : <EmptyState title="Nenhuma pendência" detail="O contexto atual não possui itens pendentes." />}<div className="panel-actions">{reinspect && <button className="secondary-button" onClick={onInspect}>Re-inspecionar árvore</button>}{block && <ActionButton action={block} onClick={() => onAction(block)} />}</div>{inspection && <pre className="inspection-result">{JSON.stringify(inspection, null, 2)}</pre>}</section>;
}

function RecentSlices({ dashboard }: { dashboard: DashboardSnapshot }) { return <section className="panel recent-panel"><PanelHeader title="ÚLTIMAS FATIAS FECHADAS" meta="SELADAS NO LEDGER" />{dashboard.recentSlices.length ? <div className="recent-list">{dashboard.recentSlices.map((slice) => <article key={slice.key}><div><b>{slice.key}</b><StatusDot status="complete" /></div><p>{slice.title}</p><small>{slice.currentSha ?? 'sem SHA'} · {slice.state}</small></article>)}</div> : <EmptyState title="Ainda sem histórico" detail="Fatias fechadas aparecerão aqui." />}</section>; }

function FeaturesView({ dashboard, catalog, onFeature, onItem }: { dashboard: DashboardSnapshot; catalog: DashboardCatalogProject[]; onFeature: (key: string) => void; onItem: (key: string) => void }) {
  const project = catalog.find((candidate) => candidate.key === dashboard.selection.projectKey);
  const selectedFeature = project?.features.find((candidate) => candidate.key === dashboard.selection.featureKey);
  const items = selectedFeature?.items ?? [];
  const openItems = items.filter((item) => item.state !== 'CLOSED').length;

  return (
    <div className="feature-view-stack">
      <section className="panel feature-catalog">
        <PanelHeader title="CATÁLOGO DE FEATURES" meta={`${project?.features.length ?? 0} no projeto`} />
        <div className="feature-cards">
          {(project?.features ?? []).map((feature) => {
            const featureOpenItems = feature.items.filter((item) => item.state !== 'CLOSED').length;
            return (
              <button
                type="button"
                key={feature.key}
                className={`feature-card ${feature.key === dashboard.feature.key ? 'selected' : ''}`}
                aria-pressed={feature.key === dashboard.feature.key}
                onClick={() => onFeature(feature.key)}
              >
                <span className="feature-card-head"><b>{feature.key}</b><small>{feature.status}</small></span>
                <strong>{feature.name}</strong>
                <span className="feature-card-count">{feature.items.length} fatias · {featureOpenItems ? `${featureOpenItems} abertas` : 'todas fechadas'}</span>
                <small>{feature.currentPhaseKey ? `fase ${feature.currentPhaseKey}` : 'fase não definida'}</small>
              </button>
            );
          })}
        </div>
      </section>

      <section className="panel feature-view">
        <PanelHeader title={`FATIAS · ${dashboard.feature.key}`} meta={`${items.length} no catálogo`} />
        <div className="feature-summary">
          <div className="feature-summary-top"><span className="state-badge">{dashboard.feature.status}</span><span className="feature-open-count">{openItems ? `${openItems} abertas` : 'todas fechadas'}</span></div>
          <h2>{dashboard.feature.name}</h2>
          <p>{dashboard.feature.summary}</p>
        </div>
        <div className="slice-list" role="list" aria-label={`Fatias da feature ${dashboard.feature.key}`}>
          {items.map((item) => {
            const current = item.key === dashboard.item.key;
            const status = item.state === 'CLOSED' ? 'complete' : item.state === 'BLOCKED' ? 'blocked' : current ? 'active' : 'pending';
            return (
              <button type="button" key={item.key} className={`slice-row ${current ? 'selected' : ''}`} aria-current={current ? 'true' : undefined} onClick={() => onItem(item.key)}>
                <span className="slice-position">{String(item.position).padStart(2, '0')}</span>
                <span className="slice-main"><b>{item.key} · {item.title}</b><small>{item.phaseKey} · {item.state}</small></span>
                <StatusDot status={status} />
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function ExecutionView({ dashboard, primaryAction, onAction, onOpenLog }: { dashboard: DashboardSnapshot; primaryAction?: DashboardAction; onAction: (action: DashboardAction) => void; onOpenLog: (id: string) => void }) { return <div className="single-view"><section className="panel"><PanelHeader title="FATIA EM EXECUÇÃO" meta={dashboard.item.state} /><div className="execution-hero"><span className="state-badge">{dashboard.item.key}</span><h2>{dashboard.item.title}</h2><p>{dashboard.item.summary}</p>{primaryAction && <ActionButton action={primaryAction} onClick={() => onAction(primaryAction)} />}</div></section><Evidence dashboard={dashboard} onOpenLog={onOpenLog} /></div>; }
function ReviewView({ dashboard, onAction, onOpenLog }: { dashboard: DashboardSnapshot; onAction: (action: DashboardAction) => void; onOpenLog: (id: string) => void }) { const review = dashboard.validations.length ? dashboard.validations[0] : undefined; const action = dashboard.availableActions.find((candidate) => candidate.id === 'SUBMIT_REVIEW'); return <div className="single-view"><section className="panel"><PanelHeader title="REVISÃO & EVIDÊNCIAS" meta={dashboard.item.state} /><div className="review-hero"><h2>{dashboard.item.title}</h2><p>Verifique as evidências atuais, findings e critérios antes de emitir o veredito.</p>{action && <ActionButton action={action} onClick={() => onAction(action)} />}{review && <div className="review-stat">Última execução: <b>{review.resultKind}</b></div>}</div></section><Evidence dashboard={dashboard} onOpenLog={onOpenLog} /></div>; }
function ContextView({ dashboard }: { dashboard: DashboardSnapshot }) { return <section className="panel context-view"><PanelHeader title="CONTEXTO OPERACIONAL" meta={`${dashboard.selection.projectKey} / ${dashboard.selection.featureKey} / ${dashboard.selection.itemKey}`} /><pre>{JSON.stringify(dashboard.context, null, 2)}</pre></section>; }

function ShortcutBar({ dashboard, onAction }: { dashboard: DashboardSnapshot; onAction: (action: DashboardAction) => void }) { const compact = dashboard.availableActions.find((action) => action.id === 'COMPACT_HISTORY'); return <section className="shortcuts"><div><b>ATALHOS DO LEDGER</b><span>•</span><span>Ambiente local seguro</span></div><div className="button-group">{compact && <button className="secondary-button" onClick={() => onAction(compact)}>Compactar histórico</button>}<button className="secondary-button" onClick={() => navigator.clipboard?.writeText(JSON.stringify(dashboard.context))}>Copiar contexto</button><button className="secondary-button" onClick={() => window.print()}>Diagnóstico / imprimir</button></div></section>; }
function Footer({ dashboard }: { dashboard: DashboardSnapshot | null }) { return <footer className="footer"><span>WT: {dashboard?.item.currentSha?.slice(0, 7) ?? '—'} <b>[SYNCED]</b> · SANDBOX: TDD_STRICT · ISOLATION: ENABLED</span><span>Workflow Ledger · verificação determinística local</span></footer>; }

function ActionDialog({ modal, dashboard, logLoading, logText, onClose, onSubmit }: { modal: NonNullable<ModalState>; dashboard: DashboardSnapshot | null; logLoading: boolean; logText: string | null; onClose: () => void; onSubmit: (fields: Record<string, unknown>) => void }) {
  const action = modal.action;
  const [fields, setFields] = useState<Record<string, unknown>>(() => defaultActionFields(action, dashboard));
  const [submitting, setSubmitting] = useState(false);
  const set = (key: string, value: unknown) => setFields((current) => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent) => { event.preventDefault(); setSubmitting(true); try { await onSubmit(fields); } finally { setSubmitting(false); } };
  if (modal.logValidationId) return <div className="modal-backdrop" role="presentation"><section className="dialog log-dialog" role="dialog" aria-modal="true" aria-labelledby="log-title"><div className="dialog-head"><div><span className="eyebrow">LOG RETIDO · {modal.logValidationId.slice(0, 8)}</span><h2 id="log-title">Saída bruta da validação</h2></div><button className="icon-button" onClick={onClose} aria-label="Fechar">×</button></div><p className="warning-copy">Conteúdo armazenado por até sete dias. Renderizado como texto, sem execução.</p>{logLoading ? <div className="dialog-loading">Carregando log…</div> : <pre className="raw-log">{logText}</pre>}</section></div>;
  return <div className="modal-backdrop" role="presentation"><form className="dialog" role="dialog" aria-modal="true" onSubmit={submit}><div className="dialog-head"><div><span className="eyebrow">AÇÃO DO LEDGER</span><h2>{action.label}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="Fechar">×</button></div><p className="dialog-help">A operação será revalidada contra o estado atual antes de ser aplicada.</p><ActionFields action={action} dashboard={dashboard} fields={fields} set={set} /><div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancelar</button><button type="submit" className="primary-button" disabled={submitting}>{submitting ? 'Registrando…' : 'Confirmar ação'}</button></div></form></div>;
}

function ActionFields({ action, dashboard, fields, set }: { action: DashboardAction; dashboard: DashboardSnapshot | null; fields: Record<string, unknown>; set: (key: string, value: unknown) => void }) {
  const input = (key: string, label: string, placeholder: string, required = true) => <label className="field">{label}<input required={required} value={String(fields[key] ?? '')} placeholder={placeholder} onChange={(event) => set(key, event.target.value)} /></label>;
  if (action.id === 'RUN_RED' || action.id === 'RUN_GREEN' || action.id === 'RUN_CHECK') return <div className="field-grid">{input('repositoryKey', 'Repositório', action.options?.repositoryKeys?.[0] ?? 'repo')} {input('profileKey', 'Perfil de validação', action.options?.profileKeys?.[0] ?? 'unit')} {action.id === 'RUN_RED' && input('reason', 'Motivo (se RED estrutural)', 'Justificativa opcional', false)}</div>;
  if (action.id === 'AUTHORIZE') return <div className="field-grid">{input('actor', 'Ator', 'dev-local')} {input('instruction', 'Instrução autorizada', 'Implementar somente o escopo da fatia')} {input('repositoryKeys', 'Repositórios (separados por vírgula)', dashboard?.repositories.map((repo) => repo.key).join(',') ?? '')}<label className="field field-wide">Efeitos permitidos<textarea value={String(fields.allowedEffects ?? '')} onChange={(event) => set('allowedEffects', event.target.value.split('\n').filter(Boolean))} placeholder="código local" /></label><label className="field field-wide">Efeitos proibidos<textarea value={String(fields.forbiddenEffects ?? '')} onChange={(event) => set('forbiddenEffects', event.target.value.split('\n').filter(Boolean))} placeholder="provider real" /></label></div>;
  if (action.id === 'SUBMIT_REVIEW') return <div className="field-grid">{input('reviewer', 'Revisor', 'operator')}<label className="field">Veredito<select value={String(fields.verdict ?? 'APPROVED')} onChange={(event) => set('verdict', event.target.value)}><option>APPROVED</option><option>CHANGES_REQUIRED</option><option>BLOCKED</option></select></label>{input('summary', 'Resumo', 'Evidências verificadas e risco residual')}<label className="field">Modo<select value={String(fields.reviewMode ?? 'SELF')} onChange={(event) => set('reviewMode', event.target.value)}><option>SELF</option><option>INDEPENDENT</option></select></label></div>;
  if (action.id === 'CLOSE') return <div className="field-grid">{input('commitSha', 'SHA do commit', dashboard?.item.currentSha ?? 'sha-1')}</div>;
  if (action.id === 'REINSPECT') return <div className="field-grid">{input('repositoryKey', 'Repositório', action.options?.repositoryKeys?.[0] ?? 'repo')}</div>;
  if (action.id === 'COMPACT_HISTORY') return <div className="field-grid">{input('keepRecent', 'Fatias recentes preservadas', '2')}</div>;
  if (action.id === 'REOPEN') return <div className="field-grid">{input('actor', 'Ator', 'operator')}{input('reason', 'Motivo da reabertura', 'Retomar após correção do bloqueio')}</div>;
  if (action.id === 'APPROVE_TDD_EXCEPTION' || action.id === 'BLOCK' || action.id === 'INVALIDATE_GREEN') return <div className="field-grid">{input('reason', action.id === 'BLOCK' ? 'Motivo do bloqueio' : action.id === 'INVALIDATE_GREEN' ? 'Motivo da invalidação' : 'Justificativa TDD', action.id === 'INVALIDATE_GREEN' ? 'A worktree mudou depois do GREEN' : 'Descreva a decisão e o risco')}{action.id === 'BLOCK' && input('actor', 'Ator', 'operator', false)}</div>;
  return <p className="confirm-copy">Confirmar transição de <b>{dashboard?.item.state}</b> para a próxima etapa?</p>;
}

function PanelHeader({ title, icon, meta }: { title: string; icon?: string; meta?: ReactNode }) { return <div className="panel-header"><span>{icon && <b className="panel-icon">{icon}</b>}{title}</span>{meta && <small>{meta}</small>}</div>; }
function StatusDot({ status }: { status: string }) { return <i className={`status-dot ${status}`} aria-label={status} />; }
function ActionButton({ action, onClick }: { action: DashboardAction; onClick: () => void }) { return <button className={`${action.kind === 'primary' ? 'primary-button' : action.kind === 'danger' ? 'danger-button' : 'secondary-button'}`} onClick={onClick} disabled={!action.enabled} title={action.reason}>{action.label}</button>; }
function InlineNotice({ tone, message, onClose }: { tone: 'error' | 'success'; message: string; onClose: () => void }) { return <div className={`inline-notice ${tone}`} role="status"><span>{message}</span><button onClick={onClose} aria-label="Fechar aviso">×</button></div>; }
function EmptyState({ title, detail }: { title: string; detail: string }) { return <div className="empty-state"><strong>{title}</strong><span>{detail}</span></div>; }
function LoadingShell() { return <div className="loading-shell"><div className="loading-bar" /><span>Conectando ao ledger local…</span></div>; }
function findAction(dashboard: DashboardSnapshot, id: DashboardActionId): DashboardAction { return dashboard.availableActions.find((action) => action.id === id) ?? { id, label: id, kind: 'maintenance', enabled: true }; }
function defaultActionFields(action: DashboardAction, dashboard: DashboardSnapshot | null): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  const repositoryKey = action.options?.repositoryKeys?.[0] ?? dashboard?.repositories[0]?.key;
  const profileKey = action.options?.profileKeys?.[0] ?? dashboard?.repositories[0]?.profiles[0]?.key;
  if (repositoryKey) defaults.repositoryKey = repositoryKey;
  if (profileKey) defaults.profileKey = profileKey;
  if (action.id === 'AUTHORIZE') defaults.repositoryKeys = dashboard?.repositories.map((repository) => repository.key).join(',') ?? '';
  if (action.id === 'COMPACT_HISTORY') defaults.keepRecent = '2';
  if (action.id === 'SUBMIT_REVIEW') { defaults.verdict = 'APPROVED'; defaults.reviewMode = 'SELF'; }
  return defaults;
}
function formatTime(value: string) { return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
function formatDuration(ms: number) { return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`; }
function readSelection(): Selection { const params = new URLSearchParams(window.location.search); return { projectKey: params.get('projectKey') ?? undefined, featureKey: params.get('featureKey') ?? undefined, itemKey: params.get('itemKey') ?? undefined }; }
function readView(): View { const value = new URLSearchParams(window.location.search).get('view'); return ['dashboard', 'features', 'execution', 'review', 'context'].includes(value ?? '') ? value as View : 'dashboard'; }
function writeSelection(selection: { projectKey: string; featureKey: string; itemKey: string }) { const url = new URL(window.location.href); for (const [key, value] of Object.entries(selection)) url.searchParams.set(key, value); window.history.replaceState({}, '', url); }
function writeView(view: View) { const url = new URL(window.location.href); url.searchParams.set('view', view); window.history.replaceState({}, '', url); }
