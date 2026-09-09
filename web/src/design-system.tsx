import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';

const statusItems = [
  { tone: 'live', icon: '◉', label: 'Em execução' },
  { tone: 'wait', icon: '◷', label: 'Aguardando revisão' },
  { tone: 'ok', icon: '✓', label: 'Concluída' },
  { tone: 'bad', icon: '!', label: 'Pausada' },
] as const;

export function DesignSystem() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = window.localStorage.getItem('workflow-forma-theme');
    return saved === 'dark' ? 'dark' : 'light';
  });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'foundations' | 'components'>('foundations');

  useEffect(() => {
    document.documentElement.dataset.formaTheme = theme;
    window.localStorage.setItem('workflow-forma-theme', theme);
    document.title = 'Forma — Workflow design system';
  }, [theme]);

  return (
    <div className="forma-page">
      <header className="forma-topbar">
        <a className="forma-brand" href="/" aria-label="Voltar para o Workflow">
          <span className="forma-mark">W</span>
          <span>Workflow</span>
          <span className="forma-slash">/</span>
          <strong>Forma</strong>
        </a>
        <div className="forma-top-actions">
          <span className="forma-version">DESIGN SYSTEM · v0.1</span>
          <button
            className="theme-toggle"
            type="button"
            aria-label={`Mudar para tema ${theme === 'light' ? 'escuro' : 'claro'}`}
            onClick={() => setTheme((current) => current === 'light' ? 'dark' : 'light')}
          >
            <span aria-hidden="true">{theme === 'light' ? '☼' : '☾'}</span>
            {theme === 'light' ? 'Claro' : 'Escuro'}
          </button>
        </div>
      </header>

      <main className="forma-shell">
        <section className="forma-hero" aria-labelledby="forma-title">
          <div>
            <div className="forma-kicker"><span className="kicker-dot" /> SISTEMA DE INTERFACE <span className="kicker-line" /> FLUXO OPERACIONAL</div>
            <h1 id="forma-title">Uma linguagem clara para cada etapa do trabalho.</h1>
            <p className="forma-lead">Forma organiza estados, evidências e ações para que qualquer pessoa entenda o que está acontecendo no ledger sem perder a precisão técnica.</p>
          </div>
          <div className="forma-hero-note">
            <span className="micro-label">PRINCÍPIO 01</span>
            <strong>Estado antes da ação.</strong>
            <span>O próximo passo sempre aparece junto da situação atual.</span>
          </div>
        </section>

        <nav className="forma-tabs" aria-label="Seções do design system">
          <button className={activeTab === 'foundations' ? 'is-active' : ''} type="button" onClick={() => setActiveTab('foundations')}>Fundamentos</button>
          <button className={activeTab === 'components' ? 'is-active' : ''} type="button" onClick={() => setActiveTab('components')}>Componentes</button>
          <span className="forma-tabs-rule" />
          <span className="forma-tabs-caption">Amostras em contexto</span>
        </nav>

        {activeTab === 'foundations' ? (
          <Foundations />
        ) : (
          <Components onOpenDialog={() => setDialogOpen(true)} />
        )}

        <section className="forma-context" aria-labelledby="context-title">
          <div className="section-intro">
            <span className="micro-label">COMPOSIÇÃO</span>
            <h2 id="context-title">Agora, em uma tela.</h2>
            <p>Os componentes se unem para dar contexto à execução de uma fatia, com uma ação clara e evidências visíveis.</p>
          </div>
          <NowComposition onOpenDialog={() => setDialogOpen(true)} />
        </section>
      </main>

      <footer className="forma-footer">
        <span><span className="forma-mark forma-mark-small">W</span> Forma para Workflow</span>
        <span>Tokens preparados para implementação incremental</span>
      </footer>

      {dialogOpen && <AuthorizationDialog onClose={() => setDialogOpen(false)} />}
    </div>
  );
}

function Foundations() {
  return (
    <div className="foundation-grid">
      <section className="showcase-panel color-panel" aria-labelledby="color-title">
        <PanelHeader eyebrow="01 · CORES" title="Paleta de estados" />
        <div className="swatch-grid">
          <Swatch name="Canvas" value="#F4F5F7" className="canvas-swatch" />
          <Swatch name="Graphite" value="#1E232B" className="ink-swatch" />
          <Swatch name="Action violet" value="#7C3AED" className="forest-swatch" />
          <Swatch name="Blue soft" value="#DCE7FF" className="lime-swatch" />
          <Swatch name="Success" value="#236044" className="success-swatch" />
          <Swatch name="Warning" value="#805400" className="warning-swatch" />
          <Swatch name="Danger" value="#A33241" className="danger-swatch" />
          <Swatch name="Info" value="#3B82F6" className="info-swatch" />
        </div>
        <p className="panel-note">A cor sinaliza o tipo de estado; o texto mantém o significado legível em qualquer tema.</p>
      </section>

      <section className="showcase-panel type-panel" aria-labelledby="type-title">
        <PanelHeader eyebrow="02 · TIPO" title="Hierarquia tipográfica" />
        <div className="type-samples">
          <div><span className="sample-meta">DISPLAY / 30 · 38</span><p className="sample-display">Acompanhe o fluxo.</p></div>
          <div><span className="sample-meta">BODY / 14 · 22</span><p className="sample-body">Cada etapa tem um estado, uma evidência e um próximo passo.</p></div>
          <div><span className="sample-meta">MONO / 12 · 18</span><p className="sample-mono">P3:03 · GREEN_CONFIRMED · 3729ms</p></div>
        </div>
      </section>

      <section className="showcase-panel rhythm-panel" aria-labelledby="rhythm-title">
        <PanelHeader eyebrow="03 · RITMO" title="Escala de espaço" />
        <div className="rhythm-list">
          {[4, 8, 12, 16, 24, 32, 48].map((space) => <div className="rhythm-row" key={space}><span className="space-bar" style={{ width: `${space * 2}px` }} /><code>{space}px</code><span>{space === 4 ? 'micro' : space === 16 ? 'padrão' : space === 32 ? 'seção' : ''}</span></div>)}
        </div>
      </section>

      <section className="showcase-panel states-panel" aria-labelledby="states-title">
        <PanelHeader eyebrow="04 · ESTADOS" title="Estados em uma linha" />
        <div className="status-showcase">
          {statusItems.map((status) => <StatusBadge key={status.label} tone={status.tone} icon={status.icon}>{status.label}</StatusBadge>)}
        </div>
        <div className="state-rule" />
        <p className="panel-note">Cada status tem ícone, texto e contraste próprio. Nunca depende só da cor.</p>
      </section>
    </div>
  );
}

function Components({ onOpenDialog }: { onOpenDialog: () => void }) {
  return (
    <div className="components-grid">
      <section className="showcase-panel controls-panel" aria-labelledby="controls-title">
        <PanelHeader eyebrow="05 · CONTROLES" title="Ações e campos" />
        <div className="control-demo">
          <div className="button-row"><button className="forma-button primary" type="button" onClick={onOpenDialog}>Autorizar fatia <span aria-hidden="true">→</span></button><button className="forma-button secondary" type="button">Reinspecionar</button><button className="forma-button danger" type="button">Bloquear</button><button className="forma-button secondary" type="button" disabled>Indisponível</button></div>
          <div className="field-demo"><label htmlFor="slice-name">Nome da fatia <span className="required">*</span></label><input id="slice-name" value="Reserva exclusiva de fatia" readOnly /><span className="field-help">Use um nome que descreva o resultado primário.</span></div>
          <div className="field-demo has-error"><label htmlFor="reviewer">Revisor</label><input id="reviewer" placeholder="human:operador" /><span className="field-error">Informe um ator para registrar a revisão.</span></div>
        </div>
      </section>

      <section className="showcase-panel feedback-panel" aria-labelledby="feedback-title">
        <PanelHeader eyebrow="06 · FEEDBACK" title="Avisos e resultados" />
        <div className="notice-stack">
          <div className="forma-notice success"><span className="notice-icon">✓</span><span><strong>GREEN confirmado.</strong> A evidência está pronta para revisão.</span><button type="button" aria-label="Fechar aviso">×</button></div>
          <div className="forma-notice warning"><span className="notice-icon">!</span><span><strong>Uma pendência bloqueia o avanço.</strong> Replaneje ou obtenha aprovação.</span><button type="button" aria-label="Fechar aviso">×</button></div>
          <div className="empty-demo"><span className="empty-icon">—</span><strong>Nenhuma evidência ainda</strong><span>Quando o agente registrar uma validação, ela aparece aqui.</span></div>
        </div>
      </section>

      <section className="showcase-panel status-panel" aria-labelledby="status-title">
        <PanelHeader eyebrow="07 · BADGES" title="Estados do ciclo" />
        <div className="badge-grid">{statusItems.map((status) => <div className="badge-example" key={status.label}><span className={`status-dot-large ${status.tone}`}><span>{status.icon}</span></span><span><strong>{status.label}</strong><small>{status.tone === 'live' ? 'A ação está em curso' : status.tone === 'wait' ? 'Próximo registro esperado' : status.tone === 'ok' ? 'Critérios atendidos' : 'Ação necessária'}</small></span></div>)}</div>
      </section>

      <section className="showcase-panel evidence-panel" aria-labelledby="evidence-title">
        <PanelHeader eyebrow="08 · EVIDÊNCIA" title="Registro de validação" meta="3 eventos" />
        <div className="evidence-rows">
          <EvidenceRow tone="ok" purpose="GREEN" title="Testes da reserva expirada" detail="workflow-slice-lease-test · 3.72s" />
          <EvidenceRow tone="ok" purpose="CHECK" title="Recuperação duplicada é rejeitada" detail="reutilizada · 0ms" />
          <EvidenceRow tone="bad" purpose="RED" title="Recuperação antes do prazo" detail="falha esperada · 3.51s" />
        </div>
      </section>
    </div>
  );
}

function NowComposition({ onOpenDialog }: { onOpenDialog: () => void }) {
  return (
    <div className="now-card">
      <div className="now-card-top"><div><span className="micro-label">P3 · PLANEJAMENTO E COORDENAÇÃO</span><h3>Reserva exclusiva de fatia</h3><p className="now-description">O agente está aguardando a liberação para continuar o fluxo com segurança.</p></div><StatusBadge tone="wait" icon="◷">Aguardando autorização</StatusBadge></div>
      <div className="cycle-rail"><CycleStep label="Autorização" state="active" /><CycleStep label="Testes" /><CycleStep label="Execução" /><CycleStep label="Revisão" /><CycleStep label="Conclusão" /></div>
      <div className="now-card-grid">
        <div className="criteria-block"><div className="block-heading"><span>O que precisa ficar pronto</span><code>2 critérios</code></div><div className="criteria-item"><code>AC-01</code><span>Uma reserva dentro do prazo não pode ser recuperada.</span></div><div className="criteria-item"><code>AC-02</code><span>Uma reserva expirada pode ser recuperada uma vez.</span></div></div>
        <div className="next-action"><span className="micro-label">PRÓXIMO PASSO</span><strong>Autorize o agente</strong><p>O escopo fica registrado antes da execução.</p><button className="forma-button primary" type="button" onClick={onOpenDialog}>Autorizar fatia <span aria-hidden="true">→</span></button></div>
      </div>
    </div>
  );
}

function AuthorizationDialog({ onClose }: { onClose: () => void }) {
  return <div className="forma-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="forma-dialog" role="dialog" aria-modal="true" aria-labelledby="authorization-title"><div className="dialog-top"><div><span className="micro-label">AÇÃO DO LEDGER</span><h2 id="authorization-title">Autorizar fatia</h2></div><button className="dialog-close" type="button" aria-label="Fechar diálogo" onClick={onClose}>×</button></div><p className="dialog-copy">A operação será revalidada contra o estado atual antes de ser aplicada.</p><div className="dialog-form"><label htmlFor="dialog-actor">Ator responsável</label><input id="dialog-actor" defaultValue="human:operador" /><label htmlFor="dialog-instruction">Instrução autorizada</label><textarea id="dialog-instruction" defaultValue="Implementar somente o escopo da fatia" rows={3} /><div className="dialog-summary"><span className="summary-icon">✓</span><span><strong>Escopo declarado</strong><small>workflow · 3 caminhos registrados</small></span></div></div><div className="dialog-actions"><button className="forma-button secondary" type="button" onClick={onClose}>Cancelar</button><button className="forma-button primary" type="button" onClick={onClose}>Confirmar autorização</button></div></div></div>;
}

function PanelHeader({ eyebrow, title, meta }: { eyebrow: string; title: string; meta?: string }) {
  return <div className="showcase-heading"><div><span className="micro-label">{eyebrow}</span><h2>{title}</h2></div>{meta && <code>{meta}</code>}</div>;
}

function Swatch({ name, value, className }: { name: string; value: string; className: string }) {
  return <div className="swatch"><span className={`swatch-color ${className}`} /><span><strong>{name}</strong><code>{value}</code></span></div>;
}

function StatusBadge({ tone, icon, children }: { tone: string; icon: string; children: string }) {
  return <span className={`status-badge ${tone}`}><span aria-hidden="true">{icon}</span>{children}</span>;
}

function CycleStep({ label, state = 'pending' }: { label: string; state?: 'active' | 'pending' | 'done' }) {
  return <div className={`cycle-step ${state}`}><span className="cycle-dot" /><span>{label}</span></div>;
}

function EvidenceRow({ tone, purpose, title, detail }: { tone: 'ok' | 'bad'; purpose: string; title: string; detail: string }) {
  return <div className="evidence-row"><span className={`evidence-mark ${tone}`}>{tone === 'ok' ? '✓' : '×'}</span><span className="evidence-main"><code>{purpose}</code><strong>{title}</strong><small>{detail}</small></span><button className="text-action" type="button">Abrir log</button></div>;
}
