# Workflow ledger

Aplicação local e independente para registrar o fluxo de implementação de
features. O estado operacional fica no SQLite; os documentos históricos do
Carará continuam versionados, congelados e não são atualizados pelo runtime.

## Início rápido

```bash
rtk npm install
rtk npm run prisma:generate
rtk npm run prisma:migrate -- --name init
rtk npm run build
rtk node dist/interfaces/cli/main.js import-carara --root /caminho/para/7agentes
```

Por padrão, o banco é `/caminho/para/7agentes/.workflow/workflow.sqlite`.
Use `WORKFLOW_DATABASE_URL` ou `DATABASE_URL` para apontar para outro arquivo.
O diretório `.workflow/` não deve ser versionado.

## Uso diário

```bash
rtk node dist/interfaces/cli/main.js context --project carara --feature E6
rtk node dist/interfaces/cli/main.js item authorize --help
rtk node dist/interfaces/cli/main.js validate run --help
rtk node dist/interfaces/cli/main.js item transition --help
```

O comando `import` recebe um JSON com `schemaVersion: 1` e `importKey`. A
mesma chave é aplicada uma única vez, permitindo reexecução segura. O comando
`import-carara` fornece o snapshot inicial: E6/G3/fatias 01–04 em detalhe, a
fatia 05 como próxima fatia `READY`, fatias posteriores planejadas e E0–E5.1
como resumos.

## Regras de segurança

- Git é consultado somente por `rtk git`; autorização rejeita worktrees sujas.
- Validações usam apenas programas allowlistados (`npm`, `npx`, `node`, `pnpm`,
  `yarn`), sempre sem shell, dentro do repositório registrado.
- O executor limita tempo e saída. O resumo não contém log cru; o log, quando
  necessário, fica comprimido no banco por sete dias.
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
`workflow_transition`, `workflow_review` e `workflow_compact_history`.

## Desenvolvimento

```bash
rtk npm test
rtk npm run lint
rtk npm run build
```

Testes são executados em bancos SQLite temporários e removidos ao final de cada
suíte.
