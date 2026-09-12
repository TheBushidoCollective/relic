#!/usr/bin/env bash
# IBM Plex fonts are licensed under the SIL Open Font License, Version 1.1 (OFL 1.1).
# Copyright 2017-2018 IBM Corp. All rights reserved.
#
# Regenerate with:
#   ./packages/relic-viewer/tools/render-card.sh
# or:
#   cd packages/relic-viewer && ./tools/render-card.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bun "${DIR}/render-card.ts" "$@"
