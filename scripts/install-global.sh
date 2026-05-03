#!/usr/bin/env bash
set -euo pipefail

# Instala pi-fff-prisema como pacote GLOBAL via GitHub no settings GLOBAL do Pi.
# Não depende deste checkout local depois da instalação.
# Uso:
#   bash scripts/install-global.sh

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${PI_FFF_PRISEMA_SOURCE:-git:github.com/prisema/pi-fff-prisema}"

echo "Installing PFFPrisema GitHub source into global Pi settings (~/.pi/agent/settings.json)."
echo "Source: ${SOURCE}"
echo "Local checkout used only for preflight checks: ${ROOT}"
echo

cd "${ROOT}"
bun install
bun run typecheck
bun run smoke /Users/rizzao/Projetos/MeusProjetos/vindula

# Remove possíveis fontes que registram os mesmos tool names (fffind/ffgrep/fff-multi-grep).
pi remove npm:@ff-labs/pi-fff || true
pi remove "${ROOT}" || true
pi remove git:github.com/prisema/pi-fff-prisema || true
pi remove https://github.com/prisema/pi-fff-prisema || true

pi install "${SOURCE}"

bun scripts/doctor.mjs --expect-source=git --strict

echo "Installed PFFPrisema GitHub source: ${SOURCE}"
echo "Restart Pi, then run /fff-prisema-status."
