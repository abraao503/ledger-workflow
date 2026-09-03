# Workflow ledger

Aplicação local e independente para registrar o fluxo de implementação de
features. O SQLite do ledger é a única fonte de verdade para estado, sequência,
autorização, critérios, evidências, revisões, pendências e fechamento. O CLI e
o MCP consultam e atualizam esse estado; nenhuma fonte documental externa
participa do fluxo operacional.

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
rtk node dist/interfaces/cli/main.js context --project carara --feature E6 --item 06
rtk node dist/interfaces/cli/main.js item authorize --help
rtk node dist/interfaces/cli/main.js validate run --help
rtk node dist/interfaces/cli/main.js validate log --help
rtk node dist/interfaces/cli/main.js validate confirm-red --help
rtk node dist/interfaces/cli/main.js item transition --help
rtk node dist/interfaces/cli/main.js item invalidate-green --help
```

O primeiro comando é a consulta canônica para descobrir a fatia ativa, seu
próximo estado, autorização, pendências, evidências, revisão e commit. Se a
fatia não estiver informada, o contexto mostra o resumo da feature e suas
fatias recentes. Para qualquer decisão de execução, use esse contexto antes
de consultar os repositórios de código.

O CLI e o MCP são infraestrutura do agente. O usuário autoriza a fatia e o
agente conduz o ciclo até o fechamento; não se deve pedir ao usuário que rode
transições ou validações intermediárias.

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
  --project carara --feature E6 --item 06 --validation <id> --raw
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

As ferramentas principais são `workflow_context`, `workflow_record`,
`workflow_define_item`, `workflow_authorize`, `workflow_validate`,
`workflow_validation_log`, `workflow_confirm_structural_red`,
`workflow_transition`, `workflow_reopen`, `workflow_invalidate_green`,
`workflow_review` e `workflow_compact_history`.

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
