# PFFPrisema

Extensão Pi da Prisema para busca FFF em modo seguro para sessões longas de agentes.

Repositório público: `prisema/pi-fff-prisema`.
Nome npm/package interno: `pi-pff-prisema`.

## Por que existe

Queremos a velocidade do `@ff-labs/fff-node`, mas sem depender do comportamento da extensão `@ff-labs/pi-fff` e sem carregar watcher/mmap/frecency agressivos em processos Pi long-lived.

Contexto observado:

- `spawn EBADF` em shell/subagents quando o processo Pi acumulou muitos file descriptors.
- Muitos FDs `DIR` abertos para a árvore do repo.
- Issues upstream/referências:
  - `badlogic/pi-mono#3706` e `#3786`: `spawn EBADF` por FD leak em Pi/bash executor.
  - `dmtrKovalenko/fff#357`: uso excessivo de watchers.
  - `dmtrKovalenko/fff#422`: watcher thread em `fff-node v0.6.4`; mitigação `disableWatch: true`.
  - `opencode-fff-search`: referência prática usando FFF com defaults seguros.

## Decisões de segurança

Por padrão, `FileFinder.create()` usa:

```ts
{
  aiMode: false,
  disableMmapCache: true,
  disableContentIndexing: true,
  disableWatch: true,
}
```

Isso segue a linha do `opencode-fff-search`: busca rápida em memória, mas sem watcher nativo, sem mmap cache, sem content index e sem DB/frecency por padrão.

Tradeoff: watcher desligado não recebe eventos do sistema de arquivos. A extensão compensa com auto-reindex seguro após `edit`/`write`/comandos shell mutantes e em buscas sem resultado, com intervalo mínimo configurável. `/fff-prisema-reindex` continua disponível para rescan manual.

## Ferramentas

Por padrão registra nomes drop-in:

- `fffind`
- `ffgrep`
- `fff-multi-grep`

Não carrega autocomplete `@` customizado. Intencional: menor superfície de FD leak e menos interferência no editor Pi.

## Comandos

- `/fff-prisema-status` — mostra cwd, indexed files e opções seguras.
- `/fff-prisema-doctor` — valida fontes instaladas, colisões com `@ff-labs/pi-fff` e flags inseguras.
- `/fff-prisema-reindex` — força rescan do projeto atual.
- `/fff-prisema-dispose` — destrói runtime atual; próxima busca reinicializa.

## Instalação

### Uso normal/global via GitHub

```bash
cd pi-fff-prisema
bash scripts/install-global.sh
```

Esse caminho instala `git:github.com/prisema/pi-fff-prisema` no settings global do Pi (`~/.pi/agent/settings.json`). O checkout local só é usado para preflight (`bun install`, typecheck e smoke).

### Desenvolvimento local

```bash
cd pi-fff-prisema
bash scripts/install-local.sh
```

Esse caminho também escreve no settings global do Pi, mas a fonte instalada é este checkout por path local. Útil para testar mudanças locais antes de publicar. Não escreve `.pi/settings.json` do projeto.

### Diagnóstico

```bash
bun run doctor
```

O doctor avisa se faltar dependência local, se `npm:@ff-labs/pi-fff` ainda estiver instalado, ou se houver fontes duplicadas (`git` + path local) registrando as mesmas tools.

Reinicie Pi após instalar e rode `/fff-prisema-status`.

## Instalar sem colidir com `@ff-labs/pi-fff`

Se quiser testar lado a lado, use prefixo:

```bash
PI_FFF_PRISEMA_PREFIX=prisema pi
```

Nesse modo as tools viram:

- `prisema-fffind`
- `prisema-ffgrep`
- `prisema-fff-multi-grep`

## Publicar no GitHub

Depois de validar localmente:

```bash
cd pi-fff-prisema
git init
git add .
git commit -m "feat: add PFFPrisema safe FFF Pi extension"
gh repo create prisema/pi-fff-prisema --public --source=. --remote=origin --push
```

## Variáveis de ambiente

| Env | Default | Uso |
|---|---:|---|
| `PI_FFF_PRISEMA_DISABLE_WATCH` | `true` | `0` religa watcher nativo |
| `PI_FFF_PRISEMA_DISABLE_MMAP_CACHE` | `true` | `0` religa mmap cache |
| `PI_FFF_PRISEMA_DISABLE_CONTENT_INDEXING` | `true` | `0` religa content index |
| `PI_FFF_PRISEMA_AI_MODE` | `false` | `1` religa modo AI/frecency |
| `PI_FFF_PRISEMA_SCAN_TIMEOUT_MS` | `15000` | timeout de scan inicial |
| `PI_FFF_PRISEMA_GREP_TIME_BUDGET_MS` | `5000` | orçamento por grep |
| `PI_FFF_PRISEMA_AUTO_REINDEX` | `true` | `0` desliga reindex automático quando watcher está off |
| `PI_FFF_PRISEMA_AUTO_REINDEX_MIN_INTERVAL_MS` | `30000` | intervalo mínimo para retry com reindex em buscas sem resultado |
| `PI_FFF_PRISEMA_PREFIX` | vazio | prefixo para tool names |

## Verificar FD leak no Pi

Dentro de uma sessão Pi:

```bash
bash scripts/check-pi-fds.sh
```

Antes, vimos ~12k FDs e milhares de `DIR`. Com watcher desligado, esperado é ficar baixo/estável.
