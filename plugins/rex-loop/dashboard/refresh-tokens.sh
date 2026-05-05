#!/bin/bash
# Cron entrypoint that warms the token cache by hitting /tokens/today.
# Spec §4.7: "optional cron … for steady-state freshness without first-request latency".
set -euo pipefail
URL="${REX_LOOP_REFRESH_URL:-http://localhost:9119/api/plugins/rex-loop/tokens/today}"
TIMEOUT="${REX_LOOP_REFRESH_TIMEOUT:-30}"
curl -sS --max-time "$TIMEOUT" "$URL" >/dev/null 2>&1 || exit 0
