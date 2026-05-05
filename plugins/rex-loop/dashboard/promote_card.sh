#!/bin/bash
# promote_card.sh <card-id>
# Backlog → Active: parses spec frontmatter, creates ~/.hermes/missions/<name>/,
# adds cron entry, patches card to status=active. Idempotent for re-runs (idempotent
# means: if the mission dir already exists, refuse with rc=2; if the cron line is
# already present, don't duplicate it).
set -euo pipefail

HOME_DIR="${HOME:-/home/ubuntu}"
HERMES="$HOME_DIR/.hermes"
KANBAN="$HERMES/kanban"
MISSIONS="$HERMES/missions"
LOOP="$HERMES/loop"
LOG="$KANBAN/pm.log"

now() { date -Iseconds; }
log_evt() {
    local card_id="$1" event="$2" msg="$3"
    printf "[%s] [%s] [%s] %s\n" "$(now)" "$card_id" "$event" "$msg" >> "$LOG"
}

CARD_ID="${1:?usage: promote_card.sh <card-id>}"
CARD_FILE="$KANBAN/cards/$CARD_ID.md"
SPEC_FILE="$KANBAN/scoping/$CARD_ID.md"

[ -f "$CARD_FILE" ] || { echo "card not found: $CARD_FILE" >&2; exit 1; }
[ -f "$SPEC_FILE" ] || { echo "spec not found: $SPEC_FILE" >&2; exit 1; }

# Parse spec frontmatter
PARSE=$(python3 - "$SPEC_FILE" <<'PY'
import sys, yaml
text = open(sys.argv[1]).read()
parts = text.split("---", 2)
if len(parts) < 3:
    print("ERR: bad frontmatter"); sys.exit(1)
fm = yaml.safe_load(parts[1]) or {}
print(fm.get("mission_name", ""))
print(fm.get("max_days", ""))
print(fm.get("workspace", ""))
print(fm.get("cron_schedule") or "*/30 * * * *")
PY
)
MISSION_NAME=$(sed -n 1p <<<"$PARSE")
MAX_DAYS=$(sed -n 2p <<<"$PARSE")
WORKSPACE=$(sed -n 3p <<<"$PARSE")
CRON_SCHED=$(sed -n 4p <<<"$PARSE")

[ -n "$MISSION_NAME" ] || { echo "missing mission_name" >&2; exit 1; }

MISSION_DIR="$MISSIONS/$MISSION_NAME"
if [ -e "$MISSION_DIR" ]; then
    echo "mission already exists: $MISSION_DIR" >&2
    exit 2
fi

# Create mission dir + files
mkdir -p "$MISSION_DIR/ticks" "$MISSION_DIR/logs"
# Copy plan.md (body of spec, after the 2nd ---)
python3 - "$SPEC_FILE" "$MISSION_DIR/plan.md" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src).read()
parts = text.split("---", 2)
body = parts[2] if len(parts) >= 3 else text
open(dst, "w").write(body.lstrip("\n"))
PY

echo "active" > "$MISSION_DIR/STATUS"
date -u -Iseconds > "$MISSION_DIR/started_at"
echo "$MAX_DAYS" > "$MISSION_DIR/max_days"
echo "$WORKSPACE" > "$MISSION_DIR/workspace"

# Add cron entry — idempotent guard
TMP=$(mktemp); crontab -l 2>/dev/null > "$TMP" || true
CRON_LINE="$CRON_SCHED /home/ubuntu/.hermes/loop/runner.sh $MISSION_NAME"
if ! grep -qF -- "runner.sh $MISSION_NAME" "$TMP"; then
    printf "%s\n" "$CRON_LINE" >> "$TMP"
    crontab "$TMP"
    log_evt "$CARD_ID" "cron-added" "$CRON_LINE"
fi
rm -f "$TMP"

# Patch card: status=active, mission_name=<name>
python3 - "$CARD_FILE" "$MISSION_NAME" <<'PY'
import sys, re, json, datetime, os
card_file, mission_name = sys.argv[1], sys.argv[2]
events_file = os.path.expanduser("~/.hermes/kanban/events.jsonl")
txt = open(card_file).read()
ts = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
m = re.search(r"^status:\s*(\S+)", txt, re.MULTILINE)
old = m.group(1) if m else "unknown"
txt = re.sub(r"^status:\s*\S+",       "status: active",                 txt, count=1, flags=re.MULTILINE)
txt = re.sub(r"^updated_at:\s*\S+",   f"updated_at: {ts}",              txt, count=1, flags=re.MULTILINE)
txt = re.sub(r"^mission_name:\s*\S+", f"mission_name: {mission_name}",  txt, count=1, flags=re.MULTILINE)
open(card_file, "w").write(txt)
with open(events_file, "a") as f:
    f.write(json.dumps({
        "ts": ts, "card_id": os.path.basename(card_file).removesuffix(".md"),
        "from": old, "to": "active", "actor": "promote",
    }) + "\n")
PY

log_evt "$CARD_ID" "promoted" "mission=$MISSION_NAME workspace=$WORKSPACE max_days=$MAX_DAYS schedule=$CRON_SCHED"
echo "promoted: $CARD_ID -> $MISSION_NAME"
