# Workflow ledger

Aplicação local e independente para registrar o fluxo de implementação de
features e fatias. O SQLite do ledger é a única fonte de verdade para estado,
sequência, autorização, critérios, evidências, revisões, pendências e
fechamento. O CLI e o MCP consultam e atualizam esse estado; nenhuma fonte
documental externa participa do fluxo operacional.

## Vocabulário do ledger

Uma `feature` é uma capacidade ou frente de produto que pode exigir várias
entregas. Ela tem uma chave própria (`featureKey`), como `E6`, `E7`, `E8` ou
`E9`, nome, resumo, plano e uma coleção de fatias. O catálogo não é fixo e
uma feature não é sinônimo de todo o projeto: o mesmo projeto pode ter várias
features ativas ao mesmo tempo.

Uma `fatia` é um `WorkItem`: a menor unidade autorizável e verificável do
trabalho. Ela é endereçada pela combinação `featureKey + itemKey`, por exemplo
`E9 + 06`. A fatia contém título, fase, posição, casos de uso, critérios de
aceite, testes, autorização, baselines, validações, revisão e commit. O
`itemKey` só é único dentro da feature; portanto, `01` de `E6` e `01` de `E9`
são fatias diferentes.

Fases ou gates (`G0` a `G7`, por exemplo) são marcos do ciclo de uma fatia,
não features nem fatias. A posição ordena as fatias dentro da feature e não
deve ser inferida a partir do texto da chave: existem chaves numéricas (`01`)
e chaves de gate (`G4`, `G7`). O estado da fatia (`DRAFT`, `IMPLEMENTING`,
`CLOSED` etc.) é a referência para saber se há trabalho aberto; o status
`ACTIVE` da feature, sozinho, não substitui a inspeção de suas fatias.

## Início rápido

```bash
rtk npm install
rtk npm run prisma:generate
rtk npm run prisma:migrate -- --name init
rtk npm run build
rtk node dist/interfaces/cli/main.js import --file /caminho/para/snapshot.json
```

Por padrão, o banco é `/caminho/para/7agentes/.workflow/workflow.sqlite`.
Use `WORKFLOW_DATABASE_URL` ou `DATABASE_URL` para apontar para outro arquivo.
O diretório `.workflow/` não deve ser versionado.

## Uso diário

```bash
rtk node dist/interfaces/cli/main.js project list
rtk node dist/interfaces/cli/main.js feature list --project carara
rtk node dist/interfaces/cli/main.js context --project carara --feature <feature-key> --item <item-key>
rtk node dist/interfaces/cli/main.js item authorize --help
rtk node dist/interfaces/cli/main.js validate run --help
rtk node dist/interfaces/cli/main.js validate log --help
rtk node dist/interfaces/cli/main.js validate confirm-red --help
rtk node dist/interfaces/cli/main.js item transition --help
rtk node dist/interfaces/cli/main.js item invalidate-green --help
```

O fluxo de descoberta é `project list` → `feature list` → escolha explícita de
`featureKey` e `itemKey` → `context`/`item record`. No estado atual consultado
do projeto `carara`, o catálogo inclui `E6`, `E7`, `E8` e `E9`; essa lista é
apenas o estado do banco naquele momento, não uma enumeração fixa. Sempre leia
`feature list` antes de assumir que existe uma chave ou que uma feature é a
única em andamento.

`context` é a consulta canônica para descobrir o estado, próximo estado,
autorização, pendências, evidências, revisão e commit da fatia selecionada.
Com `--feature` e sem `--item`, ele escolhe a primeira fatia não `CLOSED` por
posição; se todas estiverem fechadas, escolhe a última por posição. Sem
`--feature`, ele escolhe a feature `ACTIVE` atualizada mais recentemente —
com várias features ativas isso é uma conveniência não determinística para a
intenção do agente, portanto prefira informar ambas as chaves.

Substitua os placeholders antes de executar os comandos abaixo:

```bash
rtk node dist/interfaces/cli/main.js context \
  --project carara --feature <feature-key> --item <item-key>
rtk node dist/interfaces/cli/main.js item record \
  --project carara --feature <feature-key> --item <item-key>
```

### Inspeção do ledger

Para descobrir chaves, ids e histórico sem recorrer ao banco direto:

```bash
rtk node dist/interfaces/cli/main.js project list
rtk node dist/interfaces/cli/main.js feature list --project carara
rtk node dist/interfaces/cli/main.js repository list --project carara
rtk node dist/interfaces/cli/main.js item record \
  --project carara --feature <feature-key> --item <item-key>
rtk node dist/interfaces/cli/main.js validate list \
  --project carara --feature <feature-key> --item <item-key>
rtk node dist/interfaces/cli/main.js validate list \
  --project carara --feature <feature-key> --item <item-key> --purpose GREEN
```

`feature list` mostra features com suas fatias e estados; `repository list`
mostra repositórios e os perfis de validação ativos (chave, programa, args) —
é a referência para escolher `--repository` e `--profile` no `validate run`.
`item record` expõe o registro detalhado da fatia (critérios, testes,
autorização, baselines, revisões, decisões e pendências) e `validate list`
retorna as validações registradas com os ids aceitos por `validate log`.
No MCP, use primeiro `workflow_list_projects` e
`workflow_list_features`; o segundo já retorna as fatias de cada feature.
Depois, `workflow_context` e `workflow_record` recebem as chaves escolhidas.
`workflow_list_repositories` informa os perfis de validação. As consultas
`workflow_list_decisions` e `workflow_list_pending` completam a inspeção
project-wide antes de registrar uma nova decisão ou pendência.

### Decisões e pendências

Divergências, decisões de produto e requisitos ausentes devem permanecer
explícitos no ledger. Use:

```bash
rtk node dist/interfaces/cli/main.js decision add \
  --project carara --feature <feature-key> --item <item-key> \
  --key DEC-EXECUCAO-OFFLINE --title "Execução sem provider" \
  --content "O fluxo sintético roda sem provider externo" --pin
rtk node dist/interfaces/cli/main.js decision list --project carara
rtk node dist/interfaces/cli/main.js pending add \
  --project carara --feature <feature-key> --key PEND-PERFIL-BUILD \
  --description "Definir perfil de build" --blocking
rtk node dist/interfaces/cli/main.js pending list --project carara
rtk node dist/interfaces/cli/main.js pending resolve \
  --project carara --key PEND-PERFIL-BUILD --reason "perfil registrado"
```

Decisões duráveis (`--not-durable` desativa) e pendências não resolvidas
aparecem no `context`; `--pin` protege o registro da retenção de histórico.
No MCP, os equivalentes são `workflow_decision_record`,
`workflow_pending_record` e `workflow_pending_resolve`.

O CLI e o MCP são infraestrutura do agente. O usuário autoriza a fatia e o
agente conduz o ciclo até o fechamento; não se deve pedir ao usuário que rode
transições ou validações intermediárias.

### Granularidade, exceções e replanejamento

Toda fatia deve passar pela auditoria antes de avançar de `DRAFT` para
`READY`:

```bash
rtk node dist/interfaces/cli/main.js plan check \
  --project <project-key> --feature <feature-key>
```

O resultado `OK` permite a transição normal. Os resultados
`SPLIT_RECOMMENDED` e `EXCEPTION_REQUIRED` são bloqueantes: o agente não deve
implementar, autorizar, registrar RED ou tentar avançar a fatia por outro
caminho. No MCP, a mesma auditoria é chamada por `workflow_plan_check`.

Quando a fatia estiver grande, o agente deve solicitar a decisão e parar:

```bash
rtk node dist/interfaces/cli/main.js item request-size-exception \
  --project <project-key> --feature <feature-key> --item <item-key> \
  --actor agent:<agent-id> --reason "<diagnóstico>"
```

No MCP, use `workflow_request_slice_size_exception`. Essa ferramenta registra
uma pendência bloqueante; ela não cria aprovação e não libera `READY`. O
agente não aprova a própria exceção e não usa `decision add` para simular uma
aprovação.

O caminho preferencial é replanejar. Primeiro bloqueie a fatia original:

```bash
rtk node dist/interfaces/cli/main.js item replan \
  --project <project-key> --feature <feature-key> --item <item-key> \
  --actor agent:<agent-id> --reason "<resultado primário que será separado>"
```

Depois crie cada nova fatia com `--parent <item-key>`. No MCP, informe
`parentItemKey` em `workflow_define_item`; o bloqueio é registrado por
`workflow_replan_item`. A fatia original permanece
`BLOCKED`; cada descendente precisa ser pequeno, independente e passar por
`plan check` novamente. A linhagem aparece em `feature list`, `context`,
`item record` e `plan check`.

Se a divisão não for possível, somente o operador humano pode aprovar a
exceção pela CLI, depois que houver uma solicitação registrada:

```bash
rtk node dist/interfaces/cli/main.js item approve-size \
  --project <project-key> --feature <feature-key> --item <item-key> \
  --actor human:<identidade> --reason "<justificativa durável>"
```

`approve-size` é uma operação `OPERATOR-ONLY` e não é exposta como ferramenta
MCP para agentes. A transição só reconhece uma aprovação acompanhada do evento
específico de aprovação humana; uma decisão genérica com a mesma chave não
libera a fatia.

### Ciclo de uma fatia de código

1. consultar o contexto e confirmar a autorização;
2. escrever os testes e avançar para `TESTS_DEFINED`;
3. executar `validate run --purpose RED`; um RED comportamental avança para
   `RED_CONFIRMED` automaticamente, enquanto um RED estrutural exige uma
   justificativa; se ela não foi informada, use `validate confirm-red` com o id
   retornado, sem repetir a execução;
4. avançar para `IMPLEMENTING`, implementar e executar `--purpose GREEN` em
   cada repositório autorizado; o primeiro resultado parcial permanece em
   `IMPLEMENTING` e informa os repositórios pendentes, enquanto o conjunto
   completo avança automaticamente para `GREEN_CONFIRMED`;
5. manter a worktree congelada depois do GREEN; se ela mudar, use
   `item invalidate-green` e execute um novo GREEN;
6. avançar para `READY_FOR_REVIEW` e registrar a revisão como `SELF` ou
   `INDEPENDENT`; o veredito já move o item para `APPROVED`,
   `CHANGES_REQUIRED` ou `BLOCKED`;
7. se o veredito exigir mudanças, retorne para `TESTS_DEFINED` antes de
   executar o RED novamente; após a aprovação, faça o commit e feche o item
   com o SHA.

`RED` prova que os testes detectam a ausência do comportamento. `GREEN` prova
que o mesmo delta passou após a implementação. `CHECK` representa uma
verificação adicional: quando usa o mesmo perfil e a mesma worktree do GREEN,
o ledger reaproveita a evidência sem executar a suíte novamente. Uma mudança
na worktree invalida o reaproveitamento.

`validate run` inclui um trecho limitado do log para falhas. O log completo
pode ser lido sem nova execução com:

```bash
rtk node dist/interfaces/cli/main.js validate log \
  --project carara --feature <feature-key> --item <item-key> \
  --validation <id> --raw
```

O mesmo recurso está disponível no MCP como `workflow_validation_log`.
`workflow_confirm_structural_red` confirma um RED estrutural já registrado e
`workflow_invalidate_green` retorna uma evidência GREEN obsoleta para
`IMPLEMENTING`.

As evidências usam um fingerprint de execução (HEAD, diff e arquivos novos) e
um fingerprint do conteúdo efetivo da worktree, que permanece estável quando o
mesmo conteúdo é commitado. O contexto curto mostra o resultado corrente,
validações, modo de revisão e commit, além das duas fatias anteriores.

O comando `import` recebe somente um JSON com `schemaVersion: 1` e `importKey`.
A mesma chave é aplicada uma única vez, permitindo reexecução segura. Essa
operação serve apenas para bootstrap ou migração explícita de um snapshot
estruturado; não é usada para consultar o estado corrente nem para substituir
as transições normais do ledger.

## Regras de segurança

- Git é consultado somente por `rtk git`; autorização rejeita worktrees sujas.
- Validações usam apenas programas allowlistados (`npm`, `npx`, `node`, `pnpm`,
  `yarn`), sempre sem shell, dentro do repositório registrado.
- O executor limita tempo e saída. O resumo não contém log cru; o log, quando
  necessário, fica comprimido no banco por sete dias.
- O estado corrente deve ser lido com `context`; autorização, validação,
  revisão e fechamento devem ser registrados pelas operações do ledger.
- O MCP não aceita shell arbitrário, não altera arquivos, não faz stage/commit
  e não chama providers ou serviços externos.
- Contexto curto preserva a fatia ativa, decisões duráveis, pendências,
  critérios e apenas as duas fatias fechadas anteriores; histórico antigo vira
  resumo.

## MCP local

O servidor STDIO é iniciado por `rtk npm run start:mcp` a partir deste
diretório. A configuração de projeto em `../.codex/config.toml` registra o
servidor `workflow` com aprovação para operações de escrita.

As ferramentas principais são `workflow_list_projects`,
`workflow_list_features`, `workflow_list_repositories`,
`workflow_list_decisions`, `workflow_list_pending`, `workflow_context`,
`workflow_record`, `workflow_list_validations`, `workflow_define_item`,
`workflow_authorize`, `workflow_validate`, `workflow_validation_log`,
`workflow_confirm_structural_red`, `workflow_transition`,
`workflow_reopen`, `workflow_invalidate_green`, `workflow_review`,
`workflow_decision_record`, `workflow_pending_record`,
`workflow_pending_resolve` e `workflow_compact_history`.

As cinco ferramentas `workflow_list_*` iniciais são somente leitura e existem
para que o agente descubra as chaves válidas e o estado global sem acessar o
SQLite diretamente. O agente deve preferir essa sequência de catálogo antes
de chamar uma ferramenta que exige `featureKey` ou `itemKey`.

## Dashboard web local

O dashboard operacional usa o mesmo SQLite do CLI/MCP e fica disponível apenas
no loopback:

```bash
rtk npm run build
rtk npm run start:web
```

Abra `http://127.0.0.1:4117`. Durante o desenvolvimento, use
`rtk npm run dev:web`; a página é atualizada a cada cinco segundos para refletir
ações feitas por agentes. A interface calcula as ações elegíveis no servidor,
revalida o estado antes de cada mutação e permite abrir logs de validação apenas
enquanto ainda estiverem dentro da retenção de sete dias.

Itens criados pelo CLI/MCP continuam sendo a fonte para definição de projetos,
features, testes e perfis. O dashboard conduz autorização, transições,
validações, reviews, bloqueios, reaberturas e compactação quando os pré-
requisitos do ledger estiverem satisfeitos.

## Desenvolvimento

```bash
rtk npm test
rtk npm run lint
rtk npm run build
```

Testes são executados em bancos SQLite temporários e removidos ao final de cada
suíte.
