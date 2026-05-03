# 2026-05-03 — Remove project-specific install smoke

## Goal

Remover qualquer vínculo do pacote público `pi-fff-prisema` com projetos locais específicos.

## Context

`scripts/install-global.sh` e `scripts/install-local.sh` rodavam smoke usando um caminho absoluto de outro projeto local. Isso era inadequado para uma extensão pública: o pacote deve validar usando o próprio repositório ou parâmetros genéricos, nunca depender de um projeto privado/local.

## Decisions

- Trocar o smoke dos installers para `bun run smoke .`.
- Remover referências ao caminho local antigo das notas versionadas.
- Manter `scripts/smoke.mjs` aceitando argumento opcional para testes manuais em qualquer repo, sem hardcode.

## Commands run

```bash
pattern='private/local path fragments'; /usr/bin/grep -RInE "$pattern" scripts docs/agent/notes --exclude-dir=node_modules --exclude-dir=.pi --exclude-dir=.git
bash -n scripts/install-global.sh scripts/install-local.sh
bun run typecheck
bun run smoke .
bun run doctor
```

## Files changed

- `scripts/install-global.sh`
- `scripts/install-local.sh`
- `docs/agent/notes/*.md`
- `docs/agent/notes/2026-05-03-remove-project-coupling.md`

## Tests

Passou: typecheck, smoke local e doctor.

## Risks

- Smoke de install cobre repo pequeno por padrão. Testes em repositórios grandes continuam possíveis manualmente: `bun run smoke /path/to/repo`, mas não ficam hardcoded no pacote público.

## Next

- Reinstalar global após push se quiser validar o installer sem acoplamento.
