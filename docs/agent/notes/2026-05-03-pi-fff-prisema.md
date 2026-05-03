# 2026-05-03 — PFFPrisema

## Goal

Criar uma extensão Pi própria (`PFFPrisema`, package `pi-pff-prisema`) para usar FFF com configuração segura em sessões longas.

## Context

A sessão Pi começou a apresentar `spawn EBADF` ao rodar comandos shell. Inspeção do processo Pi mostrou ~12k FDs abertos e muitos `DIR` apontando para a árvore do repo. Pesquisa externa encontrou:

- `badlogic/pi-mono#3706` e `#3786`: `spawn EBADF` por FD leak na camada Pi/bash executor.
- `dmtrKovalenko/fff#357`: PR merged sobre uso excessivo de watchers.
- `dmtrKovalenko/fff#422`: issue aberta sobre `fff-node v0.6.4` com crash/recursão em watcher thread; mitigação `disableWatch: true`.
- `opencode-fff-search`: referência usando `aiMode:false`, `disableMmapCache:true`, `disableContentIndexing:true`, `disableWatch:true`.

## Decisions

- Criar pacote próprio em vez de fork do `@ff-labs/pi-fff`.
- Usar repositório público `prisema/pi-fff-prisema` e package interno `pi-pff-prisema`.
- Usar `@ff-labs/fff-node@0.6.4` diretamente.
- Registrar tools drop-in: `fffind`, `ffgrep`, `fff-multi-grep`.
- Não implementar autocomplete `@` inicialmente para reduzir superfície de risco.
- Defaults seguros:
  - `aiMode:false`
  - `disableMmapCache:true`
  - `disableContentIndexing:true`
  - `disableWatch:true`
- Expor env toggles para religar recursos se necessário.

## Commands run

- Leitura de docs Pi: `docs/extensions.md`, `docs/packages.md`.
- Pesquisa web sobre `spawn EBADF`, `fff-node`, watchers e outras extensões FFF.
- Tentativa de `bun install` via Pi falhou com `spawn EBADF` porque a sessão atual já está afetada pelo leak.
- Tentativa de SubAgent `Remove Slop` falhou com `spawnSync npm EBADF`; cleanup manual aplicado.

## Files changed

- `package.json`
- `tsconfig.json`
- `.gitignore`
- `src/index.ts`
- `scripts/smoke.mjs`
- `scripts/check-pi-fds.sh`
- `scripts/install-local.sh`
- `README.md`
- `docs/agent/notes/2026-05-03-pi-fff-prisema.md`

## Tests

Pendente neste ponto:

```bash
bun install
bun run typecheck
bun run smoke .
```

## Risks

- Tool names colidem com `npm:@ff-labs/pi-fff`; remover a extensão antiga antes de instalar esta em modo drop-in.
- Sem watcher, resultados podem ficar stale até `/fff-prisema-reindex`.
- `fff-node v0.6.4` ainda tem issue upstream aberta; configuração segura reduz risco, mas não muda binário nativo.

## Next

- Rodar install/typecheck/smoke.
- Instalar localmente com `pi install /path/to/checkout` após remover `npm:@ff-labs/pi-fff`.
- Abrir nova sessão Pi e monitorar FD count.
