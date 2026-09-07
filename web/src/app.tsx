import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import type {
  DashboardAction,
  DashboardActionId,
  DashboardCatalogItem,
  DashboardCatalogProject,
  DashboardSnapshot,
  DashboardValidation,
  PlanCheckResult,
} from '../../../src/application/types.js';

type View = 'now' | 'project';
type Selection = { projectKey?: string; featureKey?: string; itemKey?: string };
type ModalState = { action: DashboardAction; logValidationId?: string; planCheck?: boolean } | null;

type ContextShape = {
  current?: { nextAllowedTransition?: string };
  authorization?: {
    instruction: string;
    actor?: string;
    allowedEffects: string[];
    forbiddenEffects: string[];
  };
  acceptanceCriteria?: Array<{ key: string; statement: string }>;
  unresolvedItems?: Array<{ key: string; description: string; blocking: boolean }>;
  requiredChecks?: Array<{ key: string; description: string; status: string }>;
};

type RecordShape = {
  tests?: Array<{ key: string; name: string; purpose: string; status?: string }>;
  authorization?: ContextShape['authorization'];
  lineage?: {
    parent?: { key: string; title: string; state: string };
    children: Array<{ key: string; title: string; state: string }>;
  };
};

type Pendency = { key: string; description: string; blocking: boolean; resolved?: boolean };

const sliceSteps = [
  { key: 'authorize', label: 'Autorização', states: ['DRAFT', 'READY', 'AUTHORIZED'] },
  { key: 'tests', label: 'Testes', states: ['TESTS_DEFINED', 'RED_CONFIRMED', 'TDD_EXCEPTION_APPROVED'] },
  { key: 'build', label: 'Execução', states: ['IMPLEMENTING', 'GREEN_CONFIRMED'] },
  { key: 'review', label: 'Revisão', states: ['READY_FOR_REVIEW', 'APPROVED', 'CHANGES_REQUIRED'] },
  { key: 'done', label: 'Conclusão', states: ['CLOSED'] },
] as const;

const stateCopy: Record<string, { status: string; detail: string }> = {
  DRAFT: { status: 'Na fila', detail: 'Esta etapa ainda não foi liberada. O agente não deve executá-la.' },
  READY: { status: 'Aguardando autorização', detail: 'A etapa está pronta. Autorize o agente para ele começar.' },
  AUTHORIZED: { status: 'Autorizada', detail: 'O agente já pode começar. Próximo: definir os testes desta etapa.' },
  TESTS_DEFINED: { status: 'Testes definidos', detail: 'O agente definiu os testes. Próximo: registrar a evidência RED.' },
  RED_CONFIRMED: { status: 'Pronto para implementar', detail: 'A evidência RED foi confirmada. O agente deve implementar a etapa.' },
  TDD_EXCEPTION_APPROVED: { status: 'Exceção aprovada', detail: 'A etapa segue sem RED. O agente pode implementar.' },
  IMPLEMENTING: { status: 'Em execução', detail: 'O agente está implementando esta etapa. Acompanhe o andamento aqui, sem perguntar a ele.' },
  GREEN_CONFIRMED: { status: 'Evidência verde', detail: 'A implementação passou. Próximo: enviar para revisão.' },
  READY_FOR_REVIEW: { status: 'Aguardando revisão', detail: 'A etapa está pronta para revisão. Confira as evidências abaixo.' },
  APPROVED: { status: 'Aprovada', detail: 'A revisão foi aceita. Próximo: encerrar a etapa com o commit.' },
  CHANGES_REQUIRED: { status: 'Ajustes pedidos', detail: 'A revisão pediu mudanças. O agente deve voltar aos testes.' },
  BLOCKED: { status: 'Pausada', detail: 'A execução desta etapa está bloqueada até ser reaberta.' },
  CLOSED: { status: 'Concluída', detail: 'Esta etapa já foi encerrada.' },
};

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
  const [planReport, setPlanReport] = useState<PlanCheckResult | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
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
      query.set('view', view === 'project' ? 'features' : 'dashboard');
      const response = await fetch(`/api/dashboard?${query.toString()}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(payload.message ?? 'Não foi possível carregar o andamento');
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
    const feature = pickActiveFeature(project?.features ?? []);
    const item = pickActiveItem(feature?.items ?? []);
    setSelection({ projectKey, featureKey: feature?.key, itemKey: item?.key });
  };
  const selectFeature = (featureKey: string) => {
    const project = catalog.find((candidate) => candidate.key === (selection.projectKey ?? dashboard?.selection.projectKey));
    const feature = project?.features.find((candidate) => candidate.key === featureKey);
    const item = pickActiveItem(feature?.items ?? []);
    setSelection({ projectKey: project?.key, featureKey, itemKey: item?.key });
  };
  const selectItem = (itemKey: string, follow = false) => {
    setSelection({ ...selection, itemKey });
    if (follow) {
      setView('now');
      writeView('now');
    }
  };

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

  const openPlanCheck = async () => {
    if (!dashboard) return;
    setModal({ action: { id: 'PLAN_CHECK', label: 'Auditoria do planejamento', kind: 'maintenance', enabled: true }, planCheck: true });
    setPlanLoading(true);
    try {
      const query = new URLSearchParams({
        projectKey: dashboard.selection.projectKey,
        featureKey: dashboard.selection.featureKey,
      });
      const response = await fetch(`/api/plan-check?${query.toString()}`);
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { message?: string };
        throw new Error(payload.message ?? 'Auditoria indisponível');
      }
      setPlanReport(await response.json() as PlanCheckResult);
    } catch (cause) {
      setPlanReport(null);
      setModal(null);
      setError(cause instanceof Error ? cause.message : 'Auditoria indisponível');
    } finally {
      setPlanLoading(false);
    }
  };

  const handleAction = (action: DashboardAction) => {
    if (action.id === 'PLAN_CHECK') {
      void openPlanCheck();
      return;
    }
    setModal({ action });
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
        onView={(next) => { setView(next); writeView(next); }}
        onRefresh={() => void loadDashboard(true)}
      />
      <main className="page-shell">
        {error && <InlineNotice tone="error" message={error} onClose={() => setError(null)} />}
        {notice && <InlineNotice tone="success" message={notice} onClose={() => setNotice(null)} />}
        {!dashboard ? (
          <EmptyState title="Nenhuma etapa disponível" detail="Importe um workflow pelo CLI ou MCP para começar a acompanhar." />
        ) : view === 'now' ? (
          <NowView
            dashboard={dashboard}
            catalog={catalog}
            primaryAction={primaryAction}
            inspection={inspection}
            onSelectItem={(itemKey) => selectItem(itemKey)}
            onOpenProject={() => { setView('project'); writeView('project'); }}
            onAction={handleAction}
            onOpenLog={openLog}
          />
        ) : (
          <ProjectView
            dashboard={dashboard}
            catalog={catalog}
            onFeature={selectFeature}
            onItem={(itemKey) => selectItem(itemKey, true)}
          />
        )}
      </main>
      {modal && (
        <ActionDialog
          modal={modal}
          dashboard={dashboard}
          logLoading={logLoading}
          logText={logText}
          planLoading={planLoading}
          planReport={planReport}
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
  onView: (view: View) => void;
  onRefresh: () => void;
}) {
  const projectKey = props.dashboard?.selection.projectKey ?? props.selection.projectKey ?? '';
  const featureKey = props.dashboard?.selection.featureKey ?? props.selection.featureKey ?? '';
  const itemKey = props.dashboard?.selection.itemKey ?? props.selection.itemKey ?? '';
  const project = props.catalog.find((candidate) => candidate.key === projectKey);
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand-lockup">
          <div className="brand-mark">W</div>
          <span className="brand-name">Workflow</span>
          <span className="slash">/</span>
          <select aria-label="Projeto" className="repo-select" value={projectKey} onChange={(event) => props.onProject(event.target.value)}>
            <option value="">Selecionar projeto</option>
            {props.catalog.map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.name}</option>)}
          </select>
        </div>
        <nav className="main-nav" aria-label="Visões do acompanhamento">
          <button className={`nav-button ${props.view === 'now' ? 'active' : ''}`} aria-current={props.view === 'now' ? 'page' : undefined} onClick={() => props.onView('now')}>Agora</button>
          <button className={`nav-button ${props.view === 'project' ? 'active' : ''}`} aria-current={props.view === 'project' ? 'page' : undefined} onClick={() => props.onView('project')}>Entrega</button>
        </nav>
        <div className="topbar-tools">
          <span className={`live-status ${props.refreshing ? 'busy' : ''}`}><i /> {props.refreshing ? 'Atualizando' : 'Ao vivo'}</span>
          <button className="icon-button" onClick={props.onRefresh} aria-label="Atualizar andamento">↻</button>
        </div>
      </div>
      {props.view === 'now' && props.dashboard && (
        <div className="crumbbar">
          <button type="button" className="crumb-link" onClick={() => props.onView('project')}>{props.dashboard.feature.key} · {props.dashboard.feature.name}</button>
          <span className="slash">/</span>
          <span>etapa {itemKey}</span>
        </div>
      )}
      {props.view === 'project' && project && (
        <div className="crumbbar">
          <label>Entrega
            <select aria-label="Entrega" value={featureKey} onChange={(event) => props.onFeature(event.target.value)}>
              {sortFeatures(project.features).map((candidate) => (
                <option key={candidate.key} value={candidate.key}>{candidate.key} · {candidate.name}</option>
              ))}
            </select>
          </label>
        </div>
      )}
    </header>
  );
}

function NowView(props: {
  dashboard: DashboardSnapshot;
  catalog: DashboardCatalogProject[];
  primaryAction?: DashboardAction;
  inspection: Record<string, unknown> | null;
  onSelectItem: (itemKey: string) => void;
  onOpenProject: () => void;
  onAction: (action: DashboardAction) => void;
  onOpenLog: (id: string) => void;
}) {
  const { dashboard } = props;
  const context = dashboard.context as ContextShape;
  const record = dashboard.record as RecordShape;
  const items = currentFeatureItems(props.catalog, dashboard);
  const position = Math.max(1, items.findIndex((item) => item.key === dashboard.item.key) + 1);
  const closed = items.filter((item) => item.state === 'CLOSED').length;
  const copy = describeNow(dashboard.item.state, context.current?.nextAllowedTransition);
  const auth = context.authorization || record.authorization
    ? {
        instruction: (context.authorization ?? record.authorization)?.instruction ?? '',
        actor: context.authorization?.actor ?? record.authorization?.actor,
        allowedEffects: (context.authorization ?? record.authorization)?.allowedEffects ?? [],
        forbiddenEffects: (context.authorization ?? record.authorization)?.forbiddenEffects ?? [],
      }
    : undefined;
  const lineage = record.lineage;
  const progressRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const track = progressRef.current;
    if (!track) return;
    const current = track.querySelector<HTMLElement>('[aria-current="step"]');
    if (!current) return;
    track.scrollLeft = Math.max(0, current.offsetLeft - (track.clientWidth - current.offsetWidth) / 2);
  }, [dashboard.item.key]);
  const criteria = context.acceptanceCriteria ?? [];
  const pendencies = resolvePendencies(dashboard, context);
  const checks = context.requiredChecks ?? record.tests?.map((test) => ({
    key: test.key,
    description: test.name,
    status: test.status ?? 'PENDING',
  })) ?? [];

  return (
    <div className="now-layout">
      <section className="hero" aria-labelledby="now-title">
        <div className="hero-kicker">
          <span>{dashboard.feature.key}</span>
          <span>etapa {position} de {items.length || 1}</span>
          <span className={`status-pill ${stateTone(dashboard.item.state)}`}>{copy.status}</span>
        </div>
        <h1 id="now-title">{dashboard.item.title}</h1>
        <p className="hero-lead">{copy.detail}</p>
        {dashboard.item.summary && dashboard.item.summary !== copy.detail && (
          <p className="hero-summary">{dashboard.item.summary}</p>
        )}
        {auth && (
          <div className="auth-card">
            <span className="auth-label">Você autorizou {auth.actor ? `${auth.actor}` : 'o agente'}</span>
            <p>{auth.instruction}</p>
            <div className="effect-row">
              {auth.forbiddenEffects.slice(0, 4).map((effect) => <span key={effect} className="chip danger">{effect}</span>)}
            </div>
          </div>
        )}
        {dashboard.lease && (
          <div className="auth-card">
            <span className="auth-label">{dashboard.lease.active ? 'Fatia reservada por um agente' : 'Reserva de fatia expirada'}</span>
            <p>{dashboard.lease.holder} · {dashboard.lease.active ? 'até' : 'expirou em'} {formatTime(dashboard.lease.expiresAt)}</p>
          </div>
        )}
        {lineage && (lineage.parent || lineage.children.length > 0) && (
          <div className="auth-card">
            <span className="auth-label">Linhagem de replanejamento</span>
            {lineage.parent && (
              <p>Origem: {lineage.parent.key} · {lineage.parent.title} ({humanState(lineage.parent.state)})</p>
            )}
            {lineage.children.length > 0 && (
              <p>Derivadas: {lineage.children.map((child) => `${child.key} · ${child.title}`).join(' | ')}</p>
            )}
          </div>
        )}
        <StepRail state={dashboard.item.state} />
      </section>

      <section className="panel progress-panel">
        <PanelHeader
          title={`Progresso de ${dashboard.feature.key}`}
          meta={`${closed} de ${items.length} concluídas`}
        />
        <div className="progress-track" role="list" aria-label={`Etapas de ${dashboard.feature.key}`} ref={progressRef}>
          {items.map((item) => {
            const current = item.key === dashboard.item.key;
            return (
              <button
                type="button"
                key={item.key}
                role="listitem"
                className={`progress-chip ${item.state === 'CLOSED' ? 'done' : ''} ${current ? 'current' : ''} ${item.state === 'BLOCKED' ? 'blocked' : ''}`}
                aria-current={current ? 'step' : undefined}
                onClick={() => props.onSelectItem(item.key)}
                title={`${item.key} · ${item.title}`}
              >
                <b>{item.key}</b>
                <span>{item.title}</span>
                <small>{humanState(item.state)}</small>
              </button>
            );
          })}
        </div>
        <button type="button" className="text-button progress-link" onClick={props.onOpenProject}>Ver todas as entregas</button>
      </section>

      <div className="now-grid">
        <section className="panel">
          <PanelHeader title="O que precisa ficar pronto" meta={criteria.length ? `${criteria.length} ${criteria.length === 1 ? 'critério' : 'critérios'}` : undefined} />
          {criteria.length ? (
            <ol className="criteria-list">
              {criteria.map((criterion) => (
                <li key={criterion.key}>
                  <b>{criterion.key}</b>
                  <span>{criterion.statement}</span>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState title="Sem critérios listados" detail="Quando o agente definir os critérios, eles aparecem aqui." />
          )}
          {checks.length > 0 && (
            <ul className="check-list" aria-label="Checagens previstas">
              {checks.map((check) => (
                <li key={check.key}>
                  <i className={`status-dot ${check.status === 'PENDING' ? 'pending' : 'complete'}`} />
                  <span>{check.description}</span>
                  <small>{check.status === 'PENDING' ? 'pendente' : check.status.toLowerCase()}</small>
                </li>
              ))}
            </ul>
          )}
        </section>

        <div className="stack">
          <section className="panel">
            <PanelHeader title="O que já aconteceu" meta={dashboard.validations.length ? `${dashboard.validations.length} evidências` : 'ainda sem evidências'} />
            {dashboard.validations.length ? (
              <div className="evidence-list">
                {dashboard.validations.slice(0, 5).map((validation) => (
                  <EvidenceCard key={validation.id} validation={validation} onOpenLog={props.onOpenLog} />
                ))}
              </div>
            ) : (
              <EmptyState title="Nenhuma evidência ainda" detail="Quando o agente registrar RED, GREEN ou CHECK, o resultado aparece aqui." />
            )}
          </section>

          <section className="panel">
            <PanelHeader title="Pendências" meta={`${pendencies.filter((item) => !item.resolved).length} abertas`} />
            {pendencies.length ? (
              <div className="pending-list">
                {pendencies.map((item) => (
                  <article key={item.key} className={item.blocking ? 'blocking' : ''}>
                    <div className="pending-head"><b>{item.key}</b><span>{item.blocking ? 'bloqueia' : 'aviso'}</span></div>
                    <p>{item.description}</p>
                  </article>
                ))}
              </div>
            ) : (
              <EmptyState title="Nada pendente" detail="Não há bloqueios abertos nesta etapa." />
            )}
          </section>
        </div>
      </div>

      <Intervene dashboard={dashboard} primaryAction={props.primaryAction} inspection={props.inspection} onAction={props.onAction} />
    </div>
  );
}

function ProjectView(props: {
  dashboard: DashboardSnapshot;
  catalog: DashboardCatalogProject[];
  onFeature: (featureKey: string) => void;
  onItem: (itemKey: string) => void;
}) {
  const project = props.catalog.find((candidate) => candidate.key === props.dashboard.selection.projectKey);
  const features = sortFeatures(project?.features ?? []);
  const selected = features.find((feature) => feature.key === props.dashboard.feature.key);
  const items = selected?.items ?? [];
  const openItems = items.filter((item) => item.state !== 'CLOSED').length;
  const inFlight = items.find((item) => item.state !== 'CLOSED' && item.state !== 'DRAFT') ?? items.find((item) => item.state !== 'CLOSED');

  return (
    <div className="project-layout">
      <section className="project-intro">
        <h1>Entregas</h1>
        <p>Acompanhe o que já fechou e o que o agente ainda vai executar. A etapa atual fica marcada.</p>
      </section>

      <section className="panel">
        <PanelHeader title={props.dashboard.project.name} meta={`${features.length} entregas`} />
        <div className="feature-cards">
          {features.map((feature) => {
            const total = feature.items.length;
            const done = feature.items.filter((item) => item.state === 'CLOSED').length;
            const running = feature.items.some((item) => item.state !== 'CLOSED');
            const selectedFeature = feature.key === props.dashboard.feature.key;
            return (
              <button
                type="button"
                key={feature.key}
                className={`feature-card ${selectedFeature ? 'selected' : ''} ${running ? 'running' : 'done'}`}
                aria-pressed={selectedFeature}
                onClick={() => props.onFeature(feature.key)}
              >
                <span className="feature-card-head">
                  <b>{feature.key}</b>
                  <small>{running ? 'em andamento' : 'concluída'}</small>
                </span>
                <strong>{feature.name}</strong>
                <span className="feature-meter" aria-hidden="true"><i style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></span>
                <span className="feature-card-count">{done}/{total} etapas</span>
              </button>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <PanelHeader
          title={selected ? `${selected.key} · ${selected.name}` : 'Etapas'}
          meta={openItems ? `${openItems} em aberto` : 'todas concluídas'}
        />
        {inFlight && (
          <p className="in-flight">Agora: <b>{inFlight.key} · {inFlight.title}</b> · {humanState(inFlight.state)}</p>
        )}
        <div className="slice-list" role="list" aria-label={`Etapas de ${props.dashboard.feature.key}`}>
          {items.map((item) => {
            const current = item.key === props.dashboard.item.key;
            return (
              <button type="button" key={item.key} className={`slice-row ${current ? 'selected' : ''} ${item.state === 'CLOSED' ? 'done' : ''}`} aria-current={current ? 'true' : undefined} onClick={() => props.onItem(item.key)}>
                <span className="slice-position">{String(item.position).padStart(2, '0')}</span>
                <span className="slice-main">
                  <b>{item.key} · {item.title}</b>
                  <small>{humanState(item.state)}</small>
                </span>
                <span className={`status-pill compact ${stateTone(item.state)}`}>{humanState(item.state)}</span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function StepRail({ state }: { state: string }) {
  const currentIndex = sliceSteps.findIndex((step) => (step.states as readonly string[]).includes(state));
  const blocked = state === 'BLOCKED';
  return (
    <ol className="step-rail" aria-label="Ciclo desta etapa">
      {sliceSteps.map((step, index) => {
        const status = blocked && index === 3 ? 'blocked' : currentIndex < 0 ? 'pending' : index < currentIndex || (index === currentIndex && state === 'CLOSED') ? 'complete' : index === currentIndex ? 'active' : 'pending';
        return (
          <li key={step.key} className={status}>
            <i />
            <span>{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function EvidenceCard({ validation, onOpenLog }: { validation: DashboardValidation; onOpenLog: (id: string) => void }) {
  const pass = validation.resultKind === 'PASS';
  const fail = validation.resultKind === 'TEST_FAILURE';
  return (
    <article className={`evidence ${pass ? 'pass' : fail ? 'fail' : 'warn'}`}>
      <div className="evidence-head">
        <span><StatusDot status={pass ? 'complete' : fail ? 'blocked' : 'pending'} /> <b>{humanPurpose(validation.purpose)} · {humanResult(validation.resultKind)}</b></span>
        <time>{formatTime(validation.createdAt)}</time>
      </div>
      <p>{validation.summary.testsTotal ? `${validation.summary.testsTotal} teste(s) analisado(s).` : `Perfil ${validation.profileKey} · ${formatDuration(validation.durationMs)}`}</p>
      {validation.logAvailable && <button className="text-button" onClick={() => onOpenLog(validation.id)}>Abrir log</button>}
    </article>
  );
}

function Intervene({ dashboard, primaryAction, inspection, onAction }: {
  dashboard: DashboardSnapshot;
  primaryAction?: DashboardAction;
  inspection: Record<string, unknown> | null;
  onAction: (action: DashboardAction) => void;
}) {
  const extras = dashboard.availableActions.filter((action) => action.id !== primaryAction?.id);
  return (
    <details className="intervene">
      <summary>Intervir no ledger</summary>
      <p>O agente já está autorizado a conduzir o ciclo. Use isto só se precisar pausar, revisar ou registrar algo manualmente.</p>
      <div className="button-group">
        {primaryAction && <ActionButton action={primaryAction} onClick={() => onAction(primaryAction)} />}
        {extras.map((action) => <ActionButton key={action.id} action={action} onClick={() => onAction(action)} />)}
      </div>
      {inspection && <pre className="inspection-result">{JSON.stringify(inspection, null, 2)}</pre>}
    </details>
  );
}

function ActionDialog({ modal, dashboard, logLoading, logText, planLoading, planReport, onClose, onSubmit }: {
  modal: NonNullable<ModalState>;
  dashboard: DashboardSnapshot | null;
  logLoading: boolean;
  logText: string | null;
  planLoading: boolean;
  planReport: PlanCheckResult | null;
  onClose: () => void;
  onSubmit: (fields: Record<string, unknown>) => void;
}) {
  const action = modal.action;
  const [fields, setFields] = useState<Record<string, unknown>>(() => defaultActionFields(action, dashboard));
  const [submitting, setSubmitting] = useState(false);
  const set = (key: string, value: unknown) => setFields((current) => ({ ...current, [key]: value }));
  const submit = async (event: FormEvent) => { event.preventDefault(); setSubmitting(true); try { await onSubmit(fields); } finally { setSubmitting(false); } };
  if (modal.logValidationId) {
    return (
      <div className="modal-backdrop" role="presentation">
        <section className="dialog log-dialog" role="dialog" aria-modal="true" aria-labelledby="log-title">
          <div className="dialog-head">
            <div><span className="eyebrow">LOG</span><h2 id="log-title">Saída da validação</h2></div>
            <button className="icon-button" onClick={onClose} aria-label="Fechar">×</button>
          </div>
          {logLoading ? <div className="dialog-loading">Carregando log…</div> : <pre className="raw-log">{logText}</pre>}
        </section>
      </div>
    );
  }
  if (modal.planCheck) {
    return (
      <div className="modal-backdrop" role="presentation">
        <section className="dialog log-dialog" role="dialog" aria-modal="true" aria-labelledby="plan-title">
          <div className="dialog-head">
            <div><span className="eyebrow">PLAN CHECK</span><h2 id="plan-title">Auditoria do planejamento</h2></div>
            <button className="icon-button" onClick={onClose} aria-label="Fechar">×</button>
          </div>
          {planLoading || !planReport
            ? <div className="dialog-loading">Avaliando as fatias da entrega…</div>
            : <PlanCheckReport report={planReport} currentItemKey={dashboard?.item.key ?? ''} />}
        </section>
      </div>
    );
  }
  return (
    <div className="modal-backdrop" role="presentation">
      <form className="dialog" role="dialog" aria-modal="true" onSubmit={submit}>
        <div className="dialog-head">
          <div><span className="eyebrow">AÇÃO DO LEDGER</span><h2>{action.label}</h2></div>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Fechar">×</button>
        </div>
        <p className="dialog-help">A operação será revalidada contra o estado atual antes de ser aplicada.</p>
        <ActionFields action={action} dashboard={dashboard} fields={fields} set={set} />
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="primary-button" disabled={submitting}>{submitting ? 'Registrando…' : 'Confirmar ação'}</button>
        </div>
      </form>
    </div>
  );
}

function ActionFields({ action, dashboard, fields, set }: {
  action: DashboardAction;
  dashboard: DashboardSnapshot | null;
  fields: Record<string, unknown>;
  set: (key: string, value: unknown) => void;
}) {
  const input = (key: string, label: string, placeholder: string, required = true) => (
    <label className="field">{label}<input required={required} value={String(fields[key] ?? '')} placeholder={placeholder} onChange={(event) => set(key, event.target.value)} /></label>
  );
  if (action.id === 'RUN_RED' || action.id === 'RUN_GREEN' || action.id === 'RUN_CHECK') {
    return <div className="field-grid">{input('repositoryKey', 'Repositório', action.options?.repositoryKeys?.[0] ?? 'repo')} {input('profileKey', 'Perfil de validação', action.options?.profileKeys?.[0] ?? 'unit')} {action.id === 'RUN_RED' && input('reason', 'Motivo (se RED estrutural)', 'Justificativa opcional', false)}</div>;
  }
  if (action.id === 'AUTHORIZE') {
    return (
      <div className="field-grid">
        {input('actor', 'Ator', 'dev-local')}
        {input('instruction', 'Instrução autorizada', 'Implementar somente o escopo da fatia')}
        {input('repositoryKeys', 'Repositórios (separados por vírgula)', dashboard?.repositories.map((repo) => repo.key).join(',') ?? '')}
        <label className="field field-wide">Efeitos permitidos<textarea value={String(fields.allowedEffects ?? '')} onChange={(event) => set('allowedEffects', event.target.value.split('\n').filter(Boolean))} placeholder="código local" /></label>
        <label className="field field-wide">Efeitos proibidos<textarea value={String(fields.forbiddenEffects ?? '')} onChange={(event) => set('forbiddenEffects', event.target.value.split('\n').filter(Boolean))} placeholder="provider real" /></label>
      </div>
    );
  }
  if (action.id === 'SUBMIT_REVIEW') {
    return (
      <div className="field-grid">
        {input('reviewer', 'Revisor', 'operator')}
        <label className="field">Veredito<select value={String(fields.verdict ?? 'APPROVED')} onChange={(event) => set('verdict', event.target.value)}><option>APPROVED</option><option>CHANGES_REQUIRED</option><option>BLOCKED</option></select></label>
        {input('summary', 'Resumo', 'Evidências verificadas e risco residual')}
        <label className="field">Modo<select value={String(fields.reviewMode ?? 'SELF')} onChange={(event) => set('reviewMode', event.target.value)}><option>SELF</option><option>INDEPENDENT</option></select></label>
      </div>
    );
  }
  if (action.id === 'CLOSE') return <div className="field-grid">{input('commitSha', 'SHA do commit', dashboard?.item.currentSha ?? 'sha-1')}</div>;
  if (action.id === 'REINSPECT') return <div className="field-grid">{input('repositoryKey', 'Repositório', action.options?.repositoryKeys?.[0] ?? 'repo')}</div>;
  if (action.id === 'COMPACT_HISTORY') return <div className="field-grid">{input('keepRecent', 'Fatias recentes preservadas', '2')}</div>;
  if (action.id === 'REOPEN') return <div className="field-grid">{input('actor', 'Ator', 'operator')}{input('reason', 'Motivo da reabertura', 'Retomar após correção do bloqueio')}</div>;
  if (action.id === 'REQUEST_SIZE_EXCEPTION') {
    return <div className="field-grid">{input('actor', 'Ator solicitante', 'agent:codex')}{input('reason', 'Diagnóstico / motivo da solicitação', 'Descreva por que a fatia não pode ser dividida')}</div>;
  }
  if (action.id === 'APPROVE_SIZE') {
    return <div className="field-grid">{input('actor', 'Ator humano (human:identidade)', 'human:operador')}{input('reason', 'Justificativa durável da aprovação', 'Por que esta fatia permanece única')}</div>;
  }
  if (action.id === 'REPLAN') {
    return <div className="field-grid">{input('actor', 'Ator', 'human:operador')}{input('reason', 'Motivo do replanejamento', 'Resultado primário que será separado')}</div>;
  }
  if (action.id === 'APPROVE_TDD_EXCEPTION' || action.id === 'BLOCK' || action.id === 'INVALIDATE_GREEN') {
    return (
      <div className="field-grid">
        {input('reason', action.id === 'BLOCK' ? 'Motivo do bloqueio' : action.id === 'INVALIDATE_GREEN' ? 'Motivo da invalidação' : 'Justificativa TDD', action.id === 'INVALIDATE_GREEN' ? 'A worktree mudou depois do GREEN' : 'Descreva a decisão e o risco')}
        {action.id === 'BLOCK' && input('actor', 'Ator', 'operator', false)}
      </div>
    );
  }
  return <p className="confirm-copy">Confirmar transição de <b>{humanState(dashboard?.item.state ?? '')}</b> para a próxima etapa?</p>;
}

function PlanCheckReport({ report, currentItemKey }: { report: PlanCheckResult; currentItemKey: string }) {
  return (
    <div className="plan-report">
      <p className="dialog-help">
        Política da entrega: até {report.policy.maxUseCases} {report.policy.maxUseCases === 1 ? 'caso de uso' : 'casos de uso'},
        {' '}{report.policy.maxRequiredCriteria} critérios e {report.policy.maxTests} testes por fatia ·{' '}
        {report.summary.ok}/{report.summary.total} dentro da política.
      </p>
      <div className="plan-items">
        {report.items.map((item) => {
          const tone = item.status === 'OK' ? 'ok' : item.status === 'EXCEPTION_REQUIRED' ? 'bad' : 'wait';
          const semanticBlocked = item.semanticStatus === 'BLOCKED';
          const semanticReview = item.semanticStatus === 'REVIEW_REQUIRED';
          return (
            <article key={item.key} className={`plan-item ${item.key === currentItemKey ? 'current' : ''}`}>
              <div className="plan-item-head">
                <b>{item.key} · {item.title}</b>
                <span className={`status-pill ${tone}`}>{humanPlanStatus(item.status)}</span>
              </div>
              <p className="plan-metrics">
                {item.metrics.useCases}/{report.policy.maxUseCases} casos de uso ·{' '}
                {item.metrics.requiredCriteria}/{report.policy.maxRequiredCriteria} critérios ·{' '}
                {item.metrics.tests}/{report.policy.maxTests} testes
              </p>
              <p className="plan-metrics">
                Escopo de repositórios: {humanRepositoryScope(item.repositoryScope)}
                {item.scopeIssues.length > 0 && ` · problemas: ${item.scopeIssues.join('; ')}`}
              </p>
              {(semanticBlocked || semanticReview) && (
                <p className={`plan-issue ${semanticBlocked ? 'error' : 'warning'}`}>
                  Auditoria semântica: {semanticBlocked ? 'bloqueada' : 'requer revisão'}
                </p>
              )}
              {item.semanticIssues.map((issue, index) => (
                <p key={`semantic-${index}`} className={`plan-issue ${issue.severity === 'ERROR' ? 'error' : 'warning'}`}>
                  {issue.message} Sugestão: {issue.suggestion}
                </p>
              ))}
              {item.violations.map((violation, index) => (
                <p key={`violation-${index}`} className={`plan-issue ${violation.severity === 'ERROR' ? 'error' : 'warning'}`}>
                  {violation.message}
                </p>
              ))}
              {item.suggestions.map((suggestion, index) => (
                <p key={`suggestion-${index}`} className="plan-suggestion">{suggestion}</p>
              ))}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function humanPlanStatus(status: string) {
  if (status === 'OK') return 'Dentro da política';
  if (status === 'EXCEPTION_REQUIRED') return 'Exceção necessária';
  return 'Divisão recomendada';
}
function humanRepositoryScope(scope: string) {
  if (scope === 'DECLARED') return 'declarado';
  if (scope === 'CAPTURED') return 'capturado';
  return 'indefinido';
}

function PanelHeader({ title, meta }: { title: string; meta?: ReactNode }) {
  return <div className="panel-header"><span>{title}</span>{meta && <small>{meta}</small>}</div>;
}
function StatusDot({ status }: { status: string }) {
  return <i className={`status-dot ${status}`} aria-label={status} />;
}
function ActionButton({ action, onClick }: { action: DashboardAction; onClick: () => void }) {
  return <button className={`${action.kind === 'primary' ? 'primary-button' : action.kind === 'danger' ? 'danger-button' : 'secondary-button'}`} onClick={onClick} disabled={!action.enabled} title={action.reason}>{action.label}</button>;
}
function InlineNotice({ tone, message, onClose }: { tone: 'error' | 'success'; message: string; onClose: () => void }) {
  return <div className={`inline-notice ${tone}`} role="status"><span>{message}</span><button onClick={onClose} aria-label="Fechar aviso">×</button></div>;
}
function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="empty-state"><strong>{title}</strong><span>{detail}</span></div>;
}
function LoadingShell() {
  return <div className="loading-shell"><div className="loading-bar" /><span>Carregando o andamento…</span></div>;
}

function describeNow(state: string, next?: string) {
  const copy = stateCopy[state] ?? { status: humanState(state), detail: next ? `Próximo estado esperado: ${humanState(next)}.` : 'Acompanhe o estado desta etapa.' };
  if (state === 'IMPLEMENTING' && next) {
    return { status: copy.status, detail: `O agente está implementando esta etapa. Próximo registro esperado: ${humanState(next)}.` };
  }
  return copy;
}
function humanState(state: string) {
  return stateCopy[state]?.status ?? state.replaceAll('_', ' ').toLowerCase();
}
function humanPurpose(purpose: string) {
  if (purpose === 'RED') return 'Evidência RED';
  if (purpose === 'GREEN') return 'Evidência verde';
  if (purpose === 'CHECK') return 'Checagem';
  return purpose;
}
function humanResult(result: string) {
  if (result === 'PASS') return 'passou';
  if (result === 'TEST_FAILURE') return 'falhou';
  if (result === 'TIMEOUT') return 'expirou';
  if (result === 'INFRASTRUCTURE_ERROR') return 'erro de infra';
  return result.replaceAll('_', ' ').toLowerCase();
}
function stateTone(state: string) {
  if (state === 'CLOSED' || state === 'APPROVED' || state === 'GREEN_CONFIRMED') return 'ok';
  if (state === 'BLOCKED' || state === 'CHANGES_REQUIRED') return 'bad';
  if (state === 'IMPLEMENTING' || state === 'READY_FOR_REVIEW' || state === 'AUTHORIZED') return 'live';
  return 'wait';
}
function currentFeatureItems(catalog: DashboardCatalogProject[], dashboard: DashboardSnapshot) {
  const project = catalog.find((candidate) => candidate.key === dashboard.selection.projectKey);
  return project?.features.find((feature) => feature.key === dashboard.selection.featureKey)?.items ?? [];
}
function pickActiveFeature(features: DashboardCatalogProject['features']) {
  return features.find((feature) => feature.items.some((item) => item.state !== 'CLOSED')) ?? features[0];
}
function pickActiveItem(items: DashboardCatalogItem[]) {
  return items.find((item) => item.state !== 'CLOSED') ?? items.at(-1);
}
function sortFeatures(features: DashboardCatalogProject['features']) {
  return [...features].sort((left, right) => {
    const leftOpen = left.items.some((item) => item.state !== 'CLOSED') ? 0 : 1;
    const rightOpen = right.items.some((item) => item.state !== 'CLOSED') ? 0 : 1;
    if (leftOpen !== rightOpen) return leftOpen - rightOpen;
    return left.key.localeCompare(right.key, undefined, { numeric: true });
  });
}
function resolvePendencies(dashboard: DashboardSnapshot, context: ContextShape): Pendency[] {
  const recorded = dashboard.pendingItems.filter((item) => !item.resolved);
  if (recorded.length) return recorded;
  return (context.unresolvedItems ?? []).map((item) => ({ ...item, resolved: false }));
}
function defaultActionFields(action: DashboardAction, dashboard: DashboardSnapshot | null): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  const repositoryKey = action.options?.repositoryKeys?.[0] ?? dashboard?.repositories[0]?.key;
  const profileKey = action.options?.profileKeys?.[0] ?? dashboard?.repositories[0]?.profiles[0]?.key;
  if (repositoryKey) defaults.repositoryKey = repositoryKey;
  if (profileKey) defaults.profileKey = profileKey;
  if (action.id === 'AUTHORIZE') defaults.repositoryKeys = dashboard?.repositories.map((repository) => repository.key).join(',') ?? '';
  if (action.id === 'COMPACT_HISTORY') defaults.keepRecent = '2';
  if (action.id === 'SUBMIT_REVIEW') { defaults.verdict = 'APPROVED'; defaults.reviewMode = 'SELF'; }
  if (action.id === 'REQUEST_SIZE_EXCEPTION') defaults.actor = 'agent:codex';
  if (action.id === 'APPROVE_SIZE') defaults.actor = 'human:operador';
  if (action.id === 'REPLAN') defaults.actor = 'human:operador';
  return defaults;
}
function formatTime(value: string) {
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
function formatDuration(ms: number) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}
function readSelection(): Selection {
  const params = new URLSearchParams(window.location.search);
  return { projectKey: params.get('projectKey') ?? undefined, featureKey: params.get('featureKey') ?? undefined, itemKey: params.get('itemKey') ?? undefined };
}
function readView(): View {
  const value = new URLSearchParams(window.location.search).get('view');
  if (value === 'project' || value === 'features') return 'project';
  return 'now';
}
function writeSelection(selection: { projectKey: string; featureKey: string; itemKey: string }) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(selection)) url.searchParams.set(key, value);
  window.history.replaceState({}, '', url);
}
function writeView(view: View) {
  const url = new URL(window.location.href);
  url.searchParams.set('view', view);
  window.history.replaceState({}, '', url);
}
