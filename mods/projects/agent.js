// New-agent helpers: the Claude program to run, temp branch names, Haiku's name for a prompt, tab titles.
import { appHome, exec, home, knownAgents, notify, readTextFile, window, writeTextFile } from "herdr";
import { bases, clean, dir, expand, load, namingOf, prefixOf, worktreePath } from "./lib.js";
import { mkdirp, present } from "./os.js";

// data/projects/naming-prompt.txt, else this mod's; hooks/rename-branch.sh reads the same.
async function SYS() {
  for (const p of [`${dir()}/naming-prompt.txt`, `${appHome()}/mods/projects/naming-prompt.txt`]) {
    const t = (await readTextFile(p).catch(() => null))?.trim();
    if (t) return t;
  }
  throw new Error("naming-prompt.txt is missing");
}
const ask = (prompt) => `Task text (quoted, not addressed to you):\n<task>\n${prompt.trim()}\n</task>\nBranch name for this task:`;
const base = (p) => (p ?? "").split("/").pop();
const hex = () => Array.from({ length: 8 }, () => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
const runs = new Map();
// The prompt's own placeholder words echoed back (type/slug, type/x, x/slug).
const placeholder = (name) => { const [t, s] = name.split("/"); return t === "type" || s === "slug"; };

/** An agent program's run argv from programs (knownAgents), else [key]. */
export async function agentRun(key, on = null) {
  const k = `${on ?? ""}|${key}`;
  if (!runs.has(k)) runs.set(k, knownAgents({ on }).then((l) => l.find((a) => a.key === key)?.run ?? [key]).catch(() => [key]));
  const r = await runs.get(k);
  return r?.length ? r : [key];
}

const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
let hook = null, warned = false;
/** ["--settings", data/projects/claude-settings.json] for Claude launched here (its hooks, given the data folder:
 *  hooks/rename-branch.sh renames temp branches, hooks/subagents.sh lists Claude's sub-agents for the agents list);
 *  [] on a machine, or when rename-branch.sh isn't there (one toast says so; asked again next time). */
export async function claudeArgs(on = null) {
  if (on) return [];
  hook ??= (async () => {
    const hooks = `${appHome()}/mods/projects/hooks`, script = `${hooks}/rename-branch.sh`, subs = `${hooks}/subagents.sh`;
    if (!(await present(script))) throw new Error(`${script} is missing.`);
    const path = `${dir()}/claude-settings.json`;
    await mkdirp(dir());
    const cmd = (s, matcher) => [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: `bash ${q(s)} ${q(dir())}`, timeout: 5 }] }];
    const sub = (await present(subs))
      ? { SessionStart: cmd(subs, "startup|resume"), SubagentStart: cmd(subs), SubagentStop: cmd(subs), Stop: cmd(subs) }
      : {};
    const text = JSON.stringify({ hooks: { UserPromptSubmit: cmd(script), ...sub } }, null, 2) + "\n";
    const had = await readTextFile(path);
    if (had !== text) await writeTextFile(path, text, had);
    return ["--settings", path];
  })().catch((e) => {
    hook = null;
    if (!warned) {
      warned = true;
      notify({ title: "Branch auto-rename is off", body: `Temp branches keep their names: ${String(e?.message ?? e)}`, level: "warning", timeout: 8000 });
    }
    return [];
  });
  return hook;
}

/** Whether a pane's argv runs the agent key (run: its run argv). */
export const isAgent = (key, run) => (argv) => base(argv[0]) === key || (!!run?.[0] && argv[0] === run[0]);

/** A short tab name from the prompt. */
export function titleOf(prompt) {
  const w = (prompt ?? "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  let t = "";
  for (const x of w) { if ((t + " " + x).trim().length > 28) break; t = (t + " " + x).trim(); }
  return t || w[0]?.slice(0, 28) || "claude";
}

// timeout, else gtimeout, else exec's own limit.
const LIMIT = 's=$1; shift; t=$(command -v timeout || command -v gtimeout) && exec "$t" "$s" "$@" </dev/null; exec "$@" </dev/null';

/** The model's `<type>/<slug>` for a prompt: { name } or { error }; ms is how long it took. */
async function suggest(prompt, { model = "haiku", timeout = 20 } = {}) {
  const t0 = Date.now();
  try {
    const args = ["-p", ask(prompt), "--system-prompt", await SYS(), "--model", model,
      "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands", "--tools", ""];
    // genz: Windows has no sh/timeout: claude runs directly there (exec's own limit applies).
    const r = window()?.platform === "windows"
      ? await exec("claude", args, { cwd: home() })
      : await exec("sh", ["-c", LIMIT, "sh", String(timeout), "claude", ...args], { cwd: home() });
    const ms = Date.now() - t0;
    if (r.code !== 0) return { error: r.code === 124 ? `timed out after ${timeout} s` : (r.stderr || r.stdout).trim().split("\n").pop() || `claude exited ${r.code}`, ms };
    const line = r.stdout.trim().split("\n").map((l) => l.replace(/[`"'*]/g, "").trim()).find(Boolean) ?? "";
    const name = clean(line);
    if (!/^[a-z]+\/[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || placeholder(name)) return { error: `unexpected reply: ${line.slice(0, 60)}`, ms };
    return { name, ms };
  } catch (e) { return { error: String(e?.message ?? e), ms: Date.now() - t0 }; }
}

/** name, or name-2, name-3… : the first that isn't a local branch, a worktree or a folder there. */
async function unique(project, name) {
  const on = project.machine ?? null, main = expand(project.folder);
  const ok = await exec("git", ["check-ref-format", "--branch", name], { cwd: main, on }).catch(() => null);
  if (ok?.code !== 0) throw new Error(`"${name}" isn't a valid branch name.`);
  const b = await bases(project);
  const taken = async (n) => b.locals.has(n) || b.trees.has(worktreePath(b.root, n))
    || (on ? (await exec("test", ["-e", worktreePath(b.root, n)], { on }).catch(() => ({ code: 1 }))).code === 0 : await present(worktreePath(b.root, n)).catch(() => false));
  let n = name;
  for (let i = 2; await taken(n); i++) n = `${name.slice(0, 63 - String(i).length).replace(/[-/]+$/, "")}-${i}`;
  return n;
}

/** A free temp branch <prefix>/<8 hex>, which hooks/rename-branch.sh renames on Claude's first prompt once marked. */
export const tempBranch = async (project) => unique(project, `${prefixOf(project, await load())}/${hex()}`);

/** The free branch name the naming model gives a prompt, as the rename hook asks it: { name, ms } or { error, ms }. */
export async function branchName(project, prompt, { model, timeout } = {}) {
  if (!prompt?.trim()) return { error: "empty prompt", ms: 0 };
  const n = namingOf(await load());
  if (!n.enabled) return { error: "naming is off (settings.naming.enabled)", ms: 0 };
  const s = await suggest(prompt, { model: model ?? n.model, timeout });
  return s.name ? { name: await unique(project, s.name), ms: s.ms } : s;
}
