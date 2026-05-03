# 2026-05-03 — PFFPrisema auto reindex

## Goal

Automatizar reindex seguro porque o watcher nativo fica desligado por padrão para evitar FD leak em sessões Pi longas.

## Context

`disableWatch=true` evita o principal risco observado: muitos watchers/FDs abertos e `spawn EBADF`. Sem watcher, arquivos novos ou removidos depois do scan inicial podem ficar invisíveis até `/fff-prisema-reindex`. Rodar reindex antes de toda busca seria caro em repos grandes.

## Decisions

- Manter `disableWatch=true` como default.
- Adicionar `PI_FFF_PRISEMA_AUTO_REINDEX=true` como default.
- Reindex automático roda só quando:
  - watcher está desligado;
  - auto-reindex está ligado;
  - ocorreu `edit`/`write` ou shell mutante detectado antes da próxima busca; ou
  - uma busca retorna zero resultados e já passou `PI_FFF_PRISEMA_AUTO_REINDEX_MIN_INTERVAL_MS`.
- Não rodar reindex antes de toda busca.
- Manter `/fff-prisema-reindex` para rescan manual.
- Não mudar default de `disableContentIndexing`; habilitar content index deve ser experimento separado com `PI_FFF_PRISEMA_DISABLE_CONTENT_INDEXING=0`.

## Commands run

```bash
bun run typecheck
bun run smoke .
bun run smoke /Users/rizzao/Projetos/MeusProjetos/vindula
bun run doctor
```

## Files changed

- `src/index.ts`
- `scripts/smoke.mjs`
- `README.md`
- `docs/agent/notes/2026-05-03-auto-reindex.md`

## Tests

Passou:

```bash
bun run typecheck
bun run smoke .
bun run smoke /Users/rizzao/Projetos/MeusProjetos/vindula
bun run doctor
```

Smoke agora cria `src/generated.ts` depois do scan inicial, simula resultado de `write`, e valida que `fffind` encontra o arquivo por auto-reindex.

## Risks

- Shell mutante é heurístico; comandos customizados podem criar arquivos sem marcar dirty. Busca sem resultado ainda tenta reindex com intervalo mínimo.
- Reindex após `edit`/`write` pode custar tempo em repo grande, mas só roda antes de uma busca FFF, não no momento da escrita.
- Habilitar content indexing pode melhorar grep, mas aumenta trabalho inicial/memória; precisa benchmark separado.

## Next

- Reinstalar global e reiniciar Pi.
- Monitorar FD count com `scripts/check-pi-fds.sh`.
- Se estável, testar `PI_FFF_PRISEMA_DISABLE_CONTENT_INDEXING=0` como experimento separado.
