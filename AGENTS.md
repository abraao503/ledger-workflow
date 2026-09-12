# AGENTS.md — workflow/

Instruções para agentes que trabalham neste repositório. O
[README.md](README.md) é público e explica o produto. Este arquivo é
operacional: define a ordem das consultas, as transições permitidas e os
limites de ação.

As instruções de um `AGENTS.md` mais externo continuam valendo. Em caso de
conflito, o arquivo mais externo prevalece quando tratar de segurança ou do
workspace.

## Escopo

- Trabalhe somente em `workflow/`, salvo autorização explícita em sentido
  contrário.
- Não edite `front/`, `api/` ou `carara-atendimento/` nesta tarefa.
- Preserve mudanças existentes. Antes de editar, consulte o estado do Git.
- O SQLite do ledger não é editado diretamente.

## Shell

Toda chamada de shell deve começar com `rtk`. Não execute `git`, `npm`, `node`,
`rg`, `find` ou outro comando diretamente.

Se o prefixo necessário não estiver liberado, registre o comando exato e peça
a liberação desse prefixo. Não contorne a allowlist com `sh -c`, redireções ou
outro invólucro.

Comandos usuais, sempre a partir desta pasta:

```bash
rtk npm install
rtk npm run prisma:generate
rtk npm run prisma:migrate
rtk npm test
rtk npm run test:web
rtk npm run lint
rtk npm run build
rtk npm run start:mcp
rtk npm run start:web
```

## Fonte de verdade

O banco SQLite local, normalmente `.workflow/workflow.sqlite`, é a fonte de
verdade para:

- estado e sequência das fatias;
- autorização, escopo e baselines;
- critérios, testes e validações;
- revisões, decisões, pendências e commits.

Não deduza estado, próxima fatia ou autorização a partir do README, de
documentos legados ou de snapshots. O comando `import` só serve para
bootstrap/migração explícitos e aceita snapshots estruturados.

Toda leitura e escrita do ledger passa pelo CLI ou pelo MCP. Não consulte nem
altere o SQLite com outro programa.

## Antes de começar

1. Consulte o Git:

   ```bash
   rtk git status --short
   ```

2. Descubra o catálogo real. Não hardcode features como `E6`, `E7`, `E8` ou
   `E9`:

   ```bash
   rtk node dist/interfaces/cli/main.js project list
   rtk node dist/interfaces/cli/main.js frontier --project <project-key>
   rtk node dist/interfaces/cli/main.js feature list --project <project-key>
   ```

   `feature list --project <project-key>` é compacto por padrão: use-o para
   descobrir chaves, estados e contagens, não para carregar todos os critérios
   e testes. A fronteira mostra somente folhas efetivas e ações pendentes.

3. Escolha explicitamente uma feature e uma fatia e leia o contexto:

   ```bash
   rtk node dist/interfaces/cli/main.js context \
     --project <project-key> --feature <feature-key> --item <item-key>
   rtk node dist/interfaces/cli/main.js item record \
     --project <project-key> --feature <feature-key> --item <item-key>
   rtk node dist/interfaces/cli/main.js validate list \
     --project <project-key> --feature <feature-key> --item <item-key>
   ```

   Informe `--feature` e `--item` em todas as operações específicas da fatia.
   As regras de seleção implícita do `context` são apenas uma conveniência e
   não substituem a escolha explícita.

4. Confirme no contexto a autorização, os efeitos permitidos e proibidos, o
   escopo de repositórios, os critérios, as pendências e as validações exigidas.

No MCP, consulte primeiro `workflow_list_projects`, `workflow_list_features`,
`workflow_list_repositories`, `workflow_list_decisions` e
`workflow_list_pending`. Depois use `workflow_context` e `workflow_record`.

## Descoberta compacta e contexto mínimo

Comece sempre pela menor projeção que responde à pergunta. A sequência
recomendada é `project list`, `frontier --project` e
`feature list --project <project-key>`. Só depois de escolher a feature e a
fatia amplie a consulta:

```bash
rtk node dist/interfaces/cli/main.js feature show --project <project-key> --feature <feature-key>
rtk node dist/interfaces/cli/main.js repository list --project <project-key> --repository <repository-key>
rtk node dist/interfaces/cli/main.js decision list --project <project-key> --feature <feature-key> --item <item-key>
rtk node dist/interfaces/cli/main.js pending list --project <project-key> --feature <feature-key> --item <item-key>
rtk node dist/interfaces/cli/main.js context \
  --project <project-key> --feature <feature-key> --item <item-key>
```

`feature show` e `repository list --include-profiles` são as consultas
detalhadas sob demanda. Para decisões e pendências, mantenha `--feature` e
`--item` quando o escopo já for conhecido; use `--key`, `--status` ou
`--include-content` somente quando a pergunta exigir. Não faça listagens
globais de decisões, pendências, perfis ou fatias para descobrir um único
registro. O MCP deve passar os mesmos filtros aos tools equivalentes.

## Vocabulário

- **Feature**: capacidade ou frente de produto que agrupa fatias. A chave é
  `featureKey`.
- **Fatia** (`WorkItem`): menor unidade autorizável e verificável. A chave é a
  combinação `featureKey + itemKey`; `itemKey` não é global.
- **Fase/gate**: marco como `G3` ou `G6`. Não é feature, fatia nem estado.
- **Estado**: situação corrente da fatia. A lista atual inclui
  `DRAFT`, `READY`, `AUTHORIZED`, `TESTS_DEFINED`, `RED_CONFIRMED`,
  `TDD_EXCEPTION_APPROVED`, `IMPLEMENTING`, `GREEN_CONFIRMED`,
  `READY_FOR_REVIEW`, `APPROVED`, `CHANGES_REQUIRED`, `BLOCKED`,
  `SUPERSEDED` e `CLOSED`. `SUPERSEDED` é terminal e imutável para pais
  substituídos; a fronteira e o dashboard contam apenas folhas efetivas.

Não derive posição ou estado do texto da chave. Uma feature pode permanecer
`ACTIVE` depois que todas as suas fatias estiverem `CLOSED`.

## Protocolo obrigatório de granularidade

Antes de mover uma fatia de `DRAFT` para `READY`, execute:

```bash
rtk node dist/interfaces/cli/main.js plan check \
  --project <project-key> --feature <feature-key>
```

O resultado precisa ser avaliado em três dimensões:

- **Tamanho**: `OK` libera. `SPLIT_RECOMMENDED` e `EXCEPTION_REQUIRED`
  interrompem o fluxo.
- **Escopo**: uma fatia de código deve ter `repositoryScope: DECLARED`, com
  repositórios e padrões de caminho relativos declarados no item.
- **Semântica**: `semanticStatus: OK` libera; `BLOCKED` exige correção ou
  replanejamento; `REVIEW_REQUIRED` exige leitura do diagnóstico.

Diante de `SPLIT_RECOMMENDED` ou `EXCEPTION_REQUIRED`, pare. Não autorize,
implemente, registre RED nem tente outra transição para contornar a auditoria.

O caminho padrão é replanejar:

```bash
rtk node dist/interfaces/cli/main.js item replan \
  --project <project-key> --feature <feature-key> --item <item-key> \
  --actor <actor> --reason "<motivo>"
```

Isso bloqueia a fatia original. Crie descendentes com `--parent <item-key>` e
execute `plan check` novamente. No MCP, use `workflow_replan_item`.

Se dividir não for viável, registre uma solicitação sem liberar a fatia:

```bash
rtk node dist/interfaces/cli/main.js item request-size-exception \
  --project <project-key> --feature <feature-key> --item <item-key> \
  --actor <actor> --reason "<motivo>"
```

No MCP, use `workflow_request_slice_size_exception`. Somente um operador
humano pode aprovar a solicitação, com `item approve-size` e ator
`human:<identidade>`. O agente não aprova a própria exceção e não usa
`decision add` para forjar aprovação.

Problemas semânticos não podem ser convertidos em exceção de tamanho.

## Autorização e reserva

Uma nova execução exige autorização explícita do usuário registrada no ledger.
A autorização deve informar instrução, ator, efeitos permitidos e proibidos e
os repositórios autorizados.

O conjunto autorizado deve ser igual ao conjunto declarado no escopo. A
autorização captura baselines de Git e rejeita worktrees sujas ou na branch
inesperada.
No modo `MANAGED_WORKTREE`, cada repositório precisa declarar uma branch de
destino explícita. Antes da aprovação e da integração, os arquivos do diff
`target...candidate` são comparados com os padrões do escopo; declaração de
escopo não é apenas uma trava entre claims.

Quando houver concorrência, reserve a fatia autorizada com `item claim`. Uma
reserva expirada pode ser recuperada com `item recover`. Não trabalhe em uma
fatia reservada por outro agente. O claim devolve uma geração; transições depois
de `AUTHORIZED`, validações, revisão e integração precisam enviar
`executionFence`/`--fence` dessa geração. O ledger rejeita fences ausentes,
obsoletos ou expirados antes de qualquer mutação protegida.

Renove uma lease ativa com `item renew --holder <holder> --fence <generation>`
antes do prazo, libere-a com `item release` quando o agente terminar ou parar,
e use `item reconcile` para encerrar leases expiradas e workspaces órfãs de
forma idempotente. `item recover` substitui uma lease expirada por uma nova
geração; nunca reutilize a geração anterior.

Para escolher a próxima fatia, consulte `workflow frontier --project <key>`.
Ele mostra a fronteira das folhas, dependências e a ação humana ou automática
esperada, sem contar pais `SUPERSEDED` como trabalho aberto.

### Coordenação paralela e presença de agentes

Planeje em ondas: fatias sem dependências entre si e com caminhos de escopo
disjuntos podem avançar em paralelo; uma cadeia explícita de dependências deve
continuar linear. O `frontier` e o mapa de execução da interface web mostram
as ondas, holders ativos e quais dependentes cada agente pode desbloquear.
`UNCLASSIFIED` significa que o ledger não encontrou evidência suficiente para
afirmar paralelismo — não transforme ausência de dependência registrada em
autorização implícita.

Use `MANAGED_WORKTREE` quando agentes paralelos precisarem editar o mesmo
projeto com isolamento; o ledger bloqueia claims com paths sobrepostos. O modo
`SHARED` continua apropriado para tarefas que precisam compartilhar a mesma
worktree e, nesse caso, a execução deve ser coordenada como uma linha única.
Cada agente deve usar um holder identificável (`agent:<runtime>:<run-id>`) e
consultar o mapa antes de escolher a próxima fatia, para saber quem já está
trabalhando e qual trabalho é desbloqueado depois.

Dependências são explícitas e acíclicas. Declare-as em `item define --depends-on
<feature>:<item>` ou use `item dependency add/remove/list` enquanto a fatia
estiver em `DRAFT` ou `READY`. O `claim` só libera uma fatia quando todas as
dependências estão `CLOSED`; não use a posição da fatia como substituto do
grafo.

Para paralelizar com isolamento, autorize `--execution-mode MANAGED_WORKTREE`
em uma fatia que tenha escopo técnico declarado. O `claim` cria uma worktree e
uma branch por repositório do escopo, e as validações passam a usar esses
caminhos. O ledger bloqueia claims com paths sobrepostos. Uma recuperação
expirada abandona as worktrees antigas e cria novas; não reutilize nem remova
forçadamente a worktree de outro agente.

O fluxo de integração gerenciado é deliberadamente controlado:

1. Depois de GREEN e da revisão, execute `item prepare-integration` com o
   `--fence <generation>` devolvido pelo `item claim` (ou `item recover`).
2. Um operador humano autoriza os mapas exatos de candidatos e bases com
   `item authorize-integration` (`human:<identidade>`), também informando o
   mesmo fence vigente.
3. Execute `item integrate` com o fence vigente; o ledger revalida checkout
   limpo, branch e SHA, faz somente `git merge --ff-only`, fecha a fatia e
   tenta limpar as worktrees. Se a lease for recuperada, todos os três
   comandos precisam usar a nova geração.

Se a limpeza não for possível, o estado `CLEANUP_FAILED` fica registrado e
`item cleanup-worktrees` pode ser tentado novamente. Não feche uma fatia
`MANAGED_WORKTREE` diretamente com `item transition --to CLOSED`: ela exige a
aprovação de integração correspondente. Se a fatia for bloqueada durante a
execução, a reserva é liberada e as worktrees ficam `ABANDONED` para limpeza;
não as reutilize em uma nova execução.
Uma integração em andamento fica marcada como `IN_PROGRESS` antes do primeiro
fast-forward. Em uma retomada, o ledger reconcilia candidatos já integrados;
uma tentativa concorrente não assume a operação em andamento. Rebase que
altere o conteúdo validado invalida o GREEN e exige um novo ciclo de validação.

## Ciclo de execução

Depois da autorização, conduza o ciclo sem pedir que o usuário execute
comandos do ledger:

1. Defina os testes aplicáveis e avance para `TESTS_DEFINED`.
2. Execute `validate run --purpose RED` antes da implementação. RED
   comportamental confirma `RED_CONFIRMED` automaticamente.
3. RED estrutural exige `validate confirm-red --validation <id> --reason
   <motivo>`. Reutilize a execução registrada; não repita o perfil só para
   obter o diagnóstico.
4. Se a política TDD da fatia for `OPTIONAL` ou `EXEMPT`, registre
   `TDD_EXCEPTION_APPROVED` com uma justificativa. Depois avance para
   `IMPLEMENTING` sem executar RED.
5. Avance para `IMPLEMENTING`, implemente dentro do escopo autorizado e
   execute `validate run --purpose GREEN` em cada repositório autorizado.
6. Só considere `GREEN_CONFIRMED` quando todos os repositórios tiverem passado.
7. Avance para `READY_FOR_REVIEW` e registre a revisão com `SELF` ou
   `INDEPENDENT`. `SELF` não é revisão independente.
8. Após `APPROVED`, faça o commit e feche a fatia com o SHA.

`CHECK` é uma verificação adicional. Com o mesmo perfil e a mesma worktree do
GREEN, a evidência pode ser reaproveitada sem executar a suíte novamente.

Depois do GREEN, trate a worktree como congelada. Qualquer edição ou mudança
detectada pelo fingerprint exige:

```bash
rtk node dist/interfaces/cli/main.js item invalidate-green \
  --project <project-key> --feature <feature-key> --item <item-key> \
  --reason "<motivo>"
```

Depois, execute GREEN novamente antes de enviar para revisão. A transição para
`READY_FOR_REVIEW`, `APPROVED` ou `CLOSED` rejeita evidência obsoleta.

Se a revisão retornar `CHANGES_REQUIRED`, faça as mudanças, volte para
`TESTS_DEFINED` e repita RED. Se retornar `BLOCKED`, resolva o motivo e use
`item reopen`; uma fatia bloqueada não avança com `item transition`.

## Falhas e logs

`validate run` retorna um trecho do log quando uma validação falha. Para o log
completo, use `validate log --validation <id>`. Não execute o perfil novamente
apenas para descobrir a mensagem.

`No tests found`, falhas conhecidas de descoberta do Jest e outras falhas de
estrutura podem produzir RED estrutural. Leia o log, registre o motivo e use
`validate confirm-red` sem repetir a suíte.

Falhas de inicialização de processo são falhas de infraestrutura. Não as
classifique como falha comportamental do código.

## Regras de segurança e fechamento

- Git é consultado por `rtk git`; no modo gerenciado, o ledger também usa
  somente as operações allowlistadas de worktree, rebase, fast-forward e
  limpeza descritas acima. Ele nunca faz stage nem cria o commit da entrega.
- Validações executam apenas programas allowlistados, sem shell, dentro do
  repositório registrado, com limite de tempo e saída.
- O MCP não edita arquivos-fonte, não faz stage/commit, não executa shell
  arbitrário e não chama providers externos; as ações gerenciadas limitam-se
  às operações Git registradas do ciclo de worktree.
- Não exponha segredos, logs sensíveis ou dados de outro projeto no ledger.
- Não use o README ou o AGENTS como substituto do `context`.

Ao finalizar, confira separadamente o status do repositório e registre no
handoff: arquivos alterados, validações executadas, resultado GREEN, revisão e
SHA do commit, quando houver.
