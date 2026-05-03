# 2026-05-03 — PFFPrisema runtime doctor

## Goal

Adicionar validação dentro da própria extensão, parecida com checks de ambiente de outras extensões Prisema, para avisar quando `pi-fff-prisema` estiver com instalação duplicada, colisão com `@ff-labs/pi-fff`, flags inseguras ou scan incompleto.

## Context

O script externo `bun run doctor` já detecta problemas antes/depois de instalar, mas a sessão Pi também deve avisar quando a extensão carregar em estado suspeito. A extensão não deve auto-rodar `scripts/install-global.sh`, porque isso altera settings globais, remove/instala pacotes e pode exigir rede/credenciais. Startup deve ser diagnóstico, não mutação.

## Decisions

- Adicionar comando `/fff-prisema-doctor`.
- Rodar doctor leve em `session_start` após inicialização do FFF.
- Se houver warning, mostrar notificação pedindo `/fff-prisema-doctor`.
- Doctor interno lê `~/.pi/agent/settings.json` e `.pi/settings.json` do projeto atual.
- Detectar:
  - `npm:@ff-labs/pi-fff` instalado;
  - múltiplas fontes `pi-fff-prisema`;
  - fonte project-local sobrescrevendo global;
  - flags que religam watcher, mmap, content index ou AI/frecency;
  - scan inicial com timeout.
- Não auto-instalar nem auto-remover pacotes.

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
- `docs/agent/notes/2026-05-03-extension-doctor.md`

## Tests

Passou:

```bash
bun run typecheck
bun run smoke .
bun run smoke /Users/rizzao/Projetos/MeusProjetos/vindula
bun run doctor
```

Smoke agora também valida registro e execução do comando `/fff-prisema-doctor` em harness fake do Pi.

## Risks

- Doctor interno não consegue instalar dependências se a extensão nem carregar; por isso `bun run doctor` externo continua existindo.
- Leitura de settings é best-effort; JSON inválido vira ausência de pacote em vez de crashar startup.

## Next

- Após publicar/reinstalar global, reiniciar Pi e rodar `/fff-prisema-doctor`.
