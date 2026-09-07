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
   rtk node dist/interfaces/cli/main.js feature list --project <project-key>
   ```

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

## Vocabulário

- **Feature**: capacidade ou frente de produto que agrupa fatias. A chave é
  `featureKey`.
- **Fatia** (`WorkItem`): menor unidade autorizável e verificável. A chave é a
  combinação `featureKey + itemKey`; `itemKey` não é global.
- **Fase/gate**: marco como `G3` ou `G6`. Não é feature, fatia nem estado.
- **Estado**: situação corrente da fatia. A lista atual inclui
  `DRAFT`, `READY`, `AUTHORIZED`, `TESTS_DEFINED`, `RED_CONFIRMED`,
  `TDD_EXCEPTION_APPROVED`, `IMPLEMENTING`, `GREEN_CONFIRMED`,
  `READY_FOR_REVIEW`, `APPROVED`, `CHANGES_REQUIRED`, `BLOCKED` e `CLOSED`.

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

Quando houver concorrência, reserve a fatia autorizada com `item claim`. Uma
reserva expirada pode ser recuperada com `item recover`. Não trabalhe em uma
fatia reservada por outro agente.

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

- Git é consultado por `rtk git`; stage e commit só ocorrem após aprovação e
  GREEN válido.
- Validações executam apenas programas allowlistados, sem shell, dentro do
  repositório registrado, com limite de tempo e saída.
- O MCP não edita arquivos, não faz stage/commit, não executa shell arbitrário
  e não chama providers externos.
- Não exponha segredos, logs sensíveis ou dados de outro projeto no ledger.
- Não use o README ou o AGENTS como substituto do `context`.

Ao finalizar, confira separadamente o status do repositório e registre no
handoff: arquivos alterados, validações executadas, resultado GREEN, revisão e
SHA do commit, quando houver.
