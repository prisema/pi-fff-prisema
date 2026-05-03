# 2026-05-03 — FFF grep constraint regression

## Goal

Verificar se `fffind`, `ffgrep` e `fff-multi-grep` do `pi-fff-prisema` continuam funcionando como o `pi-fff` esperado, especialmente após saídas suspeitas `No matches found`.

## Context

Teste direto das tools ativas mostrou comportamento misto:

- `fffind` funciona para busca de arquivos.
- `fff-multi-grep` funciona com `constraints: "src/"`.
- `ffgrep` funciona sem `path` ou com glob (`*.ts`).
- `ffgrep` falha com `path: "src/"` e regex + diretório, retornando `No matches found`.

Causa raiz confirmada: `buildGrepQuery()` normalizava `src/` para `src`, mas o FFF exige barra final para constraint de diretório: `src/ pattern`.

## Decisions

- Manter normalização de `fffind` sem mexer no comportamento de busca de arquivo.
- Criar normalização específica para `ffgrep`, preservando constraints de diretório e glob.
- Se `path` existe e é diretório, aceitar também `src` e converter para `src/`.
- Melhorar suporte a `path` de arquivo exato com constraint ampla + pós-filtro por caminho.
- Fortalecer `scripts/smoke.mjs` com harness fake do Pi para testar as três tools registradas sem depender de sessão Pi real.

## Commands run

```bash
bun install
bun run typecheck
bun run smoke .
bun run smoke .
```

Testes diretos via tools Pi ativas também foram executados:

```text
fffind(pattern="index", path="src/") -> src/index.ts
ffgrep(pattern="FileFinder.create", path="src/") -> No matches found  # sessão atual ainda com código antigo
ffgrep(pattern="FileFinder.create", path="*.ts") -> src/index.ts
fff-multi-grep(patterns=["FileFinder.create", "registerTool"], constraints="src/") -> src/index.ts
```

## Files changed

- `src/index.ts`
- `scripts/smoke.mjs`
- `package.json`
- `bun.lock`
- `docs/agent/notes/2026-05-03-fff-grep-regression.md`

## Tests

Passou:

```bash
bun run typecheck
bun run smoke .
bun run smoke .
```

Smoke cobre:

- raw `@ff-labs/fff-node` com opções seguras;
- `fffind` com `path: "src/"`;
- `ffgrep` com diretório `src/`;
- `ffgrep` com diretório `src` sem barra;
- `ffgrep` com arquivo exato `src/index.ts`;
- `ffgrep` com arquivo raiz `README.md`;
- `ffgrep` com glob `*.ts`;
- `ffgrep` regex com diretório;
- `fff-multi-grep` com `constraints: "src/"`.

## Risks

- Sessão Pi atual não recarrega extensão automaticamente; tools ao vivo ainda podem mostrar bug até reinstalar/reiniciar Pi.
- Pós-filtro para arquivo exato depende de FFF encontrar candidatos dentro do budget; para padrões muito comuns em repositórios enormes pode exigir query/path mais específico.

## Next

- Reinstalar/recarregar extensão local no Pi.
- Abrir nova sessão Pi e repetir `ffgrep` com `path: "src/"` usando a tool real carregada.
