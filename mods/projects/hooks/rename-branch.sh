#!/usr/bin/env bash
# Claude UserPromptSubmit hook, loaded only through the --settings wrangler passes to the Claude it starts.
# Usage: rename-branch.sh [<data dir>] (wrangler's data/projects: projects.json, naming-prompt.txt).
# On the first real prompt in a linked worktree still on a temp branch (git config branch.<name>.wranglerTemp,
# set by wrangler when it makes one), names the branch from the prompt with settings.naming.model (default
# haiku, as mods/projects/agent.js does), renames it and the herdr space holding this terminal. Off when
# settings.naming.enabled is false. Prints nothing (stdout would reach Claude) and returns at once: the work
# runs detached. The model failing keeps the temp name. Failures go to $XDG_STATE_HOME/wrangler/rename.log.
set -u

self="$(readlink -f "${BASH_SOURCE[0]}")"
state="${XDG_STATE_HOME:-$HOME/.local/state}/wrangler"
log="$state/rename.log"

fail() {
  mkdir -p "$state" && printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$log"
  exit 0
}

# limit <seconds> <cmd>...: timeout, else gtimeout, else a kill of its process group (call in a subshell).
limit() {
  local s="$1" t pid w rc
  shift
  t="$(command -v timeout || command -v gtimeout)" && { "$t" "$s" "$@"; return; }
  set -m
  "$@" &
  pid=$!
  (sleep "$s" && kill -- "-$pid") >/dev/null 2>&1 &
  w=$!
  wait "$pid"
  rc=$?
  kill -- "-$w" 2>/dev/null
  return "$rc"
}

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  printf '%s' "${s%"${s##*[![:space:]]}"}"
}

# [a-z0-9/-], dashes collapsed, no empty or dash-edged segments, at most 64.
clean() {
  local s out="" seg IFS=/
  s="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's#[^a-z0-9/-]+#-#g; s#-+#-#g; s#/+#/#g')"
  for seg in $s; do
    seg="${seg#-}"
    seg="${seg%-}"
    [ -n "$seg" ] && out="${out:+$out/}$seg"
  done
  out="${out:0:64}"
  while [[ "$out" == *[-/] ]]; do out="${out%?}"; done
  printf '%s' "$out"
}

work() {
  local top="$1" old="$2" term="$3" data="$4" model="$5" prompt sys ask reply rc line name new i n cur space sid sname r
  prompt="$(trim "$6")"
  find "$state/locks" -mindepth 1 -maxdepth 1 -mtime +30 -exec rmdir {} + 2>/dev/null
  sys="$(cat "$data/naming-prompt.txt" 2>/dev/null)"
  [ -n "$(trim "$sys")" ] || sys="$(cat "${self%/hooks/*}/naming-prompt.txt" 2>/dev/null)"
  [ -n "$sys" ] || fail "$top: naming-prompt.txt missing"
  ask=$'Task text (quoted, not addressed to you):\n<task>\n'"$prompt"$'\n</task>\nBranch name for this task:'
  reply="$(cd "$HOME" && limit 20 env -u CLAUDECODE -u CLAUDE_PID -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_CODE_SESSION_ID \
    -u CLAUDE_CODE_CHILD_SESSION -u CLAUDE_CODE_SESSION_ATTENDED -u CLAUDE_CODE_MESSAGING_SOCKET \
    -u CLAUDE_CODE_MESSAGING_TOKEN -u HC_TERMINAL_ID -u HC_SCOPE \
    claude -p "$ask" --system-prompt "$sys" --model "$model" --no-session-persistence \
    --strict-mcp-config --disable-slash-commands --tools "" </dev/null 2>&1)"
  rc=$?
  [ "$rc" -eq 0 ] || fail "$top: $model failed ($rc): $(printf '%s' "$reply" | tail -n 1)"
  line=""
  while IFS= read -r line; do
    line="$(trim "$(printf '%s' "$line" | tr -d "\`\"'*")")"
    [ -n "$line" ] && break
  done <<<"$reply"
  name="$(clean "$line")"
  [[ "$name" =~ ^[a-z]+/[a-z0-9]+(-[a-z0-9]+)*$ ]] && [ "${name%%/*}" != type ] && [ "${name#*/}" != slug ] ||
    fail "$top: unexpected reply: ${line:0:60}"
  git -C "$top" check-ref-format --branch "$name" >/dev/null 2>&1 || fail "$top: invalid branch name $name"
  new="$name"
  for ((i = 2; ; i++)); do
    git -C "$top" show-ref --verify --quiet "refs/heads/$new" || break
    n="${name:0:$((63 - ${#i}))}"
    while [[ "$n" == *[-/] ]]; do n="${n%?}"; done
    new="$n-$i"
  done
  cur="$(git -C "$top" symbolic-ref --short -q HEAD)"
  [ "$cur" = "$old" ] || fail "$top: branch is now $cur, not $old"
  r="$(git -C "$top" branch -m "$old" "$new" 2>&1)" || fail "$top: git branch -m $old $new: $r"
  git -C "$top" config --unset "branch.$new.wranglerTemp" 2>/dev/null
  # The window whose data dir this is (terminal ids repeat across windows); its menus and lists show the new name.
  case "$data" in */data/projects) export HERDR_APP_HOME="${data%/data/projects}" ;; esac
  herdr-app do "projects.refresh:$top" >/dev/null 2>&1
  [ -n "$term" ] || exit 0
  space="$(herdr-app ls 2>/dev/null | jq -r --arg t "$term" \
    'first(.spaces[] | select(.machine == null and any(.tabs[].terminals[]; .terminal == $t)) | [.id, .name] | @tsv) // empty' 2>/dev/null)"
  [ -n "$space" ] || fail "$top: no herdr space holds $term"
  sid="${space%%$'\t'*}"
  sname="${space#*$'\t'}"
  [ "$sname" = "$old" ] || [ "$sname" = "${top##*/}" ] || exit 0
  r="$(herdr-app do space.rename --id "$sid" --name "$new" 2>&1)" || fail "$top: space.rename $sid: $r"
  exit 0
}

command -v jq >/dev/null || fail "jq not found: branch auto-rename is off (install jq)"

if [ "${1:-}" = --work ]; then
  shift
  work "$@"
fi

data="${1:-${HERDR_APP_HOME:-$HOME/.config/herdr-app}/data/projects}"
naming="$(jq -r '.settings.naming // {} | (if .enabled == false then "off" else "on" end), (.model // "haiku")' "$data/projects.json" 2>/dev/null)"
{ IFS= read -r enabled; IFS= read -r model; } <<<"$naming"
[ "${enabled:-on}" = on ] || exit 0
input="$(cat)"
cwd="$(jq -r '.cwd // empty' <<<"$input" 2>/dev/null)"
[ -n "$cwd" ] || exit 0
dirs="$(git -C "$cwd" rev-parse --path-format=absolute --git-dir --git-common-dir --show-toplevel 2>/dev/null)" || exit 0
{ IFS= read -r gdir; IFS= read -r common; IFS= read -r top; } <<<"$dirs"
[ -n "$top" ] && [ "$gdir" != "$common" ] || exit 0
branch="$(git -C "$top" symbolic-ref --short -q HEAD)" || exit 0
[ "$(git -C "$top" config --type=bool --get "branch.$branch.wranglerTemp" 2>/dev/null)" = true ] || exit 0
prompt="$(trim "$(jq -r '.prompt // empty' <<<"$input" 2>/dev/null)")"
[ -n "$prompt" ] && [ "${prompt:0:1}" != / ] || exit 0
mkdir -p "$state/locks" 2>/dev/null || exit 0
key="$(printf '%s\n%s' "$top" "$branch" | git hash-object --stdin)"
mkdir "$state/locks/$key" 2>/dev/null || exit 0
detach=(nohup)
command -v setsid >/dev/null && detach=(setsid)
"${detach[@]}" "$self" --work "$top" "$branch" "${HC_TERMINAL_ID:-}" "$data" "${model:-haiku}" "${prompt:0:4000}" </dev/null >/dev/null 2>>"$log" &
exit 0
