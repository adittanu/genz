// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.
// genz: a repo at a drive's root (a stray D:\.git) counts as no repo: its spaces are plain folders,
// called after the folder they're in, not all "D:" under one "D:" row.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, machines, panes, agents, run, openOverlay, exec, hc, home, theme, shared, setShared, watchFolder, window, layout, focused, notify } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 34);

// genz: the sidebar shows Spaces or Agents, not both. The switch in either header picks one; the
// other block shrinks to 0 px instead of being hidden, so it keeps running (like the projects host)
// and the agents list still orders agents and settles them while Spaces is up. The sizes are the
// layout's own, so the choice survives restarts. Kept the same in genz-spaces and genz-agents.
function listShown() {
  const l = layout();
  if (find(l, "spaces")?.size?.px === 0) return "agents";
  if (find(l, "agents")?.size?.px === 0) return "spaces";
  return null;
}
function showList(id) {
  run("layout.resize", { id, weight: 1 });
  run("layout.resize", { id: id === "spaces" ? "agents" : "spaces", px: 0 });
}
function listSwitch(own, t, { spaces: nSpaces, blocked, working }) {
  const on = listShown() ?? own;
  const seg = (id, label, extra) => h_flex().id(`list-${id}`).h(22).px(8).gap(6).flex_none().items_center().rounded(5)
    .text_color(on === id ? t.foreground : t.dim)
    .when(on === id, (e) => e.bg(t.raised))
    .when(on !== id, (e) => e.cursor_pointer().hover((s) => s.text_color(t.foreground)).on_click(() => showList(id)))
    .child(label).children(extra);
  const count = (n, color, mark) => h_flex().flex_none().gap(3).items_center().text_size(10.5).font_medium().text_color(color)
    .when(Boolean(mark), (e) => e.child(mark)).child(String(n));
  return h_flex().flex_none().gap(1).p(2).rounded(7).bg(t.hover)
    .child(seg("spaces", "Spaces", [count(nSpaces, t.dim)]))
    .child(seg("agents", "Agents", [
      ...(blocked > 0 ? [count(blocked, t.blocked, div().size(6).rounded(3).bg(t.blocked))] : []),
      ...(working > 0 ? [count(working, t.working, svg("mods/workspace-chrome/spinner.svg").size(10).flex_none().spin(900))] : []),
    ]));
}
// In the narrow rail: one button that shows the other list.
function railSwitch(own, t) {
  const other = (listShown() ?? own) === "spaces" ? "agents" : "spaces";
  return h_flex().h(36).flex_none().items_center().justify_center()
    .child(div().id("list-rail").size(22).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(other === "spaces" ? "Show spaces" : "Show agents")
      .on_click(() => showList(other))
      .child(svg(other === "spaces" ? "mods/workspace-chrome/layers.svg" : "mods/genz-agents/bot.svg").size(14)));
}
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
// A path's last part, Windows' (D:\Project\oot) and git's (D:/Project/oot) alike; a drive's root keeps its letter (D:).
const base = (path) => path.split(/[\\/]/).filter(Boolean).pop() ?? "";
// One spelling to compare folders by: slashes, none at the end, a Windows path's case ignored.
const norm = (path) => {
  const p = (path ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:/.test(p) ? p.toLowerCase() : p;
};
// personal: the saved project at a repo's main checkout (git) or holding the folder (plain).
const expand = (f) => (f === "~" || f?.startsWith("~/") ? home() + f.slice(1) : f);
function projectAt(on, folder, git) {
  const f = norm(folder);
  const inside = (root) => f === root || f.startsWith(`${root}/`);
  return (globalThis.__wranglerProjects?.known?.projects ?? [])
    .find((x) => (x.machine ?? null) === on && (git ? norm(expand(x.folder)) === f : inside(norm(expand(x.folder)))));
}
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// genz: Follow. A tab lives in the space of the folder it runs in. Herdr makes a space only on request (a `cd` in a
// terminal never does), so a Claude started after a `cd` stayed in the tab's old space. Now a tab whose terminal holds
// still in a folder outside its space (FOLLOW_STILL ms, so a passing `cd` doesn't move it) is moved to the space of that
// folder, and a space is made for the folder's root (saved project, else git top, else the folder) when none is. Kept
// for safety: only single-pane tabs, only a space's second tab onward (its only tab already names its space), never
// while an agent in it works or waits on you, one move at a time, and a terminal rests FOLLOW_COOL ms after a move.
// A move is `terminal.park` + a new tab for the terminal in the target space (labels, as Herdr adopts any
// terminal); it keeps running throughout. The header's folder button turns this off (shared "spaces.follow").
const FOLLOW_STILL = 5000;
const FOLLOW_COOL = 120000;
const FOLLOW_GAP = 8000;
const FOLLOW_WARMUP = 20000;
const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
// A drive's root, "/" and the home folder hold only themselves, not everything under them.
const wide = (a) => !a || /^([A-Za-z]:)?$/.test(a) || a === norm(home());
const holds = (anchor, p) => Boolean(anchor) && Boolean(p) && (p === anchor || (!wide(anchor) && p.startsWith(`${anchor}/`)));

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// personal: an 18px icon on a tint of its color, beside the letter avatars.
const tile = (color, icon) => h_flex().size(22).flex_none().rounded(7).items_center().justify_center().bg(color + "2e").text_color(color)
  .child(svg(icon).size(13));
const machineHue = (name) => Object.values(MARK)[[...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 6];

// personal: a small icon button for a section header.
function headerButton(id, icon, tip, t, action, on = false) {
  return div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(5).text_color(on ? t.accent : t.dim)
    .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(action)
    .child(svg(`mods/workspace-chrome/${icon}.svg`).size(14));
}

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    // personal: repos whose worktree rows are folded away; machine whose header the pointer is on.
    this.repoFolded = new Set(JSON.parse(localStorage.getItem("repos.folded") ?? "[]"));
    this.hoverMachine = undefined;
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
    // genz: Follow (see FOLLOW_STILL). anchors: space id -> the root folder of a space made here, which Herdr's own
    // `folder` for it (where its first terminal started) may not say. still: terminal -> its folder and since when.
    this.anchors = JSON.parse(localStorage.getItem("follow.anchors") ?? "{}");
    this.still = new Map();
    this.cool = new Map();
    this.moving = false;
    this.last = 0;
    this.started = Date.now();
    cx.timer.every(1000, (cx) => this.follow(cx));
  }

  saveAnchors() {
    localStorage.setItem("follow.anchors", JSON.stringify(this.anchors));
  }

  // The folder a space holds: where a space made here is rooted, else where its terminals start (home when unset).
  anchorOf(s) {
    return norm(this.anchors[s.id] ?? (s.folder || home()));
  }

  // The root of a folder's project: a saved project holding it, else its git top (not a drive-root repo), else itself.
  async rootOf(cwd) {
    const f = norm(cwd);
    const saved = projectAt(null, f, false);
    if (saved) return norm(expand(saved.folder));
    try {
      const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd });
      const top = r.code === 0 ? norm(r.stdout.trim()) : "";
      if (top && !wide(top)) return top;
    } catch {}
    return f;
  }

  async until(test, ms, cx) {
    for (let waited = 0; waited < ms; waited += 150) {
      if (test()) return true;
      await cx.sleep(150);
    }
    return test();
  }

  follow(cx) {
    const now = Date.now();
    if (this.moving || shared("spaces.follow") === false || now - this.started < FOLLOW_WARMUP) return;
    const sp = spaces(), ps = panes();
    const at = {};
    for (const s of sp) for (const t of s.tabs ?? []) at[t.id] = { s, t };
    const live = new Set();
    let pick = null;
    for (const p of ps) {
      const x = at[p.tab];
      if (!p.terminal || !x || x.s.machine || !p.cwd) continue;
      live.add(p.terminal);
      const cwd = norm(p.cwd), was = this.still.get(p.terminal);
      if (was?.cwd !== cwd) { this.still.set(p.terminal, { cwd, since: now }); continue; }
      if (pick || now - was.since < FOLLOW_STILL || (this.cool.get(p.terminal) ?? 0) > now) continue;
      if (x.t.panes !== 1 || x.t.settled || (x.s.tabs ?? []).length < 2 || p.status === "working" || p.status === "blocked") continue;
      if (holds(this.anchorOf(x.s), cwd)) continue;
      pick = { p, s: x.s, t: x.t, cwd };
    }
    for (const k of [...this.still.keys()]) if (!live.has(k)) this.still.delete(k);
    for (const [k, until] of [...this.cool]) if (until <= now) this.cool.delete(k);
    // Anchors of spaces that are gone.
    if (sp.length && now - this.started > 60000) {
      const ids = new Set(sp.map((s) => s.id)), gone = Object.keys(this.anchors).filter((id) => !ids.has(id));
      if (gone.length) { for (const id of gone) delete this.anchors[id]; this.saveAnchors(); }
    }
    if (pick && now - this.last >= FOLLOW_GAP) this.relocate(pick, cx);
  }

  // Moves the terminal's tab to the space of its folder. The terminal runs on throughout; only its pane is
  // taken away and given back as a new tab. If anything fails after the pane is gone, it goes back to its old space.
  relocate({ p, s, t, cwd }, cx) {
    this.moving = true;
    this.last = Date.now();
    cx.spawn(async (cx) => {
      const addr = p.terminal;
      const tabId = `tb${hex(32)}`;
      let target = null, asked = false;
      try {
        // The folder's project root. The target is a space rooted there, or one rooted deeper that still holds the folder
        // (a repo inside the project); never one rooted above it: a space on D:\Project must not swallow every project
        // under it. None: a new space rooted at the folder's root.
        const root = await this.rootOf(p.cwd);
        // It moved on while git answered: look again next time.
        if (norm(panes().find((x) => x.pane === p.pane)?.cwd) !== cwd) return;
        target = spaces().filter((x) => x.id !== s.id && !x.machine).map((x) => [x, this.anchorOf(x)])
          .filter(([, a]) => a === root || (a.length > root.length && holds(a, cwd))).sort((l, r) => r[1].length - l[1].length)[0]?.[0].id ?? null;
        if (!target) {
          target = `spc${hex(32)}`;
          this.anchors[target] = root;
          this.saveAnchors();
        }
        const before = focused();
        run("terminal.park", { terminal: addr });
        asked = true;
        if (!(await this.until(() => !panes().some((x) => x.terminal === addr), 8000, cx))) throw new Error("its pane did not close");
        const r = await hc(["label", addr, `herdr.space=${target}`, `herdr.tab=${tabId}`]);
        if (r.code !== 0) throw new Error(r.stderr.trim() || "could not label the terminal");
        if (!(await this.until(() => spaces().find((x) => x.id === target)?.tabs.some((x) => x.id === tabId), 8000, cx))) throw new Error("its new tab did not appear");
        if (t.named) run("tab.rename", { id: tabId, name: t.name });
        // The view stays as the person had it: following the terminal if they were on it, else where they were.
        const now = focused();
        if (before?.terminal === addr) {
          run("space.select", { id: target });
          run("tab.select", { id: tabId });
          run("pane.focus", { terminal: addr });
        } else if (before && (now?.space !== before.space || now?.tab !== before.tab)) {
          run("space.select", { id: before.space });
          run("tab.select", { id: before.tab });
          if (before.pane) run("pane.focus", { pane: before.pane });
        }
        this.cool.set(addr, Date.now() + FOLLOW_COOL);
        notify({ title: "Tab moved with its folder", body: `${t.name} → ${spaces().find((x) => x.id === target)?.name ?? base(cwd)}`, level: "info", timeout: 4000 });
      } catch (e) {
        // Gone from its pane and not back anywhere: put it back in its old space.
        if (asked && !panes().some((x) => x.terminal === addr)) await hc(["label", addr, `herdr.space=${s.id}`, `herdr.tab=tb${hex(32)}`]).catch(() => {});
        if (target && this.anchors[target] && !spaces().some((x) => x.id === target)) { delete this.anchors[target]; this.saveAnchors(); }
        this.cool.set(addr, Date.now() + 10 * FOLLOW_COOL);
        notify({ title: "Couldn't move the tab", body: String(e?.message ?? e), level: "error" });
      } finally {
        this.moving = false;
      }
    });
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // Its repo first, in one cheap call: its top and its own .git folder.
      const rp = await exec("git", ["rev-parse", "--show-toplevel", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      if (rp.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(rp.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // Without a trailing slash: git says D:/ for a drive's root, which made it a worktree of itself.
      const [top, repo] = rp.stdout.split("\n").map((l) => l.trim().replace(/\/+$/, ""));
      // genz: a repo at a drive's root holds the whole disk, not a project. Its places (its worktrees'
      // too) count as plain folders, and its status isn't asked (it would walk the whole disk).
      if (/^([A-Za-z]:)?$/.test(top) || /^([A-Za-z]:)?\/\.git$/.test(repo)) {
        this.git[key] = null;
        return;
      }
      // No optional locks: a status that touched the index would wake the watch again.
      // Writes nothing under .git (index lock, fsmonitor cookie): watch() would wake on it.
      const r = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w, e) {
    // personal: projects menu for every row, opened where the click was
    const g = this.git[where(w, panes())], at = `@${Math.round(e.position.x)},${Math.round(e.position.y)}`;
    run(g ? `projects.space-menu:${w.id}${g.linked ? "|linked" : "|main"}${at}` : `projects.row-menu:${w.id}${at}`);
  }

  // What a row calls its space: its name, else where its first terminal is (Herdr's rule: its repo,
  // else its folder, "~" at home). genz: outside a repo (a drive-root one counts, see check) the
  // folder is taken from where it is now, not from Herdr's name: Herdr calls a drive-root repo "D:",
  // and keeps a repo's name it once saw until it restarts.
  label(w, ps) {
    const key = where(w, ps);
    if (w.named || w.name === "~" || this.git[key] !== null || this.unsure.has(key)) return w.name;
    return base(place(w, ps)) || w.name;
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  // personal: a worktree whose main checkout has no space goes under a row for its repo (ghost) instead.
  // personal: a folded repo keeps only its active worktree.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null, name: this.label(w, ps) })).filter((r) => this.shown.has(r.w.id));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces, else its ghost row)
    const kidsOf = (repo) => list.filter((x) => x.g?.linked && x.g.repo === repo);
    const kids = (repo) => {
      const folded = this.repoFolded.has(repo);
      const k = kidsOf(repo).filter((x) => !folded || x.w.active);
      k.forEach((x, n) => out.push({ ...x, tree: n === k.length - 1 ? "last" : "mid", first: n === 0 }));
    };
    const fold = (repo) => ({ repo, count: kidsOf(repo).length, open: !this.repoFolded.has(repo) });
    for (const r of list) {
      if (r.g?.linked) {
        if (mains.has(r.g.repo) || placed.has(r.g.repo)) continue;
        placed.add(r.g.repo);
        out.push({ ghost: true, g: r.g, w: { machine: r.w.machine ?? null }, fold: fold(r.g.repo) });
        kids(r.g.repo);
        continue;
      }
      const first = r.g && !placed.has(r.g.repo);
      out.push({ ...r, tree: null, fold: first && kidsOf(r.g.repo).length ? fold(r.g.repo) : null });
      if (!first) continue;
      placed.add(r.g.repo);
      kids(r.g.repo);
    }
    return out;
  }

  // personal: a repo with worktree spaces but none of its own: its project's name (else the repo's), outlined;
  // click opens the project (else a space there), right-click its menu.
  ghost({ g, fold }, t) {
    const [on, git] = JSON.parse(g.repo), main = git.replace(/\/\.git\/?$/, "");
    const p = projectAt(on, main, true);
    const name = p?.name ?? g.name;
    return h_flex().id(`repo-${on ?? ""}-${main}`).px(8).h(34).flex_none().gap(9).items_center().rounded(10).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => {
        // A space already at its main checkout (not sorted under it yet): go there, don't make another.
        const ps = panes(), there = spaces().find((s) => (s.machine ?? null) === on && norm(place(s, ps)) === norm(main));
        if (there) run("space.select", { id: there.id });
        else if (p) run(`projects.open:${p.id}`);
        else run("space.new", { folder: main, ...(on ? { machine: on } : {}) });
      })
      .on_mouse_down("right", (e) => { if (p) run(`projects.menu:${p.id}@${Math.round(e.position.x)},${Math.round(e.position.y)}`); })
      .child(h_flex().size(22).flex_none().rounded(7).border(1).border_color(t.dim).items_center().justify_center().text_size(10.5).font_bold().text_color(t.dim).child([...name][0]?.toUpperCase() ?? "?"))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(name))
      .when(Boolean(fold), (el) => el.child(this.foldChip(fold, t)));
  }

  // personal: "2 ˅" at a repo row's end: its worktree count, click folds them.
  foldChip({ repo, count, open }, t) {
    return h_flex().id(`fold-${repo}`).flex_none().h(20).pl(6).pr(4).gap(4).items_center().rounded(5)
      .text_size(11).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        open ? this.repoFolded.add(repo) : this.repoFolded.delete(repo);
        localStorage.setItem("repos.folded", JSON.stringify([...this.repoFolded]));
        cx.notify();
      })
      .tooltip(open ? "Hide worktrees" : "Show worktrees")
      .child(String(count))
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11));
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered().filter((r) => !(collapsed && r.ghost));
    const draw = (r) => (r.ghost ? this.ghost(r, t) : collapsed ? this.compact(r, t) : this.row(r, t));
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.map(draw);
    // personal: with other machines, a foldable row per machine (this computer first), its spaces indented under it.
    return [null, ...remote].flatMap((m, n) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const machine = this.machines.find(k => k.name === m);
      const connected = !m || machine?.state === "connected";
      const folded = this.folded.has(m);
      const hovered = this.hoverMachine === m;
      const key = m ?? "local";
      const head = h_flex().id(`machine-${key}`).h(28).flex_none().when(n > 0, (el) => el.mt(10)).px(collapsed ? 2 : 8).gap(9).items_center().rounded(8).text_size(12.5).text_color(t.muted)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_hover((on, cx) => { this.hoverMachine = on ? m : this.hoverMachine === m ? undefined : this.hoverMachine; cx.notify(); })
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(m ? tile(machineHue(m), "mods/workspace-chrome/server.svg") : tile(t.accent, "mods/workspace-chrome/monitor.svg"))
        .when(!collapsed, el => el.child(h_flex().flex_1().min_w(0).gap(7).items_center()
            .child(div().min_w(0).truncate().child(m ?? "This computer"))
            .when(Boolean(m), el => el.child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))))
          .when(!connected, el => el.child(div().flex_none().text_size(11).text_color(t.dim).child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(connected && hovered, el => el.child(div().id(`machine-add-${key}`).size(20).flex_none().flex().items_center().justify_center().rounded(5)
            .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("New space there")
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", m ? { machine: m } : {}); }).child(svg("mods/workspace-chrome/plus.svg").size(12))))
          .child(h_flex().flex_none().gap(4).items_center().text_size(11).text_color(t.dim)
            .when(folded && mine.length > 0, el => el.child(String(mine.length)))
            .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11))));
      const empty = h_flex().id(`machine-new-${key}`).h(28).flex_none().pl(35).pr(8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", m ? { machine: m } : {}))
        .child(svg("mods/workspace-chrome/plus.svg").size(12)).when(!collapsed, el => el.child("New space there"));
      const body = mine.length ? mine.map(draw) : [loading(m) ? loadingRow(m) : empty];
      return [head, ...(folded ? [] : [v_flex().pl(collapsed ? 0 : 10).children(body)])];
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    // personal: a worktree row shows only ahead/behind; its branch is in the row's tooltip.
    const where = tree ? "" : [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  row({ w, i, g, name, tree, first, fold }, t) {
    const on = w.active;
    const isHome = !tree && name === "~";
    const branch = g?.branch ?? "detached";
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    // personal: plain spaces (no saved project) get a hollow avatar
    const [machine, git] = g ? JSON.parse(g.repo) : [w.machine ?? null, null];
    const isProject = !tree && (git ? projectAt(machine, git.replace(/\/\.git\/?$/, ""), true) : projectAt(machine, place(w, panes()), false));
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(10)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(on && !tree, (el) => el.child(div().absolute().left(0).top(9).bottom(9).w(3).rounded(2).bg(t.accent)))
      .when(this.pressed === i && this.over !== i, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === i && this.pressed !== i, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(this.pressed < i, line => line.bottom(0))
          .when(this.pressed > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = i;
        this.over = i;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces()[this.pressed];
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? i : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === i && from !== i) run("space.move", { id: spaces()[from].id, index: i + 1 });
        else if (from === i) run("space.select", { id: w.id });
        cx.notify();
      })
      .on_mouse_down("right", (e) => this.menu(w, e))
      .when(Boolean(tree) && branch !== name, (el) => el.tooltip(branch))
      // personal: worktrees branch off their repo's avatar on a curve, names aligned with the repo's.
      .when(Boolean(tree), (el) => {
        const lift = first ? 5 : 0, mid = rowHeight({ tree }) / 2;
        return el
          .when(tree !== "last", (l) => l.child(div().absolute().left(19).top(-lift).bottom(0).w(1).bg(t.dim + "55")))
          .child(div().absolute().left(19).top(-lift).h(mid + lift).w(12).border_l(1).border_b(1).rounded_bl(8).border_color(t.dim + "55"));
      })
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(31))
          .when(isHome, el => el.child(tile(t.muted, "mods/genz-spaces/house.svg")))
          .when(!tree && !isHome, el => el.child(h_flex().size(22).flex_none().rounded(7).items_center().justify_center().text_size(11.5).font_bold()
            .when(Boolean(isProject), (a) => a.bg(fill).text_color("#ffffff"))
            .when(!isProject, (a) => a.border(1).border_color(t.dim).text_color(t.dim))
            .child([...name][0]?.toUpperCase() ?? "?")))
          .child(div().flex_shrink(0).max_w(tree ? 190 : 150).truncate().text_size(tree ? 13 : 13.5).when(on, (el) => el.font_medium())
            .text_color(tree && !on ? t.muted : t.foreground).child(isHome ? "Home" : name))
          .child(g ? this.gitTail(g, tree, name, t) : div().flex_1())
          // personal: a space speaks up when an agent in it is working, finished, or needs you.
          .when(w.status === "working", (el) => el.child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900)))
          .when(w.status === "blocked" || w.status === "done", (el) => el.child(div().size(8).flex_none().rounded(4).bg(tone(t, w.status))))
          .when(Boolean(fold), (el) => el.child(this.foldChip(fold, t))),
      );
  }

  compact({ w, i }, t) {
    return h_flex()
      .id(`space-${w.id}`)
      .h(26)
      .flex_none()
      .justify_center()
      .gap(4)
      .when(w.active, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().text_color(tone(t, w.status)).child(glyph(w.status)));
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    // While Agents is up this block is 0 px: skip the agent counts its switch would show.
    const ags = listShown() === "agents" ? [] : agents();
    const follow = shared("spaces.follow") !== false;
    const counts = { spaces: sp.length, blocked: ags.filter((a) => a.status === "blocked").length, working: ags.filter((a) => a.status === "working").length };
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      // genz: the header switches the sidebar between Spaces and Agents, finds a project (picker) and opens the new space / project menu where it was clicked.
      .when(!collapsed, el => el.child(h_flex().h(38).flex_none().pl(10).pr(10).pt(6).gap(4).items_center().text_size(12).font_semibold().text_color(t.muted)
        .child(listSwitch("spaces", t, counts))
        .child(div().flex_1())
        .child(headerButton("sp-find", "search", "Find project (⌃⇧J)", t, () => run("projects.pick")))
        // genz: Follow on/off: tabs move to the space of the folder they run in.
        .child(headerButton("sp-follow", "folder", `Tabs follow their folder into its space: ${follow ? "on" : "off"}. Click to turn it ${follow ? "off" : "on"}.`, t, () => setShared("spaces.follow", !follow), follow))
        .child(headerButton("sp-new", "plus", "New space or project", t,
          (ev) => run(ev?.position ? `projects.new-menu@${Math.round(ev.position.x)},${Math.round(ev.position.y)}` : "projects.new-menu")))))
      .when(collapsed, (el) => el.child(railSwitch("spaces", t)))
      .child(v_flex().id("sp-list").flex_1().min_h(0).px(8).pb(8).gap(2).overflow_y_scroll()
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(this.grouped(t, collapsed)));
  }
}
