# 2026-05-03 — PFFPrisema install doctor

## Goal

Clarificar instalação do `pi-fff-prisema` e avisar quando o ambiente Pi tiver fonte duplicada, dependência local faltando ou `@ff-labs/pi-fff` ainda instalado.

## Context

Após rodar `bash scripts/install-local.sh`, o Pi mostrou instalação por path local. Isso não escreve no `.pi/settings.json` do projeto; `pi install` sem `-l` escreve no settings global `~/.pi/agent/settings.json`. Porém a fonte instalada era o checkout local, o que é correto para desenvolvimento mas confuso para uso normal/global.

Também foi detectado que havia duas fontes instaladas no settings global:

- `git:github.com/prisema/pi-fff-prisema`
- um checkout local do mesmo pacote

## Decisions

- Manter `scripts/install-local.sh` como fluxo de desenvolvimento local, mas deixar claro que ele instala uma fonte local no settings global do Pi.
- Criar `scripts/install-global.sh` para uso normal via `git:github.com/prisema/pi-fff-prisema`.
- Criar `scripts/doctor.mjs` e script `bun run doctor` para avisos de ambiente.
- Fazer os install scripts removerem fontes conflitantes antes de instalar a fonte desejada.
- Documentar diferença entre fonte global GitHub e fonte local-dev no README.

## Commands run

```bash
bun run doctor
bun run typecheck
bun run smoke .
bun run smoke .
```

## Files changed

- `scripts/doctor.mjs`
- `scripts/install-global.sh`
- `scripts/install-local.sh`
- `package.json`
- `README.md`
- `docs/agent/notes/2026-05-03-install-doctor.md`

## Tests

Passou:

```bash
bun run typecheck
bun run smoke .
bun run smoke .
```

`bun run doctor` detectou corretamente a duplicidade atual e sugeriu os install scripts.

## Risks

- `scripts/install-global.sh` depende do commit estar disponível no GitHub; mudanças locais não publicadas não entram no clone global.
- `scripts/install-local.sh` continua útil para dev, mas deixa o Pi apontando para checkout local.

## Next

- Rodar `bash scripts/install-global.sh` quando quiser ficar só com fonte GitHub/global.
- Reiniciar Pi e validar `/fff-prisema-status`.
