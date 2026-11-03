#!/usr/bin/env bash
# Claude SubagentStart / SubagentStop / Stop / SessionStart hook, loaded only through the --settings wrangler passes
# to the Claude it starts. Usage: subagents.sh <data dir> (wrangler's data/projects).
# Keeps <data dir>/subagents/<herdr terminal>/<agent id>.json ({id, type, meta, at}) while a sub-agent runs, for the
# agents list. Stop keeps only the background tasks Claude still lists as running (an interrupted one sends no
# SubagentStop); a new or resumed session clears its terminal's folder. Prints nothing.
set -u

term="${HC_TERMINAL_ID:-}"
[[ "$term" =~ ^[A-Za-z0-9_-]+$ ]] && [ -n "${1:-}" ] || exit 0
dir="$1/subagents/$term"
safe='^[A-Za-z0-9_-]+$'

input="$(cat)"
[[ "$input" =~ \"hook_event_name\":\ ?\"([A-Za-z]+)\" ]] || exit 0
event="${BASH_REMATCH[1]}"
case "$event" in
  SessionStart) rm -rf -- "$dir" ;;
  Stop)
    [ -d "$dir" ] || exit 0
    running=" $(jq -r '[.background_tasks[]? | select(.status == "running") | .id] | join(" ")' <<<"$input" 2>/dev/null) "
    for f in "$dir"/*.json; do
      [ -f "$f" ] || continue
      id="${f##*/}"
      id="${id%.json}"
      [[ "$running" == *" $id "* ]] || rm -f -- "$f"
    done
    rmdir "$dir" 2>/dev/null ;;
  SubagentStart)
    id="$(jq -r '.agent_id // empty' <<<"$input" 2>/dev/null)"
    [[ "$id" =~ $safe ]] || exit 0
    mkdir -p "$dir" || exit 0
    jq -c --argjson at "$(date +%s)000" \
      '{id: .agent_id, type: (.agent_type // ""), meta: ((.transcript_path // "" | sub("\\.jsonl$"; "")) + "/subagents/agent-" + .agent_id + ".meta.json"), $at}' \
      <<<"$input" >"$dir/$id.tmp" 2>/dev/null && mv -f -- "$dir/$id.tmp" "$dir/$id.json" ;;
  SubagentStop)
    id="$(jq -r '.agent_id // empty' <<<"$input" 2>/dev/null)"
    [[ "$id" =~ $safe ]] || exit 0
    rm -f -- "$dir/$id.json"
    rmdir "$dir" 2>/dev/null ;;
esac
exit 0
