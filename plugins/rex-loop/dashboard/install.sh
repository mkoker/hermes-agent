#!/bin/bash
# Idempotent installer for the Rex Loop war-room infrastructure.
# Creates kanban dirs, the `pm` Hermes profile, and the loop scripts. Re-runnable.
set -euo pipefail

HOME_DIR="${HOME:-/home/ubuntu}"
HERMES="$HOME_DIR/.hermes"
LOOP="$HERMES/loop"
KANBAN="$HERMES/kanban"
PROFILES="$HERMES/profiles"
PLUGIN="$HERMES/hermes-agent/plugins/rex-loop/dashboard"

say() { printf "[install] %s\n" "$*"; }

# 1. Kanban dirs
mkdir -p "$KANBAN/cards" "$KANBAN/scoping"
[ -f "$KANBAN/events.jsonl" ] || : > "$KANBAN/events.jsonl"
[ -f "$KANBAN/pm.log" ]      || : > "$KANBAN/pm.log"
# AUTO_FLOW present by default ("this should just happen" per spec §7.5)
[ -e "$KANBAN/AUTO_FLOW" ]    || touch "$KANBAN/AUTO_FLOW"
say "kanban dirs ready at $KANBAN"

# 2. PM profile
mkdir -p "$PROFILES/pm"
if [ ! -f "$PROFILES/pm/config.yaml" ]; then
    cp "$PLUGIN/pm-config.yaml" "$PROFILES/pm/config.yaml"
    say "wrote $PROFILES/pm/config.yaml"
else
    say "$PROFILES/pm/config.yaml exists — leaving as-is"
fi
if [ ! -f "$PROFILES/pm/SOUL.md" ]; then
    cp "$PLUGIN/pm-soul.md" "$PROFILES/pm/SOUL.md"
    say "wrote $PROFILES/pm/SOUL.md"
else
    say "$PROFILES/pm/SOUL.md exists — leaving as-is"
fi

# 3. Loop scripts (always overwrite — they're version-controlled in the plugin dir)
install -m 0755 "$PLUGIN/pm_runner.sh"     "$LOOP/pm_runner.sh"
install -m 0755 "$PLUGIN/promote_card.sh"  "$LOOP/promote_card.sh"
install -m 0755 "$PLUGIN/refresh-tokens.sh" "$LOOP/refresh-tokens.sh" 2>/dev/null || true
say "installed loop scripts under $LOOP"

# 4. Cron
TMP=$(mktemp)
crontab -l 2>/dev/null > "$TMP" || true
add_or_keep() {
    local pattern="$1" line="$2"
    if ! grep -qF -- "$pattern" "$TMP"; then
        printf "%s\n" "$line" >> "$TMP"
        say "added cron: $line"
    else
        say "cron already present: $pattern"
    fi
}
add_or_keep "pm_runner.sh"      "*/5 * * * * /home/ubuntu/.hermes/loop/pm_runner.sh >> $KANBAN/pm.log 2>&1"
add_or_keep "refresh-tokens.sh" "*/15 * * * * /home/ubuntu/.hermes/loop/refresh-tokens.sh >> $LOOP/refresh-tokens.log 2>&1"
crontab "$TMP" && rm -f "$TMP"
say "cron updated"

say "DONE."
