#!/bin/bash
# pm_runner.sh — picks the oldest Inbox card, runs the PM agent to scope it,
# validates the result, transitions the card, and (if AUTO_FLOW is set) promotes.
#
# Driven by cron @ */5min. Single-flight via flock.
set -euo pipefail

HOME_DIR="${HOME:-/home/ubuntu}"
HERMES="$HOME_DIR/.hermes"
KANBAN="$HERMES/kanban"
LOOP="$HERMES/loop"
LOG="$KANBAN/pm.log"
LOCK="$LOOP/.pm_runner.lock"
HERMES_BIN="${HERMES_BIN:-$HOME_DIR/.hermes/hermes-agent/venv/bin/hermes}"

now() { date -Iseconds; }
log() { printf "[%s] %s\n" "$(now)" "$*" | tee -a "$LOG"; }
log_evt() {
    local card_id="$1" event="$2" msg="$3"
    printf "[%s] [%s] [%s] %s\n" "$(now)" "$card_id" "$event" "$msg" >> "$LOG"
}

# Acquire single-flight lock (don't queue — just exit if another runner is active)
exec 9>"$LOCK"
if ! flock -n 9; then
    log "another pm_runner is active — exiting"
    exit 0
fi

# Pause checks (global PAUSE OR PM-only PM_PAUSE)
if [ -e "$HERMES/loop/PAUSE" ]; then
    log "global PAUSE present — exiting"
    exit 0
fi
if [ -e "$KANBAN/PM_PAUSE" ]; then
    log "PM_PAUSE present — exiting"
    exit 0
fi

# Find next Inbox card (oldest first by created_at in frontmatter)
NEXT=$(python3 - <<'PY'
import os, re, glob
cards = []
for p in sorted(glob.glob(os.path.expanduser("~/.hermes/kanban/cards/*.md"))):
    txt = open(p).read()
    m = re.search(r"^status:\s*(\S+)", txt, re.MULTILINE)
    if not m or m.group(1) != "inbox":
        continue
    cm = re.search(r"^created_at:\s*(\S+)", txt, re.MULTILINE)
    cards.append((cm.group(1) if cm else "", p))
if cards:
    cards.sort()
    print(cards[0][1])
PY
)
if [ -z "$NEXT" ]; then
    log "no inbox cards"
    exit 0
fi

CARD_FILE="$NEXT"
CARD_ID=$(basename "$CARD_FILE" .md)
log_evt "$CARD_ID" "scope-start" "moving inbox -> scoping"

# patch_card: set status, append events.jsonl
patch_card() {
    local card_file="$1" new_status="$2" actor="${3:-pm}"
    python3 - "$card_file" "$new_status" "$actor" <<'PY'
import sys, re, json, datetime
card_file, new_status, actor = sys.argv[1], sys.argv[2], sys.argv[3]
import os
events_file = os.path.expanduser("~/.hermes/kanban/events.jsonl")
txt = open(card_file).read()
m = re.search(r"^status:\s*(\S+)", txt, re.MULTILINE)
old = m.group(1) if m else "unknown"
new_txt = re.sub(r"^status:\s*\S+", f"status: {new_status}", txt, count=1, flags=re.MULTILINE)
ts = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
new_txt = re.sub(r"^updated_at:\s*\S+", f"updated_at: {ts}", new_txt, count=1, flags=re.MULTILINE)
open(card_file, "w").write(new_txt)
with open(events_file, "a") as f:
    f.write(json.dumps({
        "ts": ts,
        "card_id": os.path.basename(card_file).removesuffix(".md"),
        "from": old, "to": new_status, "actor": actor,
    }) + "\n")
PY
}

# patch_card_field: set arbitrary frontmatter field (operates only on the YAML
# block between the opening and closing --- fences so the missing-key insert
# path cannot match the opening fence and corrupt the card)
patch_card_field() {
    local card_file="$1" key="$2" value="$3"
    python3 - "$card_file" "$key" "$value" <<'PY'
import sys, re
card_file, key, value = sys.argv[1], sys.argv[2], sys.argv[3]
txt = open(card_file).read()
parts = txt.split("---", 2)
if len(parts) < 3:
    raise SystemExit(f"no frontmatter in {card_file}")
fm = parts[1]
pat = rf"^{re.escape(key)}:\s*.*$"
if re.search(pat, fm, re.MULTILINE):
    fm = re.sub(pat, f"{key}: {value}", fm, count=1, flags=re.MULTILINE)
else:
    fm = fm.rstrip("\n") + f"\n{key}: {value}\n"
parts[1] = fm
open(card_file, "w").write("---".join(parts))
PY
}

# Step 1: move to scoping
patch_card "$CARD_FILE" "scoping"

# Step 2: build prompt with active mission list
ACTIVE_MISSIONS=$(ls "$HERMES/missions/" 2>/dev/null | tr '\n' ',' | sed 's/,$//')
CARD_BODY=$(awk '/^---$/{c++; next} c==2' "$CARD_FILE")
CARD_TITLE=$(awk -F': ' '/^title:/{print $2; exit}' "$CARD_FILE")
CARD_TAG=$(awk -F': ' '/^tag:/{print $2; exit}' "$CARD_FILE")

PROMPT=$(cat <<EOM
Scope this idea into a runnable mission spec.

Title: $CARD_TITLE
$( [ -n "$CARD_TAG" ] && [ "$CARD_TAG" != "null" ] && echo "Tag: $CARD_TAG" )

Existing active missions (DO NOT collide with these names): $ACTIVE_MISSIONS

Idea body (may be empty):
---
$CARD_BODY
---

Emit ONLY the mission spec (frontmatter + plan.md body) per your output contract. No preamble.
EOM
)

# Step 3: invoke PM
SCOPING_OUT="$KANBAN/scoping/$CARD_ID.md"
log_evt "$CARD_ID" "pm-invoke" "calling hermes chat --profile pm"
set +e
"$HERMES_BIN" chat -Q --profile pm --yolo --max-turns 30 -q "$PROMPT" \
    > "$SCOPING_OUT" 2>>"$LOG"
RC=$?
set -e

if [ $RC -ne 0 ] || [ ! -s "$SCOPING_OUT" ]; then
    log_evt "$CARD_ID" "pm-error" "hermes exited rc=$RC; sending card back to inbox with attempt++"
    ATTEMPTS=$(awk -F': ' '/^scope_attempts:/{print $2+0; exit}' "$CARD_FILE")
    NEW_ATTEMPTS=$((${ATTEMPTS:-0} + 1))
    patch_card_field "$CARD_FILE" "scope_attempts" "$NEW_ATTEMPTS"
    if [ "$NEW_ATTEMPTS" -ge 3 ]; then
        patch_card_field "$CARD_FILE" "needs_review" "true"
        patch_card "$CARD_FILE" "backlog"   # park it for Mike to fix
        log_evt "$CARD_ID" "scope-fail" "after 3 attempts — parked in backlog with needs_review=true"
    else
        patch_card "$CARD_FILE" "inbox"     # try again next cron
        log_evt "$CARD_ID" "scope-fail" "attempt $NEW_ATTEMPTS — back to inbox"
    fi
    exit 0
fi

# Step 4: validate spec
VALIDATE_RC=$(python3 - "$SCOPING_OUT" "$ACTIVE_MISSIONS" <<'PY'
import sys, re, yaml
out_file, active = sys.argv[1], (sys.argv[2] or "").split(",")
text = open(out_file).read()
if not text.startswith("---"):
    print("FAIL: no frontmatter"); sys.exit(1)
parts = text.split("---", 2)
if len(parts) < 3:
    print("FAIL: incomplete frontmatter"); sys.exit(1)
try:
    fm = yaml.safe_load(parts[1]) or {}
except Exception as e:
    print(f"FAIL: yaml error: {e}"); sys.exit(1)
body = parts[2]
errors = []
name = fm.get("mission_name") or ""
if not re.match(r"^[a-z][a-z0-9-]{0,31}$", name):
    errors.append(f"mission_name '{name}' invalid (kebab-case ≤32)")
if name in [a.strip() for a in active if a.strip()]:
    errors.append(f"mission_name '{name}' collides with existing")
md = fm.get("max_days")
if not isinstance(md, int) or md < 1 or md > 90:
    if not fm.get("needs_review"):
        errors.append(f"max_days={md} outside 1–90 and needs_review!=true")
ws = fm.get("workspace") or ""
if not (ws.startswith("/mnt/nvme/") or ws.startswith("/home/ubuntu/")):
    errors.append(f"workspace='{ws}' must be under /mnt/nvme/ or /home/ubuntu/")
tasks = re.findall(r"^- \[ \] T\d+", body, re.MULTILINE)
if not (4 <= len(tasks) <= 30):
    errors.append(f"task count={len(tasks)} not in [4,30]")
gate_count = len(re.findall(r"^\s*GATES:\s*$", body, re.MULTILINE))
if gate_count < len(tasks):
    errors.append(f"GATES blocks={gate_count} < tasks={len(tasks)}")
if errors:
    print("FAIL: " + "; ".join(errors)); sys.exit(1)
print("OK")
sys.exit(0)
PY
)
if [ "$(echo "$VALIDATE_RC" | head -1)" != "OK" ]; then
    log_evt "$CARD_ID" "validate-fail" "$VALIDATE_RC"
    ATTEMPTS=$(awk -F': ' '/^scope_attempts:/{print $2+0; exit}' "$CARD_FILE")
    NEW_ATTEMPTS=$((${ATTEMPTS:-0} + 1))
    patch_card_field "$CARD_FILE" "scope_attempts" "$NEW_ATTEMPTS"
    if [ "$NEW_ATTEMPTS" -ge 3 ]; then
        patch_card_field "$CARD_FILE" "needs_review" "true"
        patch_card "$CARD_FILE" "backlog"
        log_evt "$CARD_ID" "scope-fail" "after 3 attempts — parked in backlog with needs_review=true"
    else
        patch_card "$CARD_FILE" "inbox"
        log_evt "$CARD_ID" "scope-fail" "attempt $NEW_ATTEMPTS — back to inbox"
    fi
    exit 0
fi

# Step 5: success — set spec_path on card, move to backlog, optionally promote
patch_card_field "$CARD_FILE" "spec_path" "$SCOPING_OUT"
patch_card "$CARD_FILE" "backlog"
log_evt "$CARD_ID" "scope-end" "OK — spec at $SCOPING_OUT"

if [ -e "$KANBAN/AUTO_FLOW" ] && [ ! -e "$HERMES/loop/PAUSE" ]; then
    log_evt "$CARD_ID" "auto-promote" "AUTO_FLOW is set — promoting to active"
    "$LOOP/promote_card.sh" "$CARD_ID" >> "$LOG" 2>&1 || log_evt "$CARD_ID" "promote-error" "promote_card.sh failed (rc=$?)"
fi
