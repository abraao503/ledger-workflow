# Estudo futuro: projetos similares ao workflow ledger

**Status:** referência para pesquisa futura; não altera o protocolo operacional atual.

**Data da pesquisa:** 2026-09-07

## Objetivo

Registrar projetos open source que tratam de planejamento, execução durável e
coordenação de agentes. A finalidade é estudar ideias específicas sem substituir
o ledger antes de validar compatibilidade com o nosso modelo de fatias,
autorizações, evidências e revisões.

## Ponto de partida do ledger

O `workflow` já possui:

- SQLite como fonte de verdade operacional;
- `WorkItem` com estados, linhagem pai/filho e critérios/testes;
- auditoria de tamanho e auditoria semântica do plano;
- escopo declarado de repositórios e caminhos;
- autorização humana registrada;
- ciclo RED, GREEN, CHECK, revisão e commit;
- leases de fatia com reivindicação exclusiva e recuperação após expiração.

## Projetos para estudar

### Beads

[Repositório Beads](https://github.com/steveyegge/beads)

Rastreador de tarefas em grafo para agentes de código. Tem dependências,
hierarquia, detecção de trabalho pronto, claim atômico, saída orientada a
agentes e compactação semântica de tarefas antigas.

**Ideias relevantes:**

- uma visão `ready` que mostre somente trabalho realmente desbloqueado;
- tipos explícitos de dependência: bloqueia, pai/filho, relacionado e descoberto;
- compactação de histórico sem perder decisões importantes;
- integração mais direta com `AGENTS.md` e onboarding do agente.

**Limite:** o foco é memória e tarefas; não substitui nossa auditoria de
resultado primário, critérios, testes e gates de implementação.

### coord

[Repositório coord](https://github.com/DmarshalTU/coord)

Coordenador local para agentes com claims atômicos, leases temporárias,
recuperação automática após expiração, proteção contra conclusão obsoleta e
suporte a MCP.

**Ideias relevantes:**

- heartbeat e renovação explícita da lease;
- token ou versão de lease para impedir que um agente antigo conclua trabalho
  depois de perder a reserva;
- sweep automático de leases expiradas;
- testes de concorrência com vários processos, não apenas chamadas sequenciais.

### LLM Bus

[Repositório LLM Bus](https://github.com/danieldoderlein/llm-bus)

Backplane de coordenação via MCP com ledger de eventos, tarefas, handoffs,
claims, leases, presença e identidades com escopo de projeto.

**Ideias relevantes:**

- handoff explícito e confirmável entre agentes;
- presença e atividade como parte do estado operacional;
- identidade derivada de credencial, em vez de aceitar somente um texto livre
  como ator;
- consultas pequenas e estáveis para reduzir custo de contexto;
- canal de espera/notificação para evitar polling contínuo.

**Atenção:** o projeto usa licença AGPL-3.0; qualquer reutilização de código
exige avaliação jurídica separada.

### MCP Agent Mail

[Repositório MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail)

Camada de coordenação com identidades, mensagens encadeadas, acknowledgments,
leases de arquivos com TTL, SQLite, artefatos auditáveis em Git e guard de
pre-commit.

**Ideias relevantes:**

- leases por caminho ou glob, além da lease lógica da fatia;
- bloqueio preventivo de commit que conflite com outra reserva;
- inbox, threads e handoffs persistentes;
- liberação automática baseada em inatividade observável.

### Optio

[Repositório Optio](https://github.com/jonwiggins/optio)

Plataforma de execução de tarefas de agentes: intake, ambiente isolado,
worktree, execução, PR, CI, revisão, correção automática e merge. Também separa
tasks, jobs e agentes persistentes.

**Ideias relevantes:**

- reconciler que reobserve o estado e corrija execuções paradas;
- retomada automática após falha de CI ou comentário de revisão;
- separação entre tarefa de código, job sem repositório e agente persistente;
- worktree isolada como parte da execução, não apenas como convenção textual.

### Temporal

[Documentação Temporal](https://docs.temporal.io/)

Engine open source de execução durável, com workflows persistentes, retries,
timers, filas e sinais. É uma referência de infraestrutura, não uma solução
específica para planejamento de código.

**Ideias relevantes:**

- retomada determinística após falhas;
- distinção entre workflow e atividade com efeitos externos;
- sinais de aprovação e intervenção humana;
- timers e retries registrados como parte do histórico.

### LangGraph e CrewAI

[Persistência do LangGraph](https://langchain-ai.github.io/langgraph/concepts/time-travel/)
e [documentação do CrewAI](https://docs.crewai.com/)

São referências de runtime para workflows de agentes. LangGraph enfatiza
checkpoints, retomada e human-in-the-loop; CrewAI oferece flows, processos,
estado persistido e composição de crews.

**Ideias relevantes:**

- separar estado durável do contexto transitório do modelo;
- checkpoint explícito antes de efeitos colaterais;
- interrupções retomáveis para aprovação e revisão;
- composição de etapas sem transformar cada decisão em texto livre.

## Comparação resumida

| Capacidade | Ledger atual | Melhor referência | Possível evolução |
| --- | --- | --- | --- |
| Granularidade semântica | Forte | Específico do ledger | Preservar como diferencial |
| Dependências e trabalho pronto | Parcial | Beads | Criar uma visão `ready` |
| Claim exclusivo | Implementado | coord / LLM Bus | Adicionar fencing e heartbeat |
| Recuperação de lease | Manual | coord / Agent Mail | Sweep automático com segurança |
| Leases por arquivo | Não | Agent Mail | Adicionar reserva de paths |
| Handoff e presença | Não | LLM Bus / Agent Mail | Registrar presença e ack |
| RED/GREEN/revisão | Forte | Específico do ledger | Preservar como diferencial |
| Retomada durável | Parcial | Temporal / LangGraph | Avaliar somente ao escalar |
| Execução até PR/merge | Não | Optio / OpenHands | Integrar depois dos gates |

## Roteiro sugerido de estudo

1. **Leases robustas:** heartbeat, expiração automática, fencing token e
   conclusão obsoleta.
2. **Ready frontier:** dependências explícitas e consulta que mostre apenas
   fatias realmente executáveis.
3. **Coordenação:** handoff, presença, acknowledgments e espera por eventos.
4. **Proteção de arquivos:** leases por caminho e guard de pre-commit.
5. **Reconciliação:** processo que detecte execuções paradas e retome ou bloqueie
   com evidência.
6. **Execução durável:** avaliar Temporal/LangGraph somente se o ciclo deixar de
   caber com segurança no ledger local e nos perfis atuais.

## Princípio de adoção

Não importar um framework inteiro por semelhança superficial. Para cada ideia,
criar primeiro uma fatia pequena no ledger, com hipótese, teste de concorrência
ou recuperação, impacto no contexto do agente e critério claro de adoção ou
rejeição.
