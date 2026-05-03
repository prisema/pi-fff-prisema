#!/usr/bin/env bash
set -euo pipefail

# Instala pi-fff-prisema localmente e remove @ff-labs/pi-fff para evitar colisão
# de tool names (fffind/ffgrep/fff-multi-grep).
# Uso:
#   bash scripts/install-local.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "${ROOT}"
bun install
bun run typecheck
bun run smoke /Users/rizzao/Projetos/MeusProjetos/vindula

pi remove npm:@ff-labs/pi-fff || true
pi install "${ROOT}"

echo "Installed PFFPrisema from ${ROOT}"
echo "Restart Pi, then run /fff-prisema-status."
