// Projects: saved folders that open as spaces with their saved layout, worktrees, and the agent composer.
// This mod is the host: a 0 px block in the layout that takes the commands below and draws nothing. Its
// overlays (menus, picker, dialogs) live in projects-ui, which only draws: it reads the cache in lib.js and
// asks for work with commands (requests with a req id report through track()). Data: data/projects/projects.json.
// Commands (keys.json, `herdr-app do`, the overlays): projects.pick, projects.save[:id], projects.add[:folder],
// projects.add-folder, projects.add-space:spaceId, projects.open:id, projects.open-new:id, projects.clear:id,
// projects.remove:id, projects.menu:id, projects.new-menu, projects.space-menu:spaceId[|linked|main|plain]
// (no kind: picked from its checkout), projects.row-menu:spaceId (the same), projects.worktree[:id[|remote|head[|branch]]] (the dialog; no id: the focused space's repo),
// projects.wt-create:id|branch[|base] (no dialog; base HEAD or <remote>/<x>, default the project's defaultBase),
// projects.wt-from:spaceId[|branch[|base]] (from that checkout: the dialog in HEAD mode, or at once),
// projects.compose[:id[|where[|pick]]] (the "New agent" dialog), projects.agent-start:<json> (what it does, no dialog:
// {id, where: "local" | "worktree", base?, branch?, agent: a programs agent key ("claude", "codex", …) or "none", prompt?}),
// projects.branch-name:id|prompt[|model[|timeout]] (toasts the name the rename hook would give a prompt),
// projects.agent-menu:terminal, projects.agent-copy:terminal|branch|path, projects.agent-delete:terminal (the dialog),
// projects.wt-delete:terminal[|force] (no dialog; refuses uncommitted changes without force),
// projects.switch (the agent switcher), projects.switch-last (to the previously focused agent, no UI), projects.peek:terminal / peek-go / peek-close,
// projects.refresh[:folder] (rereads cached checkouts in folder, e.g. after hooks/rename-branch.sh renames a branch).
// Requests from projects-ui: bases:<json {project, src, req}>, wt-run:<json {project, branch, from, src, req}>,
// agent-run:<json agent-start's fields + req>, agent-info:terminal|req, wt-delete-run:terminal|force|req.

import { View, div } from "gpui-kit";
import { agents, closeOverlay, exec, focused, nextCommand, notify, openOverlay, panes, pickFolder, run, spaces, watchFolder } from "herdr";
import { apply, bases, basesAge, capture, checkedOut, checkout, checkoutAge, knownData, mru, ownerNow, peekBases, peekCheckout, dir, expand, freeId, git, gitr, load, make, owner, place, spaceFor, tilde, track, until, update, used, viaLogin, watchDir, worktree } from "./lib.js";
import { agentRun, branchName, claudeArgs, isAgent, tempBranch, titleOf } from "./agent.js";

const busy = new Set();

function summary(p) {
  const tabs = p.layout?.tabs ?? [];
  if (!tabs.length) return "";
  const count = (n) => (n.split ? n.children.reduce((a, c) => a + count(c), 0) : 1);
  const n = tabs.reduce((a, t) => a + count(t.root), 0);
  return tabs.length > 1 ? `${tabs.length} tabs` : n > 1 ? `${n} panes` : "1 pane";
}

const toast = (title, body, level = "info") => notify({ title, ...(body ? { body } : {}), level, timeout: 4000 });

async function open(p, fresh = false) {
  if (busy.has(p.id)) return;
  busy.add(p.id);
  try {
    const s = fresh ? null : await spaceFor(p);
    if (s) run("space.select", { id: s.id });
    else if (!(await apply({ folder: p.folder, machine: p.machine ?? null, layout: p.layout }))) toast(`Couldn't open ${p.name}`, "The space didn't appear in time.", "error");
  } catch (e) {
    toast(`Couldn't open ${p.name}`, String(e?.message ?? e), "error");
  } finally {
    busy.delete(p.id);
  }
}

async function saveTo(id, spaceId) {
  const s = spaces().find((x) => x.id === spaceId);
  if (!s) return toast("No space to save", null, "warning");
  try {
    const d = await load();
    const p = d.projects.find((x) => x.id === id);
    if (!p) return;
    const { layout: l, flat } = await capture(s.id, p.folder);
    await update((d) => { const q = d.projects.find((x) => x.id === id); if (q) q.layout = l; });
    toast(`Saved layout to ${p.name}`, flat ? "Splits couldn't be read: saved each tab's panes side by side." : summary({ layout: l }), flat ? "warning" : "success");
  } catch (e) {
    toast("Couldn't save the layout", String(e?.message ?? e), "error");
  }
}

async function repoOf(s) {
  return (await git(place(s), ["rev-parse", "--show-toplevel"], s.machine)) ?? null;
}

/** The saved project whose folder is this space's repo (or folder), or null. */
async function projectOf(s) {
  if (!s) return null;
  const [co, d] = await Promise.all([checkout(place(s), s.machine), load()]);
  return savedAt(s, co, d);
}

const savedAt = (s, co, d) => d.projects.find((x) => (x.machine ?? null) === (s.machine ?? null) && expand(x.folder) === (co?.top ?? place(s))) ?? null;

async function saveFocused() {
  const s = spaces().find((x) => x.id === focused()?.space);
  if (!s) return;
  const p = await projectOf(s);
  if (!p) return toast("Not a project", `${s.name} isn't in a saved project's folder.`, "warning");
  await saveTo(p.id, s.id);
}

/** Adds the folder as a project; resolves with its id (also when it already was one), else null. */
async function add(folder, machine) {
  if (!folder) return null;
  try {
    const same = (x) => expand(x.folder) === expand(folder) && (x.machine ?? null) === (machine ?? null);
    const p = await make(folder, machine);
    let dup = null;
    await update((d) => { if ((dup = d.projects.find(same) ?? null)) return; p.id = freeId(p.name, d.projects.map((x) => x.id)); d.projects.push(p); });
    toast(dup ? "Already a project" : `Added ${p.name}`, p.folder, dup ? "info" : "success");
    return dup?.id ?? p.id;
  } catch (e) {
    toast("Couldn't add the project", String(e?.message ?? e), "error");
    return null;
  }
}

const addFolder = async () => add(await pickFolder({ prompt: "Add project" }), null);

async function addCurrent() {
  const s = spaces().find((x) => x.id === focused()?.space);
  return s ? add((await repoOf(s)) ?? place(s), s.machine ?? null) : null;
}

async function edit(id, fn) {
  try { await update((d) => fn(d, d.projects.find((x) => x.id === id))); } catch (e) { toast("Couldn't change projects.json", String(e?.message ?? e), "error"); }
}

/** The new-worktree dialog. src: the checkout whose HEAD "Current HEAD" means; an unsaved project goes whole. */
function worktreeDialog(p, mode, branch, src, saved = true) {
  openOverlay({ mod: "projects-ui", kind: "dialog", width: 520, props: { view: "worktree", id: p.id, ...(saved ? {} : { project: p }), ...(src ? { src } : {}), ...(mode ? { mode } : {}), ...(branch ? { branch } : {}) } });
}

/** Makes (or reuses) the worktree and shows it: its space if one is open, else a new space with the layout. */
async function openWorktree(p, branch, from, stage = () => {}, src = null) {
  const r = await worktree(p, branch, from, stage, src);
  bases(p).catch(() => null);
  const s = r.existed === "worktree" ? await spaceFor({ folder: r.path, machine: p.machine ?? null }) : null;
  if (s) run("space.select", { id: s.id });
  else {
    stage("Opening space…");
    if (!(await apply({ folder: r.path, machine: p.machine ?? null, layout: p.layout }))) throw new Error("The space didn't appear in time.");
  }
  return r;
}

async function wtCreate(p, branch, from, src = null) {
  try {
    const r = await openWorktree(p, branch ?? "", from || p.defaultBase || "HEAD", () => {}, src);
    toast(r.existed === "worktree" ? "Opened worktree" : `Created ${branch}`, tilde(r.path), "success");
  } catch (e) {
    toast(`Couldn't make worktree ${branch ?? ""}`, String(e?.message ?? e), "error");
  }
}

async function wtFrom(spaceId, branch, from, mode = "head") {
  const s = spaces().find((x) => x.id === spaceId);
  const o = s && (await owner(s));
  if (!o) return toast("Not a git checkout", s?.name ?? spaceId, "warning");
  if (branch) await wtCreate(o.project, branch, from || "HEAD", o.src);
  else worktreeDialog(o.project, mode, null, o.src, o.saved);
}

/** Starts what the composer says: o = {project, where, base, branch, agent, prompt?}. The local project's space
 *  (opened if needed) or a new worktree's (a marked temp branch when empty), with Claude in a new tab or, in a space
 *  it opens, the layout's first Claude pane (its only tab without a layout); prompt, if any, is its first message. Resolves { space, folder, branch, tab }. */
async function launch(o, stage = () => {}) {
  const p = o.project, machine = p.machine ?? null, prompt = (o.prompt ?? "").trim();
  const key = o.agent && o.agent !== "none" ? o.agent : null;
  const cmd = key ? await agentRun(key, machine) : null;
  const extra = key === "claude" ? await claudeArgs(machine) : [];
  let folder = expand(p.folder), branch = null, s = null;
  if (o.where === "worktree") {
    const temp = !(o.branch ?? "").trim();
    branch = temp ? await tempBranch(p) : o.branch.trim();
    const r = await worktree(p, branch, o.base || p.defaultBase || "HEAD", stage);
    // hooks/rename-branch.sh only renames branches carrying this.
    if (temp && !r.existed) await gitr(expand(p.folder), ["config", `branch.${branch}.wranglerTemp`, "true"], machine);
    bases(p).catch(() => null);
    folder = r.path;
    s = r.existed === "worktree" ? await spaceFor({ folder, machine }) : null;
  } else s = await spaceFor(p);
  let space = s?.id, tasked = false;
  if (s) run("space.select", { id: s.id });
  else {
    stage("Opening space…");
    const only = cmd && !p.layout?.tabs?.length ? { tabs: [{ name: prompt ? titleOf(prompt) : key, root: { pane: { argv: cmd, cwd: "." } } }] } : null;
    const a = await apply({ folder, machine, layout: only ?? p.layout, ...(cmd ? { agent: isAgent(key, cmd), task: prompt, args: extra } : {}) });
    if (!a) throw new Error("The space didn't appear in time.");
    ({ space, tasked } = a);
  }
  let tab = null;
  if (cmd && !tasked) {
    stage(`Starting ${key}…`);
    const known = new Set(spaces().find((x) => x.id === space)?.tabs.map((x) => x.id) ?? []);
    run("tab.new", { space, folder, name: prompt ? titleOf(prompt) : key, argv: viaLogin([...cmd, ...extra], machine), ...(prompt ? { task: prompt } : {}) });
    tab = await until(() => spaces().find((x) => x.id === space)?.tabs.find((x) => !known.has(x.id))?.id);
    if (!tab) throw new Error(`The ${key} tab didn't appear in time.`);
    run("tab.select", { id: tab });
  }
  return { space, folder, branch, tab };
}

/** The composer, preselecting id, else the focused space's saved project. */
async function compose(id, where, pick) {
  if (!id) {
    const s = spaces().find((x) => x.id === focused()?.space);
    const now = s && ownerNow(s), o = now === undefined && s ? await owner(s).catch(() => null) : now;
    id = o?.saved ? o.project.id : null;
  }
  openOverlay({ mod: "projects-ui", kind: "dialog", width: 560, props: { view: "compose", ...(id ? { id } : {}), ...(where ? { where } : {}), ...(pick ? { pick: true } : {}) } });
}

async function agentStart(json) {
  try {
    const o = JSON.parse(json);
    const project = (await load()).projects.find((x) => x.id === o.id);
    if (!project) throw new Error(`No project ${o.id}.`);
    const r = await launch({ ...o, project });
    toast(r.branch ? `Started ${r.branch}` : `Started in ${project.name}`, tilde(r.folder), "success");
  } catch (e) {
    toast("Couldn't start the agent", String(e?.message ?? e), "error");
  }
}

async function nameTest(p, prompt, model, timeout) {
  try {
    const t0 = Date.now();
    const r = await branchName(p, prompt ?? "", { ...(model ? { model } : {}), ...(timeout ? { timeout: Number(timeout) } : {}) });
    notify({ title: r.name ?? "No name: the temp branch stays", body: `${Date.now() - t0} ms${r.error ? ` · ${r.error}` : ""}`, level: r.name ? "success" : "warning", timeout: 20000 });
  } catch (e) {
    toast("Couldn't name a branch", String(e?.message ?? e), "error");
  }
}

/** Where the click that asked for a popup was (a command's "@x,y" suffix), taken once by the popup it opens:
 *  the pointer Herdr knows by the time an async command opens one can be stale. */
let clickAt = null;
const atClick = () => { const a = clickAt; clickAt = null; return a ? { at: a } : {}; };

/** The open peek ({ terminal, overlay }), while its bar is alive (it beats every 100 ms). */
const peekOpen = () => { const p = globalThis.__wranglerPeek; return p && Date.now() - p.at < 600 ? p : null; };

/** Peeks at a terminal over the window: projects-ui's bar on top (who, state, go to, close), the terminal under it. */
function peek(terminal) {
  const p = peekOpen();
  if (p) closeOverlay(p.overlay);
  openOverlay({ kind: "dialog", width: 0.86, height: 0.84, layout: { id: "peek", type: "column", children: [
    { id: "peek-bar", type: "block", content: { mod: "projects-ui", props: { view: "peek", terminal } }, size: { px: 46 } },
    { id: "peek-term", type: "block", content: { terminal } },
  ] } });
}

/** From the peek to the terminal: its pane, or (a sub-agent without one) a tab of the shown space. */
function peekGo() {
  const p = peekOpen();
  if (!p) return;
  closeOverlay(p.overlay);
  run(panes().some((x) => x.terminal === p.terminal) ? "pane.focus" : "terminal.keep", { terminal: p.terminal });
}

/** A space's right-click popup; kind "main" (the repo's own checkout), "linked" (another worktree) or "plain" (no git). */
function spaceMenu(id, kind = "linked") {
  openOverlay({ mod: "projects-ui", kind: "popup", width: 340, height: 260, ...atClick(), props: { view: "space-menu", space: id, ...(kind === "linked" ? {} : { [kind]: true }) } });
  refreshSpace(id);
}

/** Rereads a space's checkout (and projects.json) for the overlays showing it. */
function refreshSpace(id) {
  const s = spaces().find((x) => x.id === id);
  if (s) checkout(place(s), s.machine).catch(() => null);
  load().catch(() => null);
}

async function rowMenu(id) {
  const s = spaces().find((x) => x.id === id);
  if (!s) return;
  const hit = peekCheckout(place(s), s.machine), co = hit === undefined ? await checkout(place(s), s.machine) : hit;
  spaceMenu(id, !co ? "plain" : co.linked ? "linked" : "main");
}

/** Adds the space's folder as a project: its repo's main checkout, else the folder itself. */
async function addSpace(id) {
  const s = spaces().find((x) => x.id === id);
  if (!s) return null;
  const o = await owner(s);
  return add(o ? expand(o.project.folder) : place(s), s.machine ?? null);
}

const inside = (p, root) => !!p && (p === root || p.startsWith(root + "/"));

/** An agent terminal's folder and checkout: { addr, on, cwd, top, main, linked, branch }; top null outside git,
 *  main the repo's main checkout, linked: top is another of its worktrees. Null without a pane. */
async function agentAt(addr, cached = false) {
  const p = panes().find((x) => x.terminal === addr);
  if (!p?.cwd) return null;
  const on = spaces().find((s) => s.tabs.some((t) => t.id === p.tab))?.machine ?? null;
  const hit = cached ? peekCheckout(p.cwd, on) : undefined, co = hit === undefined ? await checkout(p.cwd, on) : hit;
  return { addr, on, cwd: p.cwd, top: co?.top ?? null, main: co?.main ?? null, linked: !!co?.linked, branch: co?.branch ?? null };
}

/** Uncommitted changes in a's checkout: a count, or null when git fails. */
async function changes(a) {
  const r = await git(a.top, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], a.on);
  return r == null ? null : r.split("\n").filter(Boolean).length;
}

async function agentMenu(addr) {
  const a = await agentAt(addr, true);
  agentAt(addr).catch(() => null);
  if (!a) return toast("No folder for this agent", addr, "warning");
  const height = 44 + 33 * (a.branch ? 2 : 1) + (a.linked ? 43 : 0);
  openOverlay({ mod: "projects-ui", kind: "popup", width: 280, height, ...atClick(), props: { view: "agent-menu", agent: a } });
}

async function agentCopy(addr, what, cx) {
  const a = await agentAt(addr);
  const text = what === "branch" ? a?.branch : a?.cwd;
  if (!text) return toast(what === "branch" ? "No branch to copy" : "No folder to copy", addr, "warning");
  cx.write_to_clipboard(text);
  toast("Copied", text, "success");
}

/** Deletes the agent's linked worktree: closes the spaces in it, ends terminals left in it, then
 *  git worktree remove [--force] from the main checkout and prune. The branch stays. Resolves "" or why not. */
async function wtDelete(addr, force = false) {
  const a = await agentAt(addr);
  if (!a?.linked) return "Not in a linked worktree.";
  const n = await changes(a);
  if (n == null) return `git status failed in ${tilde(a.top)}.`;
  if (n && !force) return `${n} uncommitted change${n > 1 ? "s" : ""}: force needed.`;
  const gone = spaces().filter((s) => (s.machine ?? null) === a.on && inside(place(s), a.top));
  const tabs = new Set(gone.flatMap((s) => s.tabs.map((t) => t.id)));
  for (const s of gone) run("space.close", { id: s.id, confirmed: true });
  for (const p of panes()) if (p.terminal && !tabs.has(p.tab) && inside(p.cwd, a.top)) run("terminal.kill", { terminal: p.terminal });
  await until(() => !spaces().some((s) => gone.some((g) => g.id === s.id)));
  const r = await gitr(a.main, ["worktree", "remove", ...(force ? ["--force"] : []), a.top], a.on);
  if (!r.ok) return r.err || "git worktree remove failed.";
  await gitr(a.main, ["worktree", "prune"], a.on);
  toast(`Deleted worktree ${a.branch ?? ""}`, `${tilde(a.top)} · branch kept`, "success");
  return "";
}

/** Rereads the cached checkouts inside folder (all when none is) and their projects' bases: after a branch rename. */
async function refresh(folder) {
  const all = checkedOut(), at = folder ? all.filter(([cwd]) => inside(cwd, folder)) : [];
  const mains = new Set();
  await Promise.all((at.length ? at : all).map(([cwd, on]) => checkout(cwd, on).then((co) => co && mains.add(`${on ?? ""}|${co.main}`), () => null)));
  for (const p of knownData()?.projects ?? []) if (mains.has(`${p.machine ?? ""}|${expand(p.folder)}`)) bases(p).catch(() => null);
}

const focusedTerminal = () => { const f = focused(); return f?.agent ?? f?.terminal ?? null; };

/** Focuses the most recently used agent other than the focused one. */
function switchLast() {
  const here = focusedTerminal(), live = new Set(agents().map((a) => a.address));
  const to = mru().find((x) => x !== here && live.has(x));
  if (to) run("agent.focus", { terminal: to });
  else toast("No previous agent");
}

export default class Projects extends View {
  init(_props, cx) {
    this.data = knownData() ?? { projects: [] };
    // Agent focus history for the switcher: checked on focus changes, kept across restarts.
    if (!mru().length) try { for (const a of JSON.parse(localStorage.getItem("mru") ?? "[]").reverse()) used(a); } catch {}
    let last = null;
    cx.timer.every(250, () => {
      const now = focusedTerminal();
      if (now === last) return;
      const live = new Set(agents().map((a) => a.address));
      const moved = [last, now].filter((x) => live.has(x)).map(used).some(Boolean);
      last = now;
      if (moved) localStorage.setItem("mru", JSON.stringify(mru()));
    });
    cx.spawn(async (cx) => { await this.reload(); cx.notify(); });
    cx.spawn(async (cx) => {
      await exec("mkdir", ["-p", dir()]);
      for (;;) { await watchFolder(await watchDir()); await this.reload(); cx.notify(); }
    });
    cx.spawn(async (cx) => { for (;;) { await this.warm(); await cx.sleep(2000); } });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        cx.spawn(async (cx) => { await this.command(c, cx).catch((e) => toast("Projects", String(e?.message ?? e), "error")); await this.reload(); cx.notify(); });
      }
    });
  }

  /** Runs one command (projects.<name>[:args]). */
  async command(c, cx) {
    const pt = /@(-?\d+),(-?\d+)$/.exec(c);
    if (pt) { c = c.slice(0, pt.index); clickAt = { x: +pt[1], y: +pt[2] }; }
    const i = c.indexOf(":");
    const [name, arg] = i < 0 ? [c, ""] : [c.slice(0, i), c.slice(i + 1)];
    const [key, ...rest] = arg.split("|");
    const p = this.data.projects.find((x) => x.id === key);
    const space = focused()?.space;
    const ui = (props, size) => openOverlay({ mod: "projects-ui", ...size, props });
    if (name === "pick") run("mod.open", { name: "projects-ui" });
    else if (name === "switch") ui({ view: "switch" }, { kind: "popup", at: "top", offset: 40, width: 680, height: 470 });
    else if (name === "switch-last") switchLast();
    else if (name === "peek" && arg) peek(arg);
    else if (name === "peek-go") peekGo();
    else if (name === "peek-close") { const p = peekOpen(); if (p) closeOverlay(p.overlay); }
    else if (name === "refresh") await refresh(arg ? expand(arg) : null);
    else if (name === "compose") await compose(key, rest[0], rest[1]);
    else if (name === "agent-start" && arg) await agentStart(arg);
    else if (name === "branch-name" && p) await nameTest(p, rest[0], rest[1], rest[2]);
    else if (name === "new-menu") { ui({ view: "new" }, { kind: "popup", width: 290, height: 560, ...atClick() }); if (space) refreshSpace(space); }
    else if (name === "space-menu" && key) await (rest[0] ? spaceMenu(key, rest[0]) : rowMenu(key));
    else if (name === "add-space" && key) await addSpace(key);
    else if (name === "row-menu" && arg) await rowMenu(arg);
    else if (name === "agent-menu" && key) await agentMenu(key);
    else if (name === "agent-copy" && key) await agentCopy(key, rest[0], cx);
    else if (name === "agent-delete" && key) ui({ view: "agent-delete", terminal: key }, { kind: "dialog", width: 460 });
    else if (name === "wt-delete" && key) { const e = await wtDelete(key, rest[0] === "force"); if (e) toast("Couldn't delete the worktree", e, "error"); }
    else if (name === "add-folder") await addFolder();
    else if (name === "wt-from" && key) await wtFrom(key, rest[0], rest[1]);
    else if (name === "save") await (arg ? (p ? saveTo(p.id, space) : null) : saveFocused());
    else if (name === "add") await (arg ? add(expand(arg), null) : addCurrent());
    else if (name === "menu" && p) ui({ view: "menu", id: p.id }, { kind: "popup", width: 260, height: 290, ...atClick() });
    else if (name === "open" && p) await open(p);
    else if (name === "open-new" && p) await open(p, true);
    else if (name === "clear" && p) await edit(p.id, (_d, q) => { if (q) q.layout = null; });
    else if (name === "worktree" && p) worktreeDialog(p, rest[0], rest[1]);
    else if (name === "worktree" && !arg && space) await wtFrom(space, null, null, null);
    else if (name === "wt-create" && p) await wtCreate(p, rest[0], rest[1]);
    else if (name === "remove" && p) await edit(p.id, (d) => { d.projects = d.projects.filter((x) => x.id !== p.id); });
    else if (name === "overlay") openOverlay(JSON.parse(arg));
    else if (name === "bases") {
      const o = JSON.parse(arg), src = o.src ?? undefined;
      await track(o.req, async () => { if (basesAge(o.project, src) > 30000) await bases(o.project, src); return null; });
    }
    else if (name === "wt-run") { const o = JSON.parse(arg); await track(o.req, (stage) => openWorktree(o.project, o.branch, o.from, stage, o.src).then(() => null)); }
    else if (name === "agent-run") {
      const o = JSON.parse(arg);
      await track(o.req, async (stage) => {
        const project = (await load()).projects.find((x) => x.id === o.id);
        if (!project) throw new Error(`No project ${o.id}.`);
        await launch({ ...o, project }, stage);
      });
    } else if (name === "agent-info" && key) await track(rest[0], async (stage) => {
      const a = await agentAt(key, true);
      stage({ a });
      return { a, n: a?.linked ? await changes(a) : 0 };
    });
    else if (name === "wt-delete-run" && key) await track(rest[1], async () => { const e = await wtDelete(key, rest[0] === "force"); if (e) throw new Error(e); });
    else toast("Projects", `Unknown command or project: ${c}`, "warning");
  }

  /** Caches every space's and agent's checkout (a local one reread after 30 s) and each local project's bases, so the overlays open warm. */
  async warm() {
    const ps = panes(), sp = spaces();
    const at = [...sp.map((s) => [place(s, ps), s.machine]), ...agents().map((a) => [ps.find((p) => p.pane === a.pane)?.cwd, sp.find((s) => s.id === a.space)?.machine])];
    await Promise.all([
      ...at.map(([cwd, on]) => cwd && (peekCheckout(cwd, on) === undefined || (!on && checkoutAge(cwd) > 30000)) ? checkout(cwd, on).catch(() => null) : null),
      ...this.data.projects.filter((p) => p.folder && !p.machine && peekBases(p) === undefined).map((p) => bases(p).catch(() => null)),
    ]);
  }

  async reload() {
    try { this.data = await load(); } catch (e) { toast("Couldn't read projects.json", String(e?.message ?? e), "error"); }
  }

  render() {
    return div();
  }
}
