#!/usr/bin/env bash
set -euo pipefail

# Instala pi-fff-prisema como fonte LOCAL DE DESENVOLVIMENTO no settings GLOBAL do Pi.
# Não escreve .pi/settings.json do projeto. O Pi passa a carregar este checkout por path.
# Uso:
#   bash scripts/install-local.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Installing PFFPrisema LOCAL DEV source into global Pi settings (~/.pi/agent/settings.json)."
echo "Source path: ${ROOT}"
echo "For GitHub/global source instead, run: bash scripts/install-global.sh"
echo

cd "${ROOT}"
bun install
bun run typecheck
bun run smoke /Users/rizzao/Projetos/MeusProjetos/vindula

# Remove possíveis fontes que registram os mesmos tool names (fffind/ffgrep/fff-multi-grep).
pi remove npm:@ff-labs/pi-fff || true
pi remove git:github.com/prisema/pi-fff-prisema || true
pi remove https://github.com/prisema/pi-fff-prisema || true
pi remove "${ROOT}" || true

pi install "${ROOT}"

bun scripts/doctor.mjs --expect-source=local --strict

echo "Installed PFFPrisema local-dev source from ${ROOT}"
echo "Restart Pi, then run /fff-prisema-status."
