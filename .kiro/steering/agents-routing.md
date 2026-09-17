---
inclusion: auto
---

# AGENTS.md — Roteamento obrigatório

Você está no subprojeto `workflow/` (ledger local de execução). Antes de qualquer alteração:

1. Leia [`workflow/AGENTS.md`](../../AGENTS.md) — padrões técnicos e protocolo operacional.
2. Leia [`7agentes/AGENTS.md`](../../../AGENTS.md) — regras globais do workspace.

O `AGENTS.md` mais próximo do arquivo alterado **prevalece** sobre os de nível superior.

## Fonte de verdade

O estado operacional fica em `.workflow/workflow.sqlite`. Não derive estado,
próxima fatia, autorização ou progresso de documentos. Toda leitura e escrita
passa pelo CLI ou MCP — nunca acesse o SQLite diretamente.

## Escopo deste repositório

Trabalhe somente em `workflow/`. Não edite `front/`, `api/` ou
`carara-atendimento/`.

## Descoberta compacta (sequência recomendada)

```bash
rtk node dist/interfaces/cli/main.js project list
rtk node dist/interfaces/cli/main.js frontier --project <project-key>
rtk node dist/interfaces/cli/main.js feature list --project <project-key>
rtk node dist/interfaces/cli/main.js context \
  --project <project-key> --feature <feature-key> --item <item-key>
```

Informe `--feature` e `--item` explicitamente em todas as operações específicas
de fatia.

## Verificação proporcional

Execute sempre a partir de `workflow/`:

```bash
rtk npm run lint
rtk npm run build
rtk npm test
```

Comandos adicionais disponíveis:

```bash
rtk npm install
rtk npm run prisma:generate
rtk npm run prisma:migrate
rtk npm run start:mcp
rtk npm run start:web
```
