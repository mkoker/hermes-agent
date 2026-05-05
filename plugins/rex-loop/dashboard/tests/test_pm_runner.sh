#!/bin/bash
# Drive pm_runner.sh against an isolated HERMES root with a fake hermes binary.
# Asserts: card transitions inbox -> scoping -> backlog (or active if AUTO_FLOW),
# events.jsonl has the right transitions, pm.log has scope-start/scope-end.
set -euo pipefail

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/.hermes/loop" "$WORK/.hermes/kanban/cards" "$WORK/.hermes/kanban/scoping" "$WORK/.hermes/missions" "$WORK/bin"
: > "$WORK/.hermes/kanban/events.jsonl"
: > "$WORK/.hermes/kanban/pm.log"

# Fake hermes that emits a deterministic valid spec to stdout
cat > "$WORK/bin/hermes" <<'SHIM'
#!/bin/bash
# Echo the canned mission spec — ignore all flags
cat <<EOM
---
mission_name: smoke-pm-test
max_days: 7
workspace: /mnt/nvme/smoke-pm-test
cron_schedule: */30 * * * *
needs_review: false
---
# Smoke PM Test

> Verifies pm_runner end-to-end with a deterministic plan.

### PHASE 1 · BOOTSTRAP

- [ ] T01 Create workspace
  GATES:
  - workspace dir exists

- [ ] T02 Write README
  GATES:
  - README.md exists

- [ ] T03 Run baseline test
  GATES:
  - tests pass

- [ ] T04 Tag complete
  GATES:
  - mission STATUS is done
EOM
SHIM
chmod +x "$WORK/bin/hermes"

# Drop a card in inbox
CARD_ID=$(date -u +%Y-%m-%d)-smoke-test
cat > "$WORK/.hermes/kanban/cards/$CARD_ID.md" <<EOM
---
id: $CARD_ID
status: inbox
title: Smoke PM Test
tag: smoke
created_at: $(date -Iseconds)
updated_at: $(date -Iseconds)
mission_name: null
spec_path: null
needs_review: false
scope_attempts: 0
---
# Smoke PM Test
EOM

# Install pm_runner + promote_card with HOME pointed at $WORK
install -m 0755 ~/.hermes/hermes-agent/plugins/rex-loop/dashboard/pm_runner.sh    "$WORK/.hermes/loop/pm_runner.sh"
install -m 0755 ~/.hermes/hermes-agent/plugins/rex-loop/dashboard/promote_card.sh "$WORK/.hermes/loop/promote_card.sh"

# Disable auto-flow for this test (test promote_card separately)
rm -f "$WORK/.hermes/kanban/AUTO_FLOW"

# Run pm_runner with isolated HOME and shimmed hermes
HOME="$WORK" HERMES_BIN="$WORK/bin/hermes" "$WORK/.hermes/loop/pm_runner.sh"

# Assertions
STATUS=$(awk -F': ' "/^status:/{print \$2; exit}" "$WORK/.hermes/kanban/cards/$CARD_ID.md")
SPEC_PATH=$(awk -F': ' "/^spec_path:/{print \$2; exit}" "$WORK/.hermes/kanban/cards/$CARD_ID.md")
[ "$STATUS" = "backlog" ] || { echo "FAIL: status=$STATUS expected backlog"; exit 1; }
[ -n "$SPEC_PATH" ] && [ "$SPEC_PATH" != "null" ] || { echo "FAIL: spec_path empty"; exit 1; }
[ -f "$WORK/.hermes/kanban/scoping/$CARD_ID.md" ] || { echo "FAIL: spec file not written"; exit 1; }
grep -q "\"to\": \"scoping\"" "$WORK/.hermes/kanban/events.jsonl" || { echo "FAIL: scoping event missing"; exit 1; }
grep -q "\"to\": \"backlog\"" "$WORK/.hermes/kanban/events.jsonl" || { echo "FAIL: backlog event missing"; exit 1; }
grep -q "scope-start" "$WORK/.hermes/kanban/pm.log" || { echo "FAIL: scope-start missing in pm.log"; exit 1; }
grep -q "scope-end"   "$WORK/.hermes/kanban/pm.log" || { echo "FAIL: scope-end missing in pm.log"; exit 1; }

# Now test promote_card
HOME="$WORK" "$WORK/.hermes/loop/promote_card.sh" "$CARD_ID"
[ -d "$WORK/.hermes/missions/smoke-pm-test" ] || { echo "FAIL: mission dir not created"; exit 1; }
[ "$(cat "$WORK/.hermes/missions/smoke-pm-test/STATUS")" = "active" ] || { echo "FAIL: STATUS != active"; exit 1; }
ACTIVE_STATUS=$(awk -F': ' "/^status:/{print \$2; exit}" "$WORK/.hermes/kanban/cards/$CARD_ID.md")
[ "$ACTIVE_STATUS" = "active" ] || { echo "FAIL: card status=$ACTIVE_STATUS expected active"; exit 1; }

echo "PASS: pm_runner + promote_card end-to-end with shim"
