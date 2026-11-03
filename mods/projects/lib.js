// Projects: data/projects/projects.json in the app home (Herdr's data folder for this mod), space layouts captured from and applied to it,
// and worktrees made from a project's main checkout.
import { appHome, exec, hc, home, panes, readTextFile, run, shared, spaces, theme, writeTextFile } from "herdr";

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "xonsh", "pwsh", "powershell"]);

export const dir = () => `${appHome()}/data/projects`;
export const file = () => `${dir()}/projects.json`;
export const expand = (p) => (p === "~" || p?.startsWith("~/") ? home() + p.slice(1) : p);
export const tilde = (p) => (p === home() || p.startsWith(home() + "/") ? "~" + p.slice(home().length) : p);
const base = (p) => p.replace(/\/+$/, "").split("/").pop();
const local = (id) => id.replace(/^[^/]*\//, "");

/** Folder holding projects.json's real file (it may be a symlink), else dir(). */
export async function watchDir() {
  const r = await exec("readlink", ["-f", file()]);
  const real = r.code === 0 ? r.stdout.trim() : "";
  return real ? real.replace(/\/[^/]*$/, "") || "/" : dir();
}

// The host's cache, on globalThis (shared by every mod copy, unlike module scope): projects-ui's overlays draw
// from it and watch ver, which goes up on every change. reqs: the state of the overlays' requests (track());
// headed: a bases' refs with "Current HEAD" first, one array per bases object, for the composer.
// text: projects.json as last read or written, known: it parsed.
// mru: agent addresses, most recently focused first (the agent switcher's order).
const cache = (globalThis.__wranglerProjects ??= { known: null, memo: new Map() });
cache.reqs ??= new Map();
cache.headed ??= new WeakMap();
cache.ver ??= 0;
cache.mru ??= [];
const memo = cache.memo;
const bump = () => { cache.ver++; };

export const mru = () => cache.mru;

/** Puts addr first in mru (50 kept); false when it already was. */
export function used(addr) {
  if (!addr || cache.mru[0] === addr) return false;
  cache.mru = [addr, ...cache.mru.filter((x) => x !== addr)].slice(0, 50);
  return true;
}

/** Runs fn(stage) for an overlay's request req: publishes { stage } as it goes, then { done, value } or { error }. */
export async function track(req, fn) {
  const set = (state) => {
    if (!req) return;
    cache.reqs.delete(req);
    cache.reqs.set(req, state);
    while (cache.reqs.size > 50) cache.reqs.delete(cache.reqs.keys().next().value);
    bump();
  };
  set({});
  try {
    const value = await fn((stage) => set({ stage }));
    set({ done: true, value: value ?? null });
    return value;
  } catch (e) {
    set({ error: String(e?.message ?? e) });
    return undefined;
  }
}

/** The last projects.json load() parsed, or null before the first. */
export const knownData = () => cache.known;

/** projects.json's settings (all optional): worktreeRoot, branchPrefix, remote, naming { enabled, model }. */
export const settingsOf = (d = cache.known) => d?.settings ?? {};

/** The project's remote, else settings.remote, else "origin". */
export const remoteOf = (p, d) => p?.remote || settingsOf(d).remote || "origin";

/** A branch name cut to [a-z0-9/-], 64 long. */
export function clean(name) {
  return (name ?? "").toLowerCase().replace(/[^a-z0-9/-]+/g, "-").replace(/-+/g, "-").replace(/\/+/g, "/")
    .split("/").map((x) => x.replace(/^-+|-+$/g, "")).filter(Boolean).join("/").slice(0, 64).replace(/[-/]+$/, "");
}

/** The temp branch prefix: the project's branchPrefix, else settings.branchPrefix, else "wr". */
export const prefixOf = (p, d) => clean(p?.branchPrefix ?? "") || clean(settingsOf(d).branchPrefix ?? "") || "wr";

/** settings.naming with defaults: { enabled: true, model: "haiku" }. */
export function namingOf(d) {
  const n = settingsOf(d).naming ?? {};
  return { enabled: n.enabled !== false, model: n.model || "haiku" };
}

/** The last value cached under key, or undefined. */
export const peek = (key) => memo.get(key)?.v;

// Herdr keeps closed overlays alive, with whatever they hold: an unchanged refresh keeps the old object, so
// they all share one instead of each keeping its own copy.
const same = (a, b) => { const j = (x) => JSON.stringify(x, (_k, y) => (y instanceof Set ? [...y] : y)); return j(a) === j(b); };

/** fn()'s value, cached under key; calls at once share one run. Keeps the old value when fn rejects. */
export function fresh(key, fn) {
  const e = memo.get(key) ?? {};
  if (e.p) return e.p;
  e.p = fn().then((v) => {
    if (e.v !== undefined && same(v, e.v)) v = e.v;
    else bump();
    memo.set(key, { v, at: Date.now() });
    return v;
  }, (err) => { memo.set(key, { v: e.v, at: e.at }); throw err; });
  memo.set(key, e);
  return e.p;
}

/** { version, settings?, projects } from projects.json (empty when absent); the same object while the file is unchanged. */
export async function load() {
  return known(await readTextFile(file()));
}

function known(text) {
  if (text === cache.text && cache.known) return cache.known;
  const d = text ? JSON.parse(text) : {};
  cache.text = text;
  bump();
  return (cache.known = { ...d, version: d.version ?? 1, projects: d.projects ?? [] });
}

/** Reads projects.json, applies fn(data) (mutate or return new) and writes it if the file is still what
 *  was read; reads again on a concurrent write (3 tries). */
export async function update(fn) {
  await exec("mkdir", ["-p", dir()]);
  for (let i = 0; ; i++) {
    const was = await readTextFile(file());
    const d = JSON.parse(JSON.stringify(known(was)));
    const next = fn(d) ?? d;
    const text = JSON.stringify(next, null, 2) + "\n";
    try { await writeTextFile(file(), text, was); } catch (e) { if (i < 2) continue; throw e; }
    known(text);
    return next;
  }
}

export async function git(cwd, args, on) {
  try {
    const r = await exec("git", args, { cwd, on });
    return r.code === 0 ? r.stdout.trim() : null;
  } catch { return null; }
}

/** A project id from name that isn't in taken. */
export function freeId(name, taken) {
  let id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  for (let n = 2; taken.includes(id); n++) id = `${id.replace(/-\d+$/, "")}-${n}`;
  return id;
}

/** A new project entry for a folder (absolute or ~): name, defaultBase from <remote>/HEAD. */
export async function make(folder, machine = null, taken = []) {
  const abs = expand(folder);
  const name = base(abs);
  const r = remoteOf(null, cache.known);
  const head = await git(abs, ["rev-parse", "--abbrev-ref", `${r}/HEAD`], machine);
  return { id: freeId(name, taken), name, folder: tilde(abs), machine, defaultBase: head && head !== `${r}/HEAD` ? head : `${r}/main`, layout: null };
}

/** Where a space is now: its first terminal's live folder, else where it was made. */
export function place(s, ps = panes()) {
  const tabs = new Set((s.tabs ?? []).map((t) => t.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

const inside = (p, root) => !!p && (p === root || p.startsWith(root + "/"));

/** Spaces that look like they're in the project's folder (no git asked). */
export function near(project, sp = spaces(), ps = panes()) {
  const root = expand(project.folder);
  return sp.filter((s) => (s.machine ?? null) === (project.machine ?? null) && inside(place(s, ps), root));
}

/** The open space shown for a project: one at its folder, else one inside it (no git asked). */
export function shownSpace(project, sp = spaces(), ps = panes()) {
  const root = expand(project.folder);
  const all = near(project, sp, ps);
  return all.find((s) => place(s, ps) === root) ?? all[0] ?? null;
}

// Avatar colors as the spaces sidebar draws its shared("space.colors") names.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

/** A project's color: its open space's avatar color, else one by its position in ids. */
export function hue(p, ids) {
  const s = shownSpace(p);
  const c = s && shared("space.colors")?.[s.id];
  if (c) return c.startsWith("#") ? c : (MARK[c] ?? theme()[c]);
  const all = Object.values(MARK);
  return all[Math.max(0, ids.indexOf(p.id)) % all.length];
}

/** A space's checkout and the project it belongs to (the saved one whose folder is the repo's main
 *  checkout, else an unsaved one made for it): { project, saved, src, branch }, or null outside git. */
export async function owner(s) {
  const [co, d] = await Promise.all([checkout(place(s), s.machine), load()]);
  return ownerOf(co, s.machine, d);
}

/** owner() from the caches alone: undefined when the space's checkout isn't cached yet. */
export function ownerNow(s) {
  const co = peekCheckout(place(s), s.machine);
  return co === undefined || !cache.known ? undefined : ownerOf(co, s.machine, cache.known);
}

function ownerOf(co, machine, d) {
  if (!co) return null;
  const on = machine ?? null;
  const saved = d.projects.find((x) => (x.machine ?? null) === on && expand(x.folder) === co.main);
  return { project: saved ?? draft(co.main, on, d.projects.map((x) => x.id)), saved: !!saved, src: co.top, branch: co.branch };
}

/** make() without asking git: defaultBase stays null (the worktree dialogs fall back to <remote>/HEAD). */
function draft(folder, machine, taken) {
  const name = base(folder);
  return { id: freeId(name, taken), name, folder: tilde(folder), machine, defaultBase: null, layout: null };
}

const coKey = (cwd, on) => `co|${on ?? ""}|${cwd}`;

/** A folder's checkout in one git call: { top, main (the repo's main checkout), linked, branch (null when detached) }, or null outside git. */
export function checkout(cwd, on = null) {
  return fresh(coKey(cwd, on), async () => {
    const r = await git(cwd, ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir", "--abbrev-ref", "HEAD"], on);
    const [top, common, head] = r?.split("\n") ?? [];
    if (!top || !common) return null;
    const main = common.replace(/\/\.git\/?$/, "");
    return { top, main, linked: top !== main, branch: head && head !== "HEAD" ? head : null };
  });
}

/** checkout() as last cached: undefined when not yet asked. */
export const peekCheckout = (cwd, on = null) => peek(coKey(cwd, on));

/** ms since checkout() last finished for this folder (Infinity when never). */
export const checkoutAge = (cwd, on = null) => Date.now() - (memo.get(coKey(cwd, on))?.at ?? -Infinity);

/** Every folder checkout() has cached: [cwd, machine]. */
export const checkedOut = () => [...memo.keys()].filter((k) => k.startsWith("co|"))
  .map((k) => { const [, on, ...cwd] = k.split("|"); return [cwd.join("|"), on || null]; });

/** The space whose repo is the project's folder (its main checkout), or null. */
export async function spaceFor(project) {
  const root = expand(project.folder);
  const all = near(project).sort((a, b) => (place(b) === root) - (place(a) === root));
  for (const s of all) if ((await git(place(s), ["rev-parse", "--show-toplevel"], s.machine)) === root) return s;
  return null;
}

async function doc(on) {
  const req = '{"jsonrpc":"2.0","id":1,"method":"doc.get","params":{"name":"herdr-app"}}';
  const r = await exec("sh", ["-c", `printf '%s\\n' '${req}' | hc connect`], { on });
  return JSON.parse(r.stdout).result.value;
}

async function info(address) {
  try {
    const r = await hc(["get", address, "--json"]);
    return r.code === 0 ? JSON.parse(r.stdout) : null;
  } catch { return null; }
}

function rel(root, cwd) {
  if (!cwd || !root || !inside(cwd, root)) return ".";
  return cwd === root ? "." : cwd.slice(root.length + 1);
}

async function leaf(content, ps, root) {
  if (content?.mod) return { pane: { mod: content.mod, props: content.props ?? {} } };
  if (!content?.terminal) return null;
  const p = ps.find((x) => local(x.terminal ?? "") === content.terminal);
  const d = await info(p?.terminal ?? content.terminal);
  const fg = d?.foreground ?? (d ? { argv: d.argv, cwd: d.cwd } : null);
  const name = base(fg?.name ?? fg?.argv?.[0] ?? "");
  const shell = p?.program?.shell || !fg?.argv?.length || SHELLS.has(name.replace(/^-/, ""));
  return { pane: { argv: shell ? null : fg.argv, cwd: rel(root, fg?.cwd ?? d?.cwd ?? p?.cwd) } };
}

async function tree(n, ps, root) {
  const w = n.size?.weight != null ? { weight: Math.round(n.size.weight * 1000) / 1000 } : {};
  if (n.type === "block") {
    const l = await leaf(n.content, ps, root);
    return l && { ...l, ...w };
  }
  const kids = [];
  for (const c of n.children ?? []) {
    const k = await tree(c, ps, root);
    if (k) kids.push(k);
  }
  if (!kids.length) return null;
  if (kids.length === 1) return { ...kids[0], ...w };
  return { split: n.type === "column" ? "column" : "row", children: kids, ...w };
}

/** A space's tabs, splits and programs: { layout: {tabs}, flat } (flat: splits couldn't be read).
 *  cwds are relative to `root` (default: the space's repo, else its folder). */
export async function capture(spaceId, root) {
  const s = spaces().find((x) => x.id === spaceId);
  if (!s) throw new Error("no such space");
  const ps = panes();
  root = root ? expand(root) : (await git(place(s, ps), ["rev-parse", "--show-toplevel"], s.machine)) ?? place(s, ps);
  const name = (t) => (t?.named ? t.name : null);
  try {
    const d = await doc(s.machine);
    const live = d.spaces.find((x) => x.id === local(s.id));
    const tabs = [];
    for (const t of live.tabs) {
      const r = await tree(t.root, ps, root);
      if (r) tabs.push({ name: t.name || null, root: (({ weight, ...x }) => x)(r) });
    }
    if (tabs.length) return { layout: { tabs }, flat: false };
  } catch {}
  const tabs = [];
  for (const t of s.tabs) {
    const kids = [];
    for (const p of ps.filter((x) => x.tab === t.id)) {
      const l = await leaf(p.terminal ? { terminal: local(p.terminal) } : null, ps, root);
      if (l) kids.push(l);
    }
    if (kids.length) tabs.push({ name: name(t), root: kids.length === 1 ? kids[0] : { split: "row", children: kids } });
  }
  return { layout: { tabs }, flat: true };
}

export async function until(fn, tries = 60) {
  for (let i = 0; i < tries; i++) {
    const v = fn();
    if (v) return v;
    await exec("sleep", ["0.05"]);
  }
  return null;
}

const first = (n) => (n.split ? first(n.children[0]) : n.pane);
const leaves = (n) => (n.split ? n.children.flatMap(leaves) : [n.pane]);

// Fixed script: the program and its arguments (task included, appended by Herdr) stay "$@", never shell text.
const LOGIN = `exec "\${SHELL:-/bin/sh}" -lic 'exec "$@"' sh "$@"`;
/** On another machine, argv through its user's login shell (its profile's PATH: ~/.local/bin and the like). */
export const viaLogin = (argv, on) => (on && argv?.length ? ["sh", "-c", LOGIN, "sh", ...argv] : argv);

/** The layout's first terminal pane whose argv matches, or null. */
export function leafFor(layout, match) {
  for (const t of layout?.tabs ?? []) for (const p of leaves(t.root)) if (p.argv?.length && match(p.argv)) return p;
  return null;
}
const abs = (root, cwd) => (!cwd || cwd === "." ? root : cwd.startsWith("/") ? cwd : `${root}/${cwd}`);
const tabPanes = (tab) => panes().filter((p) => p.tab === tab).map((p) => p.pane);

async function split(tab, from, direction, p, root) {
  const had = new Set(tabPanes(tab));
  if (p.mod) run("pane.split", { direction, pane: from, mod: p.mod, props: p.props ?? {} });
  else {
    run("pane.focus", { pane: from });
    run("terminal.open", { place: direction, folder: abs(root, p.cwd), ...(p.argv ? { argv: p.argv } : {}) });
  }
  return until(() => tabPanes(tab).find((x) => !had.has(x)));
}

async function build(tab, node, pane, root) {
  if (!node.split || !pane) return;
  const dir = node.split === "row" ? "right" : "down";
  const at = [pane];
  for (const k of node.children.slice(1)) at.push(await split(tab, at[at.length - 1], dir, first(k), root));
  for (let i = 0; i < node.children.length; i++) await build(tab, node.children[i], at[i], root);
}

function sizes(saved, live) {
  if (!saved?.split || !live?.children) return;
  while (live.children.length === 1 && live.children[0].type !== "block") live = live.children[0];
  const kids = saved.children;
  if (live.type !== saved.split || live.children.length !== kids.length) return;
  kids.forEach((k, i) => {
    run("layout.resize", { id: live.children[i].id, weight: k.weight > 0 ? k.weight : 1 });
    sizes(k, live.children[i]);
  });
}

async function resize(space, built) {
  const s = spaces().find((x) => x.id === space);
  try {
    const d = await doc(s?.machine ?? null);
    const live = d.spaces.find((x) => x.id === local(space));
    for (const { tab, root } of built) sizes(root, live?.tabs.find((t) => t.id === local(tab))?.root);
  } catch {}
}

// Worktrees: <worktreeRoot, default ~/.herdr/worktrees>/<repo>/<branch, slashes as dashes>, as the worktree mod makes them.

const slug = (branch) => branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

export async function gitr(cwd, args, on) {
  const r = await exec("git", args, { cwd, on });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
}

async function homeOf(on) {
  if (!on) return home();
  const r = await exec("sh", ["-c", 'printf %s "$HOME"'], { on });
  if (r.code !== 0 || !r.stdout.trim()) throw new Error(`Couldn't find the home folder on ${on}.`);
  return r.stdout.trim();
}

const basesKey = (project, src) => `bases|${project.machine ?? ""}|${expand(project.folder)}|${src ?? ""}`;

/** What the new-worktree dialog offers: { root (worktrees folder), head: {branch, sha} (of src, default
 *  the main checkout), remote, refs: [{name, at}] (<remote>/*, newest first), origin (<remote>/HEAD's branch, or null),
 *  locals: Set of branches, trees: Set of checkout paths, prefix (temp branches') }. Cached: see peekBases. */
export function bases(project, src) {
  return fresh(basesKey(project, src), async () => {
    const on = project.machine ?? null, main = expand(project.folder), at = src ?? main;
    const d = await load().catch(() => cache.known), r = remoteOf(project, d);
    const [h, branch, sha, origin, refs, locals, trees] = await Promise.all([
      homeOf(on),
      gitr(at, ["rev-parse", "--abbrev-ref", "HEAD"], on),
      gitr(at, ["rev-parse", "--short", "HEAD"], on),
      gitr(main, ["rev-parse", "--abbrev-ref", `${r}/HEAD`], on),
      gitr(main, ["for-each-ref", `refs/remotes/${r}`, "--sort=-committerdate", "--format=%(refname)%09%(committerdate:unix)"], on),
      gitr(main, ["for-each-ref", "refs/heads", "--format=%(refname:short)"], on),
      gitr(main, ["worktree", "list", "--porcelain"], on),
    ]);
    if (!sha.ok) throw new Error(sha.err || `${project.folder} is not a git repository.`);
    const wt = (project.worktreeRoot || settingsOf(d).worktreeRoot || "~/.herdr/worktrees").replace(/\/+$/, "");
    return {
      root: `${wt === "~" || wt.startsWith("~/") ? h + wt.slice(1) : wt}/${base(main)}`,
      head: { branch: branch.out === "HEAD" ? null : branch.out, sha: sha.out },
      remote: r,
      origin: origin.ok && origin.out !== `${r}/HEAD` ? origin.out : null,
      refs: refs.out.split("\n").filter(Boolean).map((l) => l.split("\t"))
        .map(([x, at]) => ({ name: x.replace(/^refs\/remotes\//, ""), at: Number(at) || 0 }))
        .filter((x) => x.name !== `${r}/HEAD`),
      locals: new Set(locals.out.split("\n").filter(Boolean)),
      trees: new Set(trees.out.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9))),
      prefix: prefixOf(project, d),
    };
  });
}

/** bases() as last cached: undefined when not yet asked. */
export const peekBases = (project, src) => peek(basesKey(project, src));

/** ms since bases() last finished for this project and src (Infinity when never). */
export const basesAge = (project, src) => Date.now() - (memo.get(basesKey(project, src))?.at ?? -Infinity);

export const worktreePath = (root, branch) => `${root}/${slug(branch.trim())}`;

// One branch from the remote. Past exec's 30 s limit, again in a hidden hc terminal (up to 5 min).
async function fetchRef(cwd, remote, ref, on) {
  const args = ["fetch", "--quiet", remote, ref];
  const t0 = Date.now();
  let r = null;
  try { r = await gitr(cwd, args, on); } catch (e) { if (Date.now() - t0 < 29000) throw e; }
  if (r?.ok) return;
  if (r && Date.now() - t0 < 29000) throw new Error(r.err || `git fetch ${remote} ${ref} failed.`);
  const s = await hc(["run", "--bg", "--json", "--no-parent", "--no-notify", "--cwd", cwd, ...(on ? ["--on", on] : []), "--", "git", ...args]);
  const t = s.code === 0 ? JSON.parse(s.stdout).address : null;
  if (!t) throw new Error(`Couldn't start git fetch: ${(s.stderr || s.stdout).trim()}`);
  for (let i = 0; i < 600; i++) {
    await exec("sleep", ["0.5"]);
    const g = await info(t);
    if (g?.state !== "finished") continue;
    const out = g.exit_code ? (await hc(["read", t])).stdout.trim() : "";
    await hc(["rm", t]);
    if (g.exit_code) throw new Error(out || `git fetch ${remote} ${ref} exited ${g.exit_code}.`);
    return;
  }
  await hc(["kill", t]);
  throw new Error(`git fetch ${remote} ${ref} took over 5 minutes.`);
}

/** Makes the project's worktree for branch from base ("HEAD" or "<remote>/<x>", fetched first); HEAD is src's
 *  (a checkout of the repo), default the main checkout's. A branch that exists is checked out, a checkout
 *  that exists is reused. stage(text) reports progress.
 *  Resolves { path, existed: "worktree" | "branch" | null }; rejects with git's message. */
export async function worktree(project, branch, from, stage = () => {}, src = null) {
  const on = project.machine ?? null, main = expand(project.folder);
  branch = branch.trim();
  if (!branch) throw new Error("Type a branch name.");
  if (!(await gitr(main, ["check-ref-format", "--branch", branch], on)).ok) throw new Error(`"${branch}" isn't a valid branch name.`);
  const b = await bases(project, src);
  const path = worktreePath(b.root, branch);
  if (b.trees.has(path)) return { path, existed: "worktree" };
  const has = b.locals.has(branch), remote = b.remote ?? remoteOf(project);
  if (!has && from !== "HEAD") {
    if (!from?.startsWith(`${remote}/`)) throw new Error(`Base must be HEAD or ${remote}/<branch>, not "${from}".`);
    stage(`Fetching ${from}…`);
    await fetchRef(main, remote, from.slice(remote.length + 1), on);
  }
  let start = from;
  if (from === "HEAD" && src && !has) {
    const h = await gitr(src, ["rev-parse", "HEAD"], on);
    if (!h.ok) throw new Error(h.err || `Couldn't read HEAD in ${tilde(src)}.`);
    start = h.out;
  }
  stage("Creating worktree…");
  const r = await gitr(main, has ? ["worktree", "add", path, branch] : ["worktree", "add", "--no-track", "-b", branch, path, start], on);
  if (!r.ok) throw new Error(r.err || "git worktree add failed.");
  return { path, existed: has ? "branch" : null };
}

/** Opens a new unnamed space at the project folder with the layout's tabs, splits and programs
 *  (a single shell tab when layout is null). With `agent` (an argv matcher) and `task`, the first
 *  matching pane gets task as its first message (its argv's last argument when it's a split); every
 *  matching pane gets `args` after its program. Resolves with { space, tasked } (tasked: a matching pane was made) or null. */
export async function apply({ folder, machine = null, layout, agent = null, task = "", args = [] }) {
  const root = expand(folder);
  const tabs = layout?.tabs?.length ? JSON.parse(JSON.stringify(layout.tabs)) : [{ name: null, root: { pane: { argv: null, cwd: "." } } }];
  const target = agent ? leafFor({ tabs }, agent) : null;
  if (agent && args.length) for (const t of tabs) for (const p of leaves(t.root)) if (p.argv?.length && agent(p.argv)) p.argv = [p.argv[0], ...args, ...p.argv.slice(1)];
  if (target && task && !tabs.some((t) => first(t.root) === target)) target.argv = [...target.argv, task];
  if (machine) for (const t of tabs) for (const p of leaves(t.root)) if (p.argv?.length) p.argv = viaLogin(p.argv, machine);
  const said = (p) => (p === target && task ? { task } : {});
  const had = new Set(spaces().map((s) => s.id));
  const lead = first(tabs[0].root);
  const placeholder = !!lead.mod;
  run("space.new", {
    folder: abs(root, placeholder ? "." : lead.cwd),
    ...(machine ? { machine } : {}),
    ...(!placeholder && tabs[0].name ? { tab: tabs[0].name } : {}),
    ...(!placeholder && lead.argv ? { argv: lead.argv, ...said(lead) } : {}),
  });
  const s = await until(() => spaces().find((x) => !had.has(x.id) && x.tabs.length));
  if (!s) return null;
  const space = s.id;
  const built = [];
  const open = async (t, tab) => {
    const pane = await until(() => tabPanes(tab)[0]);
    await build(tab, t.root, pane, root);
    built.push({ tab, root: t.root });
  };
  const spare = s.tabs[0].id;
  if (!placeholder) await open(tabs[0], spare);
  for (const t of placeholder ? tabs : tabs.slice(1)) {
    const known = new Set(spaces().find((x) => x.id === space).tabs.map((x) => x.id));
    const p = first(t.root);
    run("tab.new", {
      space,
      ...(t.name ? { name: t.name } : {}),
      ...(p.mod ? { mod: p.mod, props: p.props ?? {} } : { folder: abs(root, p.cwd), ...(p.argv ? { argv: p.argv, ...said(p) } : {}) }),
    });
    const tab = await until(() => spaces().find((x) => x.id === space)?.tabs.find((x) => !known.has(x.id))?.id);
    if (tab) await open(t, tab);
  }
  if (placeholder) run("tab.close", { id: spare, confirmed: true });
  await resize(space, built);
  const lead1 = built[0]?.tab;
  if (lead1) run("tab.select", { id: lead1 });
  return { space, tasked: !!target };
}
