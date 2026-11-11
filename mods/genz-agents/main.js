// Agents in grouped or priority views; parents take their most urgent sub-agent's place.
// A viewed done agent stays in Done until left.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import * as fs from "fs/promises";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, closeOverlay, openOverlay, props, appHome, exec, home, readTextFile, watchFolder, window, layout, hc, notify, knownAgents } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// personal: the rail goes by the sidebar's width, not the shared flag.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

// personal: project agents titled by project, with a branch line under the task. Projects from the projects mod's projects.json, colored as its + menu does.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };
// genz: folders compared with slashes: Herdr's are D:\x on Windows (cwd, saved projects), git's D:/x.
const slash = (p) => (typeof p === "string" ? p.replace(/\\/g, "/") : p);
const expand = (p) => slash(p === "~" || p?.startsWith("~/") ? home() + p.slice(1) : p);
const inside = (p, root) => {
  p = slash(p); root = slash(root);
  return !!p && (p === root || p.startsWith(root + "/"));
};
async function git(cwd, args, on = null) {
  try { const r = await exec("git", args, { cwd, ...(on ? { on } : {}) }); return r.code === 0 ? r.stdout.trim() : null; } catch { return null; }
}
const machineOf = (address) => (address.includes("/") ? address.split("/")[0] : null);
function hue(p, ids) {
  const root = expand(p.folder), ps = panes();
  const place = (s) => { const tabs = new Set(s.tabs.map((t) => t.id)); return slash(ps.find((x) => tabs.has(x.tab) && x.cwd)?.cwd || s.folder); };
  const near = spaces().filter((s) => (s.machine ?? null) === (p.machine ?? null) && inside(place(s), root));
  const s = near.find((x) => place(x) === root) ?? near[0];
  const c = s && shared("space.colors")?.[s.id];
  if (c) return c.startsWith("#") ? c : (MARK[c] ?? theme()[c]);
  const all = Object.values(MARK);
  return all[Math.max(0, ids.indexOf(p.id)) % all.length];
}

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

function lead(tab, all = panes()) {
  const mine = all.filter(p => p.tab === tab.id && p.terminal);
  return mine.find(p => p.program?.agent) ?? mine.find(p => p.focused) ?? mine[0];
}

function title(tab, l) {
  const prog = l?.program?.name;
  const live = clean(l?.title);
  const telling = live && live !== prog && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@") && live.toLowerCase() !== l?.program?.key;
  return tab.name === prog && telling ? live : tab.name;
}
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const SORTS = [
  { id: "priority", label: "Priority", icon: "clock" },
  { id: "grouped", label: "Grouped by project", icon: "layers" },
];
const sortOf = () => SORTS.find((s) => s.id === shared("agents.sort")) ?? SORTS[0];
const SECTION = { 4: "Needs you", 3: "Done", 2: "Working", 1: "Idle" };
const SECTION_STATUS = { 4: "blocked", 3: "done", 2: "working" };
// personal: priority view keeps Working at the bottom, capped until "more"; everything waiting on you stays on top.
const BOTTOM = new Set(["sec-2"]);
const LIMIT = 3;

// genz: Settled. An agent idle this many days settles itself (shared "agents.settleDays"; 0 = never). The pill in the
// Settled header steps through SETTLE_CHOICES. Working and blocked agents (and ones with a busy sub-agent) never settle.
const SETTLE_DAYS = 3;
const SETTLE_CHOICES = [1, 3, 7, 14, 0];
const settleDays = () => { const d = shared("agents.settleDays"); return Number.isFinite(d) && d >= 0 ? d : SETTLE_DAYS; };
const BUSY = new Set(["working", "blocked"]);
const SETTLED_FIRST = 10;
const SETTLED_MAX_H = 230;

// genz: Parked. A settled agent can be taken out of memory and still wait on the shelf: its pane is closed (the terminal
// ends) and a record in localStorage "parked" says how to start it again. Per agent: `cont` resumes the latest session of
// that folder, `pick` opens the agent's own session picker (used when other agents share the folder, where "the latest"
// could be someone else's). Agents not listed here can't be parked. Remote agents can't either.
const RESUME = [
  { re: /claude/i, exe: "claude", cont: ["--continue"], pick: ["--resume"] },
  { re: /kiro/i, exe: "kiro-cli", cont: ["chat", "--resume"], pick: ["chat", "--resume-picker"] },
  { re: /opencode/i, exe: "opencode", cont: ["--continue"], pick: ["--continue"] },
  { re: /codebuddy/i, exe: "codebuddy", cont: ["--continue"], pick: ["--resume"] },
  { re: /codex/i, exe: "codex", cont: ["resume", "--last"], pick: ["resume"] },
];
const specOf = (x) => RESUME.find((r) => r.re.test(`${x.app ?? ""} ${x.key ?? x.program?.key ?? ""} ${x.name ?? x.program?.name ?? ""}`));
// Parkable: a local agent we have a resume command for (park() also needs its folder).
const canPark = (a) => Boolean(specOf(a)) && !a.address.includes("/");
const PARK_CHOICES = [0, 1, 7, 14, 30];
const parkDays = () => { const d = shared("agents.parkDays"); return Number.isFinite(d) && d >= 0 ? d : 0; };
const sameDir = (a, b) => Boolean(a && b) && a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
// personal: Claude's own sub-agents (Agent tool), from the files projects/hooks/subagents.sh keeps per terminal.
const SUBS = () => `${appHome()}/data/projects/subagents`;

// genz: Terminals. Plain terminals (a shell, or any program that isn't an agent) get a group of their own under the
// agents, so everything that runs is in one list. A row is titled by what tells it apart: the command running in it,
// else a tab name someone gave, else its folder. Running ones first, then the most recently used; idle ones past
// TERMS_FIRST fold into "N more".
// What runs in a shell: other systems report it as the terminal's `foreground`. On Windows the core always reports the
// shell itself, so shell-procs.cs (compiled once into data/genz-agents/, by csc from .NET Framework) reads the shells'
// child processes. It is asked every PROBE_FAST ms while the group shows, PROBE_SLOW otherwise; ~50 ms a look.
const TERMS_FIRST = 5;
const PROBE_FAST = 5000;
const PROBE_SLOW = 30000;
const PROBE_VER = 1; // in the helper's file name: raise it when shell-procs.cs changes, and it is compiled again.
const CSC = ["C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe", "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe"];
const leaf = (p) => slash(p).split("/").filter(Boolean).pop() ?? p;
const quote = (a) => (/\s/.test(a) ? `"${a}"` : a);
// A Windows command line as words: quotes group, and are dropped.
function argvOf(line) {
  const out = [];
  let cur = "", quoted = false, any = false;
  for (const c of line) {
    if (c === '"') { quoted = !quoted; any = true; continue; }
    if (!quoted && /\s/.test(c)) { if (cur || any) out.push(cur); cur = ""; any = false; continue; }
    cur += c;
  }
  if (cur || any) out.push(cur);
  return out;
}
// A command as a person typed it: `"C:\Program Files\nodejs\node.exe" ...\npm-cli.js run dev` reads "npm run dev",
// `cmd /c ""C:\...\php.bat" artisan serve"` reads "php artisan serve". Paths lose their folders.
function commandName(line, exe) {
  const viaCmd = /^"?[^"]*\bcmd(?:\.exe)?"?\s+(?:.*?\s)?\/[ck]\s+(.+)$/i.exec(line ?? "");
  let inner = viaCmd ? viaCmd[1].trim() : (line ?? "");
  if (viaCmd && inner.startsWith('"') && inner.endsWith('"') && inner.slice(1, -1).includes('"')) inner = inner.slice(1, -1);
  const w = argvOf(inner);
  const short = (s) => { const b = leaf(s).replace(/\.(exe|com|cmd|bat|ps1)$/i, ""); return b && b === b.toUpperCase() ? b.toLowerCase() : b; };
  if (!w.length) return short(exe ?? "");
  let head = short(w[0]), rest = w.slice(1);
  const tool = /^node$/i.test(head) && rest.length ? /^(npm|npx|pnpm|yarn|bun)(?:-cli)?\.(?:c?js|mjs)$/i.exec(leaf(rest[0])) : null;
  if (tool) { head = tool[1].toLowerCase(); rest = rest.slice(1); }
  const isPath = (x) => /^[A-Za-z]:[\\/]/.test(x) || x.startsWith("\\\\") || (x.startsWith("/") && x.indexOf("/", 1) > 0);
  return [head, ...rest.map((x) => (isPath(x) ? leaf(x) : x))].join(" ").slice(0, 120);
}

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// personal: how long since a waiting agent last changed.
const ago = (ms) => (ms < 60000 ? "just now" : `${duration(ms)} ago`);

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// personal: a small icon button for the header.
function headerButton(id, src, tip, t, action) {
  return div().id(id).size(22).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.dim)
    .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click(action)
    .child(svg(src).size(14));
}

// genz: the sidebar shows Spaces or Agents, not both. The switch in either header picks one; the
// other block shrinks to 0 px instead of being hidden, so it keeps running (like the projects host)
// and this list still orders agents and settles them while Spaces is up. The sizes are the
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
  return div().id("list-rail").size(22).flex_none().flex().items_center().justify_center().rounded(5).text_color(t.dim)
    .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip(other === "spaces" ? "Show spaces" : "Show agents")
    .on_click(() => showList(other))
    .child(svg(other === "spaces" ? "mods/workspace-chrome/layers.svg" : "mods/genz-agents/bot.svg").size(14));
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.sortMenu) return;
    this.folded = new Set();
    // personal: agents with Claude sub-agents start folded; these were opened.
    this.opened = new Set();
    this.more = new Set();
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    this.revived = JSON.parse(localStorage.getItem("revived") ?? "{}");
    this.core = {};
    // genz: parked agents: [{id, title, app, key, name, icon, tint, cwd, space, spaceName, at}], newest first.
    this.parked = JSON.parse(localStorage.getItem("parked") ?? "[]");
    // genz: Settled. Put-away agents carry `settled=<ms>:<turn>` as a label on their terminal (see setSettled).
    // pending: labels written but not back from the core yet (address -> value, "" = removed).
    this.pending = {};
    this.settledOpen = localStorage.getItem("settled-open") === "true";
    this.settledMore = false;
    // genz: Terminals. procs: terminal -> { cmd, at } for shells running a command (see probe). stamps: terminal ->
    // { seen, ran }: when it was last looked at and when a command last started or ended in it, kept across restarts.
    this.procs = new Map();
    this.stamps = JSON.parse(localStorage.getItem("terms") ?? "{}");
    this.termsOpen = localStorage.getItem("terms-open") !== "false";
    this.termsMore = false;
    cx.spawn(async (cx) => {
      for (;;) {
        try { await this.probe(cx); } catch {}
        await cx.sleep(this.probeGap());
      }
    });
    cx.timer.every(30000, (cx) => cx.notify());
    // genz: agents idle for settleDays() days settle themselves; looked at once a minute and at the first render with agents.
    cx.timer.every(60000, (cx) => this.autoSettle(cx));
    // personal: project title and branch line. checkouts: cwd → {main, linked} from git; projects reread every 30 s;
    // redrawn when the projects host's cache changes (its branches).
    this.projects = [];
    // personal: kept across reloads, so cards don't show their space until git answers again.
    this.checkouts = new Map(JSON.parse(localStorage.getItem("checkouts") ?? "[]"));
    this.want = new Set();
    this.recheck = new Set(this.checkouts.keys());
    const reread = (cx) => cx.spawn(async (cx) => { try { this.projects = (JSON.parse((await readTextFile(`${appHome()}/data/projects/projects.json`)) ?? "{}").projects ?? []).filter((p) => p.id && p.folder); cx.notify(); } catch {} });
    reread(cx);
    cx.timer.every(30000, reread);
    cx.timer.every(1500, (cx) => {
      const ver = globalThis.__wranglerProjects?.ver;
      if (ver !== this.ver) { this.ver = ver; cx.notify(); }
      this.lookup(cx);
      if (this.poll && !this.reading) cx.spawn(async (cx) => { await this.readSubs(); cx.notify(); });
      this.describe(cx);
    });
    // personal: terminal → its running Claude sub-agents; descriptions from Claude's meta files. Reread on each change
    // under the folder; a 1.5 s poll only if the watch fails. Folders of ended terminals are removed every 30 s.
    this.subs = new Map();
    this.descs = new Map();
    cx.spawn(async (cx) => {
      await fs.mkdir(SUBS(), { recursive: true }).catch(() => {});
      for (;;) {
        await this.readSubs();
        cx.notify();
        try { await watchFolder(SUBS()); } catch { this.poll = true; return; }
      }
    });
    cx.timer.every(30000, () => this.sweep());
  }

  // genz: read with fs, not sh/tr (no POSIX shell on Windows): <terminal>/<id>.json files, one per running sub-agent.
  async readSubs() {
    this.reading = true;
    const m = new Map();
    try {
      for (const t of await fs.readdir(SUBS())) {
        let files = [];
        try { files = await fs.readdir(`${SUBS()}/${t}`); } catch { continue; }
        for (const f of files.filter((x) => x.endsWith(".json"))) {
          try { m.set(t, [...(m.get(t) ?? []), JSON.parse(await fs.readFile(`${SUBS()}/${t}/${f}`, "utf8"))]); } catch {}
        }
      }
    } catch {}
    for (const l of m.values()) l.sort((x, y) => (x.at ?? 0) - (y.at ?? 0));
    const ids = new Set([...m.values()].flat().map((c) => c.id));
    for (const id of this.descs.keys()) if (!ids.has(id)) this.descs.delete(id);
    this.subs = m;
    this.reading = false;
  }

  describe(cx) {
    const need = [...this.subs.values()].flat().filter((c) => c.meta && !this.descs.has(c.id));
    if (this.describing || !need.length) return;
    this.describing = true;
    cx.spawn(async (cx) => {
      for (const c of need) {
        try { const d = JSON.parse((await readTextFile(c.meta)) ?? "null")?.description; if (d) this.descs.set(c.id, d); } catch {}
      }
      this.describing = false;
      cx.notify();
    });
  }

  sweep() {
    const live = new Set(terminals().filter((k) => k.state === "live").map((k) => k.address));
    const gone = [...this.subs.keys()].filter((t) => live.size && !live.has(t) && /^[\w-]+$/.test(t));
    for (const t of gone) this.removeDir(`${SUBS()}/${t}`);
  }

  async removeDir(dir) {
    try {
      for (const f of await fs.readdir(dir)) await fs.unlink(`${dir}/${f}`).catch(() => {});
      await fs.rmdir(dir);
    } catch {}
  }

  isFolded(addr, subs) {
    return this.folded.has(addr) || (!this.opened.has(addr) && subs.some((s) => s.t.claude));
  }

  // genz: Terminals. Often while the group can be seen, seldom otherwise (the stamps still follow commands).
  probeGap() {
    const seen = this.termsOpen && listShown() !== "spaces" && !narrow() && window()?.active !== false;
    return seen ? PROBE_FAST : PROBE_SLOW;
  }

  // The helper's path, compiled on first use. Null when it can't be built: the list still works, without commands.
  async helper() {
    if (this.exe !== undefined) return this.exe;
    this.exe = null;
    const win = (p) => p.replace(/\//g, "\\");
    const dir = `${appHome()}/data/genz-agents`, name = `shell-procs-${PROBE_VER}.exe`;
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    let have = (await fs.readdir(dir).catch(() => [])).includes(name);
    for (const csc of have ? [] : CSC) {
      const r = await exec(csc, ["/nologo", "/optimize+", `/out:${win(`${dir}/${name}`)}`, win(`${appHome()}/mods/genz-agents/shell-procs.cs`)], { timeout: 60000 }).catch(() => null);
      if (r?.code === 0) { have = true; break; }
    }
    if (have) this.exe = win(`${dir}/${name}`);
    return this.exe;
  }

  // Which local shells run a command now. Redraws only when that changed; a command starting or ending stamps its terminal.
  async probe(cx) {
    if (window()?.platform !== "windows") return;
    const byAddr = new Map(terminals().map((k) => [k.address, k]));
    const pids = new Map();
    for (const p of panes()) {
      const k = p.terminal && !p.terminal.includes("/") && p.program?.shell ? byAddr.get(p.terminal) : null;
      if (k?.pid && k.state === "live") pids.set(String(k.pid), p.terminal);
    }
    const next = new Map();
    if (pids.size) {
      const exe = await this.helper();
      if (!exe) return;
      const r = await exec(exe, [...pids.keys()]).catch(() => null);
      if (!r || r.code !== 0) return;
      for (const line of r.stdout.split("\n")) {
        const [pid, at, , name, cmd] = line.split("\t");
        const addr = pids.get(pid);
        if (addr) next.set(addr, { at: Number(at) || null, cmd: commandName(cmd ?? "", name) });
      }
    }
    const sig = JSON.stringify([...next].sort((x, y) => x[0].localeCompare(y[0])));
    if (sig === this.procSig) return;
    const first = this.procSig === undefined, now = Date.now();
    if (!first) for (const a of new Set([...this.procs.keys(), ...next.keys()])) if (this.procs.has(a) !== next.has(a)) this.stamp(a, "ran", now);
    this.saveStamps();
    this.procSig = sig;
    this.procs = next;
    cx.notify();
  }

  stamp(addr, key, at) {
    (this.stamps[addr] ??= {})[key] = at;
    this.stampsDirty = true;
  }

  // Ended terminals are dropped. Only once the core has listed some: right after a start the list is empty.
  saveStamps() {
    if (!this.stampsDirty) return;
    this.stampsDirty = false;
    const live = new Set(terminals().filter((k) => k.state === "live").map((k) => k.address));
    if (live.size) for (const k of Object.keys(this.stamps)) if (!live.has(k)) delete this.stamps[k];
    localStorage.setItem("terms", JSON.stringify(this.stamps));
  }

  // Claude's sub-agents under the agent or live terminal running them, shaped like terminals() entries for tree().
  claudeKids(list, terms) {
    return [...this.subs].flatMap(([t, cs]) => {
      const a = list.find((x) => x.address === t) ?? terms.find((x) => x.address === t && x.state === "live");
      return a ? cs.map((c) => ({
        address: `${t}:${c.id}`, parent: t, state: "live", status: "working",
        name: this.descs.get(c.id) || c.type || "Sub-agent", program: a.program, pane: a.pane ?? null, claude: true,
      })) : [];
    });
  }

  lookup(cx) {
    if (this.looking || !(this.want.size || this.recheck.size)) return;
    const list = [...new Set([...this.want, ...this.recheck])];
    this.want.clear();
    this.recheck.clear();
    this.looking = true;
    cx.spawn(async (cx) => {
      for (const key of list) {
        const [on, cwd] = JSON.parse(key);
        const common = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
        const top = common && (await git(cwd, ["rev-parse", "--show-toplevel"], on));
        const main = common?.replace(/\/\.git$/, "");
        this.checkouts.set(key, top ? { main, linked: top.replace(/\/+$/, "") !== main } : null);
      }
      localStorage.setItem("checkouts", JSON.stringify([...this.checkouts].slice(-200)));
      this.looking = false;
      cx.notify();
    });
  }

  // personal: the agent's project (by its checkout's main repo, on its machine), branch (the projects host's cached checkout,
  // else Herdr's, else the folder name), and whether it's a linked worktree.
  where(a) {
    const pane = panes().find((p) => p.pane === a.pane);
    const cwd = pane?.cwd, on = machineOf(a.address), key = JSON.stringify([on, cwd]);
    if (!cwd) return null;
    if (!this.checkouts.has(key)) { this.want.add(key); return null; }
    const c = this.checkouts.get(key);
    const local = (f) => (on ? f : expand(f));
    const p = this.projects.find((x) => (x.machine ?? null) === on && (c ? slash(local(x.folder)) === c.main : inside(cwd, local(x.folder))));
    if (!p) return null;
    if (!c) return { p, branch: null, linked: false };
    // The projects host keys its checkouts by the folder with slashes.
    const co = globalThis.__wranglerProjects?.memo.get(`co|${on ?? ""}|${slash(cwd)}`)?.v;
    return { p, branch: co?.branch || pane.branch || cwd.split(/[\\/]/).filter(Boolean).pop(), linked: c.linked };
  }

  // personal: an agent on another machine: a server icon, its name on hover.
  remote(t, a, machine) {
    return div().id(`on-${a.address}`).flex_none().text_color(t.dim).tooltip(`On ${machine}`).child(svg("mods/workspace-chrome/server.svg").size(11));
  }

  branchLine(t, w) {
    return h_flex().gap(5).items_center().text_size(11.5).text_color(t.dim)
      .child(svg("mods/workspace-chrome/branch.svg").size(12).flex_none())
      .child(div().flex_1().min_w(0).truncate().child(w.branch));
  }

  // personal: a card's state on its top line: Working 3m, Needs you, Done, or how long it has been idle.
  badge(t, st, ms) {
    const label = (color, icon, text) => h_flex().flex_none().gap(4).items_center().text_size(11.5).text_color(color).child(icon).child(text);
    if (st === "working") return label(t.working, svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().spin(900), `Working ${ms == null ? "" : duration(ms)}`.trim());
    if (st === "blocked") return this.status(t, { status: "blocked" });
    if (st === "done") return label(t.done, svg("mods/workspace-chrome/circle-check.svg").size(12).flex_none(), "Done");
    return div().flex_none().text_size(11.5).text_color(t.dim).child(ms == null ? "idle" : ago(ms));
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  setPins(pins) {
    this.pins = pins;
    localStorage.setItem("pins", JSON.stringify(pins));
  }

  // Drops pins of agents that ended. Only for machines the list has heard from:
  // right after a start, or while a machine connects, its agents aren't listed yet.
  prunePins(all) {
    const machine = (addr) => (addr.includes("/") ? addr.split("/")[0] : "");
    const heard = new Set(all.map((k) => machine(k.address)));
    const live = new Set(all.filter((k) => k.state === "live").map((k) => k.address));
    const kept = this.pins.filter((p) => !heard.has(machine(p)) || live.has(p));
    if (kept.length !== this.pins.length) this.setPins(kept);
  }

  // genz: when an agent was settled and at which turn ([ms, turn]), or null. A label just written counts at once.
  settledAt(a, term) {
    const v = this.pending[a.address] ?? term.get(a.address)?.labels?.settled;
    return v ? v.split(":").map(Number) : null;
  }

  // Shown at once; the label comes back from the core a moment later and every Herdr client sees it.
  setSettled(addr, value, cx) {
    this.pending[addr] = value;
    cx.spawn(async (cx) => {
      const r = await hc(["label", addr, `settled=${value}`]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code === 0) return;
      delete this.pending[addr];
      notify({ title: "Couldn't update the agent", body: String(r.stderr ?? "").trim(), level: "error" });
      cx.notify();
    });
  }

  settle(a, term, cx) {
    this.setSettled(a.address, `${Date.now()}:${term.get(a.address)?.turn ?? 0}`, cx);
  }

  // Back from the shelf it's news again, and its idle clock starts over (else it would settle again at once).
  unsettle(a, cx) {
    this.setSettled(a.address, "", cx);
    this.revived[a.address] = Date.now();
    localStorage.setItem("revived", JSON.stringify(this.revived));
  }

  // Closes the agent's pane (which ends its terminal), or its space when it's the only pane there.
  closeAgent(a) {
    const all = spaces();
    const n = all.find((x) => x.id === a.space)?.tabs.reduce((k, tb) => k + tb.panes, 0) ?? 2;
    // Closing the last space would quit the app: leave a shell tab there instead.
    if (n <= 1 && all.length <= 1) run("tab.new", { space: a.space });
    if (n <= 1 && all.length > 1) run("space.close", { id: a.space, confirmed: true });
    else run("pane.close", { pane: a.pane });
  }

  saveParked() {
    localStorage.setItem("parked", JSON.stringify(this.parked));
  }

  // genz: Park. Writes down how to start the agent again, then closes its pane. False when it can't be resumed (an
  // agent we have no resume command for, one on another machine, or no folder known).
  park(a, title) {
    if (!canPark(a)) return false;
    const cwd = panes().find((p) => p.pane === a.pane)?.cwd || spaces().find((s) => s.id === a.space)?.folder;
    if (!cwd) return false;
    this.parked = [{
      id: `${a.address}-${Date.now()}`, title: title || clean(a.title) || a.tab_name || a.program?.name || a.address,
      app: a.app, key: a.program?.key, name: a.program?.name, icon: a.program?.icon, tint: a.program?.tint,
      cwd, space: a.space, spaceName: a.space_name, at: Date.now(),
    }, ...this.parked];
    this.saveParked();
    this.closeAgent(a);
    return true;
  }

  // genz: Resume. A new tab in the agent's old space (else a new space in its folder) running its resume command.
  async resume(e) {
    const spec = specOf(e);
    if (!spec) return notify({ title: "Can't resume", body: `No resume command for ${e.name ?? "this agent"}.`, level: "error" });
    const known = await knownAgents().catch(() => []);
    const exe = known.find((k) => k.key === e.key)?.run?.[0] ?? spec.exe;
    // Other agents (running or parked) in that folder: use the agent's own picker, "the latest" could be one of them.
    const others = panes().filter((p) => p.terminal && p.program?.agent && sameDir(p.cwd, e.cwd)).length
      + this.parked.filter((x) => x.id !== e.id && sameDir(x.cwd, e.cwd)).length;
    const argv = [exe, ...(others > 0 ? spec.pick : spec.cont)];
    const sp = spaces().find((s) => s.id === e.space);
    if (sp) { run("tab.new", { space: sp.id, folder: e.cwd, name: e.title, argv }); run("space.select", { id: sp.id }); }
    else run("space.new", { folder: e.cwd, tab: e.title, argv });
    this.forget(e);
  }

  forget(e) {
    this.parked = this.parked.filter((x) => x.id !== e.id);
    this.saveParked();
  }

  // The agent, or anything under it, is working or needs the person.
  busy(a, all, listed) {
    return BUSY.has(a.status) || this.tree(all, a.address).some((s) => BUSY.has(kidStatus(s.t, listed)));
  }

  // genz: the core's stamp (`hc get`: status_ms) of when an idle agent went idle, kept per local state change, so an agent
  // idle for days before this mod ever saw it counts from the day it stopped. Asked only for idle agents, once per change.
  async coreStamps(list) {
    for (const a of list) {
      if (a.status !== "idle") continue;
      const key = this.changed[a.address]?.at ?? 0;
      if (this.core[a.address]?.key === key) continue;
      const r = await hc(["get", a.address, "--json"]).catch(() => null);
      let ms = null;
      try { ms = JSON.parse(r.stdout).status_ms ?? null; } catch {}
      this.core[a.address] = { key, ms };
    }
  }

  autoSettle(cx) {
    cx.spawn(async (cx) => {
      await this.coreStamps(agents());
      cx.notify();
      const days = settleDays(), park = parkDays();
      if (!days && !park) return;
      const list = agents(), terms = terminals(), now = Date.now();
      const listed = new Map(list.map((a) => [a.address, a.status]));
      const all = [...terms, ...this.claudeKids(list, terms)];
      const term = new Map(terms.map((k) => [k.address, k]));
      for (const a of list) {
        if (!days || a.status !== "idle" || a.focused || this.pins.includes(a.address) || this.settledAt(a, term)) continue;
        if (this.busy(a, all, listed)) continue;
        const at = this.since(a);
        if (at && now - at >= days * 86400000) this.settle(a, term, cx);
      }
      // genz: settled for parkDays() days (default off): taken out of memory, kept on the shelf to resume.
      for (const a of list) {
        const s = park && a.status === "idle" && !a.focused && !this.pins.includes(a.address) ? this.settledAt(a, term) : null;
        if (s && now - s[0] >= park * 86400000 && !this.busy(a, all, listed)) this.park(a);
      }
      cx.notify();
    });
  }
  since(a) {
    // genz: when it went idle by the core's stamp if known, else when this mod first saw the state; un-settling restarts the clock.
    const c = this.core[a.address], seen = this.changed[a.address]?.at ?? 0;
    const base = a.status === "idle" && c && c.key === seen && c.ms ? c.ms : seen;
    return Math.max(base, this.revived[a.address] ?? 0);
  }
  // Looking at a done agent makes it idle; it stays with Done until you leave
  // it rather than drop away under you. Any other change moves it at once.
  hold(list) {
    const cur = list.find((a) => a.focused);
    const same = cur && cur.address === this.held?.address;
    // Arriving, or any change but done turning idle, sets what it was.
    if (!same || cur.status !== "idle") this.held = cur ? { address: cur.address, rank: RANK[cur.status] ?? 0 } : null;
  }

  rank(a) {
    const sawDone = a.address === this.held?.address && this.held.rank === RANK.done && a.status === "idle";
    return sawDone ? RANK.done : RANK[a.status] ?? 0;
  }

  sortMenu(t) {
    const on = sortOf().id;
    return v_flex()
      .w_full()
      .p(5)
      .bg(t.popover)
      .text_size(12.8)
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Sort agents"))
      .children(SORTS.map((s) => h_flex()
        .id(`sort-${s.id}`)
        .h(31)
        .px(8)
        .gap(9)
        .rounded(7)
        .items_center()
        .text_color(t.foreground)
        .hover((el) => el.bg(t.hover))
        .on_click(() => {
          setShared("agents.sort", s.id);
          closeOverlay(props().overlay);
        })
        .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(14).flex_none().text_color(t.muted))
        .child(div().flex_1().child(s.label))
        .when(s.id === on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(14).flex_none().text_color(t.foreground)))));
  }

  peek(addr) {
    // personal: our peek (projects.peek), with go to / close keys on its bar.
    run(`projects.peek:${addr}`);
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  // personal: plain rows under the card's title, indented by depth; Claude's own sub-agents get the bot icon.
  subRow(t, s, shown, compact) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = k.claude ? svg("mods/genz-agents/bot.svg").size(12).flex_none().text_color(t.dim) : icon(k.program, 12, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(48 + 12 * (s.lines.length - 1))
      .pr(10)
      .rounded(6)
      .h(22)
      .flex_none()
      .gap(6)
      .items_center()
      .text_size(12)
      .hover((s) => s.bg(t.hover))
      // personal: a Claude sub-agent has no terminal: its parent shows it.
      .on_click(() => (k.claude && k.pane ? run("pane.focus", { pane: k.pane }) : this.peek(k.claude ? k.parent : k.address)))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_1().truncate().text_color(on ? t.foreground : t.muted).child(k.name || k.template || k.program?.name || k.address))
      .child(this.status(t, { status: st }, compact));
  }

  // compact: a ! for blocked where a header already says "Needs you".
  status(t, a, compact = false) {
    const color = t[a.status] ?? t.dim;
    if (a.status === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).mx(1).flex_none().text_color(t.working).spin(900);
    if (a.status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
    if (a.status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
    // Idle: a ring; done: a dot.
    if (a.status === "idle") return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
    return div().size(7).mx(3).flex_none().rounded(4).bg(a.status === "done" ? color : t.dim + "00");
  }

  render(cx) {
    const t = theme();
    if (props()?.sortMenu) return this.sortMenu(t);
    const collapsed = narrow();
    const sort = sortOf();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const terms = terminals();
    const all = [...terms, ...this.claudeKids(list, terms)];
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    this.hold(list);
    const byPriority = sort.id === "priority";
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    if (byPriority) list = [...list].sort((x, y) => rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    this.prunePins(all);
    // genz: Settled agents leave the lists and wait on their own shelf below. New work brings one back: it is busy
    // again, or a turn ended since it was settled. A pinned agent stays up with the pins.
    const term = new Map(terms.map((k) => [k.address, k]));
    for (const [k, v] of Object.entries(this.pending)) if (!term.has(k) || (term.get(k).labels?.settled ?? "") === v) delete this.pending[k];
    for (const a of list) {
      const s = this.settledAt(a, term);
      if (s && (this.busy(a, all, this.listed) || (term.get(a.address)?.turn ?? 0) > s[1])) this.unsettle(a, cx);
    }
    const every = list;
    const settled = list.filter((a) => this.settledAt(a, term) && !this.pins.includes(a.address))
      .sort((x, y) => this.settledAt(y, term)[0] - this.settledAt(x, term)[0] || x.address.localeCompare(y.address));
    const away = new Set(settled.map((a) => a.address));
    list = list.filter((a) => !away.has(a.address));
    if (!this.swept && every.length) { this.swept = true; this.autoSettle(cx); }
    const pinned = this.pins.map((p) => list.find((a) => a.address === p)).filter(Boolean);
    const rest = list.filter((a) => !this.pins.includes(a.address));
    list = [...pinned, ...rest];
    setAgentOrder(list.map((a) => a.address));
    // genz: where an agent really is: its terminal's live folder. A Claude started after a `cd` sits in a tab of another
    // folder's space, so a card goes by the folder it runs in (else its space's name). genz-spaces moves such a tab to the
    // space of its folder a few seconds after the folder settles; until then (or where it can't: a tab with splits, a
    // space's only tab, another machine) the card already says the right place.
    const tabs = spaces().flatMap(s => s.tabs);
    const ps = panes();
    const low = (x) => slash(x).replace(/\/+$/, "").toLowerCase();
    const dirName = (f) => slash(f).split("/").filter(Boolean).pop() ?? f;
    const folderOf = (a) => ps.find((p) => p.pane === a.pane)?.cwd ?? null;
    const spaceFolder = new Map(spaces().map((s) => [s.id, s.folder]));
    const astray = (a) => {
      const f = folderOf(a), r = spaceFolder.get(a.space);
      return Boolean(f && r && !a.address.includes("/") && !inside(low(f), low(r)));
    };
    const ctxOf = (a, w) => w?.p.name ?? (astray(a) ? dirName(folderOf(a)) : a.space_name) ?? "";
    // genz: a card names its project (else space) only while the list holds more than one, so a list that is all
    // one place shows one-line cards; a branch or another machine still gets the second line.
    const oneCtx = new Set(list.map((a) => ctxOf(a, this.where(a)))).size <= 1;
    const nBlocked = list.filter((a) => a.status === "blocked").length;
    const nWorking = list.filter((a) => a.status === "working").length;

    const ids = this.projects.map((x) => x.id);
    const dot = (a, w) => {
      if (w) return hue(w.p, ids);
      // genz: an agent away from its space's folder gets a color from the folder it is in.
      if (astray(a)) return Object.values(MARK)[[...dirName(folderOf(a))].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 6];
      const c = shared("space.colors")?.[a.space];
      return c ? (c.startsWith("#") ? c : (MARK[c] ?? theme()[c])) : t.dim;
    };
    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs);
      if (this.isFolded(a.address, subs)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown, byPriority))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.isFolded(a.address, subs);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          if (open) { this.folded.add(a.address); this.opened.delete(a.address); }
          else { this.folded.delete(a.address); this.opened.add(a.address); }
          cx.notify();
        })
        // personal: the bot icon and how many, open or folded.
        .tooltip(open ? "Hide sub-agents" : "Show sub-agents")
        .child(svg("mods/genz-agents/bot.svg").size(12).flex_none())
        .child(String(subs.length));
    };

    // A row reads "space \u00b7 detail": the detail is a tab someone named or the
    // agent's own title, never an automatic tab number unless two rows would
    // otherwise read the same.
    // genz: a tab nobody named is called by its number, and an agent there that hasn't said anything yet (a Claude just
    // opened, before its first message) would read "3". It reads "Claude Code · oot" instead: the program and the
    // folder it runs in.
    const fresh = (a) => [a.program?.name, folderOf(a) ? dirName(folderOf(a)) : ""].filter(Boolean).join(" · ") || a.address;
    const label = (a) => {
      const tab = tabs.find(tab => tab.id === a.tab);
      const l = tab ? title(tab, lead(tab, ps)) : a.title || a.program?.name || "";
      return /^\d+$/.test(l) ? fresh(a) : l;
    };
    const detail = new Map(every.map(a => [a.address, /^\d+$/.test(label(a)) ? null : label(a)]));
    const seen = {};
    for (const a of every) { const k = `${a.space_name}\u0000${detail.get(a.address) ?? ""}`; seen[k] = (seen[k] ?? 0) + 1; }
    for (const a of every) {
      if (detail.get(a.address) == null && seen[`${a.space_name}\u0000`] > 1) detail.set(a.address, label(a));
    }

    // The card's (and the settled row's) title. genz: a named tab's name when this is the tab's agent, so the card, the
    // tab and its Pokémon read the same (genz-tabs keeps an auto-named tab following the agent's own title). Else a
    // Claude session's own title, else the tab's name or the agent's title.
    const headOf = (a) => {
      const tab = tabs.find((x) => x.id === a.tab);
      if (tab?.named && tab.name && lead(tab, ps)?.pane === a.pane) return tab.name;
      const sub = /claude/i.test(a.app ?? "") ? clean(a.title) : "";
      return (sub && sub !== a.program?.name ? sub : null) ?? detail.get(a.address) ?? (label(a) || a.program?.name || a.address);
    };
    // personal: closes the agent's pane, or its space when it's the only pane there. Cards and Settled rows share it.
    const closer = (a, tip = "Close agent") => div()
      .id(`close-${a.address}`)
      .flex_none()
      .size(24)
      .flex()
      .items_center()
      .justify_center()
      .rounded(6)
      .text_color(t.dim)
      .cursor_pointer()
      .hover((s) => s.bg(t.blocked + "26").text_color(t.blocked))
      .tooltip(tip)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        const all = spaces();
        const n = all.find((x) => x.id === a.space)?.tabs.reduce((k, tb) => k + tb.panes, 0) ?? 2;
        // Closing the last space would quit the app: leave a shell tab there instead.
        if (n <= 1 && all.length <= 1) run("tab.new", { space: a.space });
        if (n <= 1 && all.length > 1) run("space.close", { id: a.space, confirmed: true });
        else run("pane.close", { pane: a.pane });
        this.hovered = null;
        cx.notify();
      })
      .child(svg("mods/workspace-chrome/x.svg").size(14));
    // genz: put a finished agent away. Settling alone keeps it running (and its memory, ~500 MB for a Claude Code),
    // so an agent we can start again is parked right away: its terminal closes and the shelf keeps how to resume it.
    // One we can't resume (no resume command, another machine) is only settled.
    const settler = (a) => {
      const parks = canPark(a);
      return div()
        .id(`settle-${a.address}`)
        .flex_none()
        .size(24)
        .flex()
        .items_center()
        .justify_center()
        .rounded(6)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.done))
        .tooltip(parks ? "Settle and park: close it to free its memory, resume it from the shelf" : "Settle")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          if (!(parks && this.park(a, headOf(a)))) this.settle(a, term, cx);
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${parks ? "archive" : "circle-check"}.svg`).size(14));
    };
    const row = (a, i, subs = []) => {
      const pic = icon(a.program, 16, t.foreground);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t.muted).child(String(i + 1)))
          .child(h_flex().w(14).flex_none().items_center().justify_center().child(this.status(t, a, true)));
      }
      const when = this.since(a);
      const idle = a.status === "idle" && !a.focused;
      const isPinned = this.pins.includes(a.address);
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .size(24)
        .flex()
        .items_center()
        .justify_center()
        .rounded(6)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.setPins(isPinned ? this.pins.filter((p) => p !== a.address) : [...this.pins, a.address]);
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(14));
      // personal: idle agents close from the row: their pane, or their space when it's the only pane there.
      const close = closer(a);
      // personal: a card. Left: the agent's icon with its state as a badge on the corner. Right: the session title
      // with the time since it last changed, then a quiet line with its project (else space) and branch.
      // Under a project (or space) header the project is dropped from that line, which then only shows a branch.
      const w = this.where(a);
      const ctx = ctxOf(a, w);
      const st = rankOf(a) === RANK.done && a.status !== "blocked" ? "done" : a.status;
      const head = headOf(a);
      const hovered = this.hovered === a.address;
      const underHeader = !byPriority && !isPinned;
      const ms = when ? now - when : null;
      // The state at the end of the title line: a pill when it needs you, else a short coloured word or the time.
      const stamp = () => {
        if (st === "blocked") return this.status(t, { status: "blocked" });
        const [color, text] = st === "working" ? [t.working, ms == null ? "" : duration(ms)]
          : st === "done" ? [t.done, "Done"]
          : [t.dim, ms == null ? "" : duration(ms)];
        return div().flex_none().text_size(11).text_color(color).child(text);
      };
      const ends = (el) => el
        .when(hovered, (e) => e.child(pin))
        .when(hovered && !isPinned && !this.busy(a, all, this.listed), (e) => e.child(settler(a)))
        .when(hovered && rankOf(a) === RANK.idle, (e) => e.child(div().w(1).h(14).mx(5).flex_none().bg(t.border)).child(close))
        .child(stamp());
      const cut = a.focused ? t.selected : t.chrome;
      const badge = st === "working"
        ? div().absolute().right(1).bottom(1).size(13).rounded(7).bg(cut).flex().items_center().justify_center()
          .child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900))
        : st === "blocked" || st === "done"
          ? div().absolute().right(1).bottom(1).size(11).rounded(6).bg(t[st]).border(2).border_color(cut)
          : null;
      const lead = div().relative().size(30).flex_none().rounded(8).bg(t.raised).flex().items_center().justify_center()
        .child(pic ?? svg("mods/genz-agents/bot.svg").size(16).flex_none().text_color(t.muted))
        .when(Boolean(badge), (el) => el.child(badge));
      const hideCtx = underHeader || oneCtx;
      const showMeta = !hideCtx || Boolean(w?.branch) || Boolean(machine);
      const meta = h_flex().h(16).gap(6).items_center().text_size(11.5).text_color(t.dim)
        .when(!hideCtx, (el) => el
          .child(div().size(8).flex_none().rounded(3).bg(dot(a, w)))
          .child(div().flex_shrink(1).min_w(0).truncate().text_color(t.muted).child(ctx)))
        .when(isPinned, (el) => el.child(svg("mods/workspace-chrome/pin.svg").size(11).flex_none().text_color(t.dim)))
        .when(Boolean(machine), (el) => el.child(this.remote(t, a, machine)))
        .when(Boolean(w?.branch) && !hideCtx, (el) => el.child(div().flex_none().text_color(t.dim).child("·")))
        .when(Boolean(w?.branch), (el) => el.child(this.branchLine(t, w).flex_1().min_w(0)));
      const titleLine = h_flex().h(24).gap(6).items_center()
        .child(div().id(`tt-${a.address}`).flex_1().min_w(0).truncate().text_size(13.5)
          .when(a.focused, (el) => el.font_semibold())
          .text_color(idle ? t.muted : t.foreground).tooltip(head).child(head))
        .when(subs.length > 0, (el) => el.child(fold(a, subs)))
        .child(ends(h_flex().flex_none().gap(2).items_center()));
      return h_flex()
        .id(`ag-${a.address}`)
        .relative()
        .px(8)
        .py(6)
        .gap(10)
        .items_center()
        .flex_none()
        .rounded(10)
        .when(a.focused, (el) => el.bg(t.selected))
        .when(!a.focused && st === "blocked", (el) => el.bg(t.blocked + "14").hover((s) => s.bg(t.blocked + "22")))
        .when(!a.focused && st !== "blocked", (el) => el.hover((s) => s.bg(t.hover)))
        .cursor_pointer()
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        // personal: agent menu
        .on_mouse_down("right", (e) => run(`projects.agent-menu:${a.address}@${Math.round(e.position.x)},${Math.round(e.position.y)}`))
        .when(a.focused, (el) => el.child(div().absolute().left(0).top(10).bottom(10).w(3).rounded(2).bg(t.accent)))
        .child(lead)
        .child(v_flex().flex_1().min_w(0).gap(1).child(titleLine).when(showMeta, (el) => el.child(meta)));
    };

    // Groups in list order: priority sections, or (personal) projects, else the agent's space, each where its first agent is.
    const groups = pinned.length ? [{ id: "pinned", label: "Pinned", status: null, members: pinned }] : [];
    const byId = new Map();
    for (const a of rest) {
      const r = rankOf(a) || RANK.idle;
      const w = !byPriority && this.where(a);
      // genz: an agent away from its space's folder is grouped by the folder it runs in.
      const id = byPriority ? `sec-${r}` : w ? `pr-${w.p.id}` : astray(a) ? `fo-${low(folderOf(a))}` : `sp-${a.space}`;
      if (byId.has(id)) { byId.get(id).members.push(a); continue; }
      const g = byPriority
        ? { id, label: SECTION[r], status: SECTION_STATUS[r], members: [a] }
        : { id, label: ctxOf(a, w), status: null, color: dot(a, w), members: [a] };
      byId.set(id, g);
      groups.push(g);
    }

    // A group's header; it folds the group. Folded, it says how many and the most urgent state.
    const header = (g) => {
      const open = !this.folded.has(g.id);
      const top = g.members.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);
      // personal: a section label: status dot or project tile, name, count pill, and the fold chevron at the far end.
      return h_flex()
        .id(g.id)
        .px(10)
        .pt(8)
        .h(32)
        .flex_none()
        .gap(7)
        .items_center()
        .text_size(11.5)
        .font_semibold()
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.folded.add(g.id) : this.folded.delete(g.id);
          cx.notify();
        })
        .when(Boolean(g.color), (el) => el.child(h_flex().size(14).flex_none().rounded(4).bg(g.color).items_center().justify_center()
          .text_size(9).font_bold().text_color("#ffffff").child([...g.label][0]?.toUpperCase() ?? "?")))
        .when(Boolean(g.status), (el) => el.child(div().size(7).flex_none().rounded(4).bg(t[g.status])))
        .child(div().truncate().text_color(g.status ? t[g.status] : t.muted).child(g.label))
        .when(byPriority || !open, (el) => el.child(div().flex_none().px(6).h(16).rounded(8).bg(t.hover).flex().items_center()
          .text_size(10.5).font_medium().text_color(t.dim).child(String(g.members.length))))
        .child(div().flex_1())
        .when(!open && !byPriority && top && top !== "idle", (el) => el.child(this.status(t, { status: top }, true)))
        // personal: the fold chevron shows either way, so sections read as foldable.
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim));
    };
    const capped = (g) => byPriority && BOTTOM.has(g.id) && g.members.length > LIMIT;
    const moreRow = (g) => {
      const open = this.more.has(g.id);
      return h_flex()
        .id(`more-${g.id}`)
        .px(8)
        .h(24)
        .flex_none()
        .items_center()
        .text_size(11.5)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => {
          open ? this.more.delete(g.id) : this.more.add(g.id);
          cx.notify();
        })
        .child(open ? "Show less" : `${g.members.length - LIMIT} more`);
    };
    const body = (g) => {
      if (this.folded.has(g.id)) return [];
      if (!capped(g)) return g.members.flatMap(withKids);
      const some = this.more.has(g.id) ? g.members : g.members.slice(0, LIMIT);
      return [...some.flatMap(withKids), moreRow(g)];
    };
    const section = (gs) => gs.flatMap((g) => [header(g), ...body(g)]);
    const split = byPriority && !collapsed;

    // genz: Terminals (see the notes at TERMS_FIRST). Every pane holding a terminal that isn't an agent, nor a helper an
    // agent started (those sit under their agent). Looking at one counts when you leave it, so its row doesn't jump to
    // the top under the pointer.
    const lookedAt = ps.find((p) => p.focused && p.terminal && !p.program?.agent)?.terminal ?? null;
    if (this.lookedAt !== lookedAt) {
      if (this.lookedAt) { this.stamp(this.lookedAt, "seen", now); this.saveStamps(); }
      this.lookedAt = lookedAt;
    }
    const spaceOfTab = new Map(spaces().flatMap((s) => s.tabs.map((tb) => [tb.id, s])));
    const shells = ps.filter((p) => p.terminal && !p.program?.agent && !term.get(p.terminal)?.parent).map((p) => {
      const k = term.get(p.terminal), sp = spaceOfTab.get(p.tab), tab = tabs.find((x) => x.id === p.tab);
      const fg = k?.foreground;
      // What it runs: a program started as the terminal itself (ssh, a server), the foreground program the core reports
      // (not on Windows), or what the helper found under the shell.
      const job = !p.program?.shell ? { cmd: commandName((k?.argv ?? []).map(quote).join(" "), p.program?.name), at: k?.created_ms ?? null }
        : fg?.pid && k?.pid && fg.pid !== k.pid ? { cmd: commandName((fg.argv ?? []).map(quote).join(" "), fg.name), at: null }
        : this.procs.get(p.terminal) ?? null;
      const folder = p.cwd ? dirName(p.cwd) : null;
      const elsewhere = Boolean(p.cwd && sp?.folder && !p.terminal.includes("/") && !inside(low(p.cwd), low(sp.folder)));
      const ctx = (elsewhere ? folder : sp?.name) ?? folder ?? "";
      // A tab's name counts when someone (or its agent, before it left) gave it one and this is the tab's first terminal.
      const auto = (n) => !n || /^\d+$/.test(n) || /^tb\d+$/.test(n) || n === p.terminal || n === p.program?.name;
      const named = tab && !auto(tab.name) && lead(tab, ps)?.pane === p.pane ? tab.name : null;
      const head = job?.cmd || named || folder || p.program?.name || p.terminal;
      const c = sp && shared("space.colors")?.[sp.id];
      const stamps = this.stamps[p.terminal] ?? {};
      return {
        address: p.terminal, pane: p.pane, space: sp?.id, focused: p.focused, program: p.program, branch: p.branch, job, head, ctx,
        // Under the title: where it is; a row already titled by its folder says its program instead.
        under: head === ctx ? (p.program?.name ?? "shell") : ctx,
        color: elsewhere ? Object.values(MARK)[[...ctx].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % 6]
          : c ? (c.startsWith("#") ? c : (MARK[c] ?? t[c])) : t.dim,
        tip: [head, job && named ? named : null, p.cwd].filter(Boolean).join("\n"),
        at: Math.max(stamps.seen ?? 0, stamps.ran ?? 0, k?.created_ms ?? 0),
        machine: p.terminal.includes("/") ? p.terminal.split("/")[0] : null,
      };
    });
    // A card like an agent's: the program's icon (a dot on its corner while a command runs), the title with how long
    // the command has run or since the terminal was last used, then where it is. An idle one closes from its row.
    const shellRow = (x) => {
      const hov = this.hovered === x.address;
      const busy = Boolean(x.job);
      const cut = x.focused ? t.selected : t.chrome;
      const tile = div().relative().size(30).flex_none().rounded(8).bg(t.raised).flex().items_center().justify_center()
        .child(icon(x.program, 16, busy ? t.foreground : t.muted) ?? svg("icons/shell.svg").size(16).flex_none().text_color(t.muted))
        .when(busy, (el) => el.child(div().absolute().right(1).bottom(1).size(11).rounded(6).bg(t.working).border(2).border_color(cut)));
      const stamp = busy ? (x.job.at ? duration(now - x.job.at) : "") : x.focused || !x.at ? "" : duration(now - x.at);
      const titleLine = h_flex().h(24).gap(6).items_center()
        .child(div().id(`tmt-${x.address}`).flex_1().min_w(0).truncate().text_size(13.5)
          .when(x.focused, (el) => el.font_semibold())
          .text_color(busy || x.focused ? t.foreground : t.muted).tooltip(x.tip).child(x.head))
        .child(h_flex().flex_none().gap(2).items_center()
          .when(hov && !busy, (el) => el.child(closer(x, "Close terminal")))
          .child(div().flex_none().text_size(11).text_color(busy ? t.working : t.dim).child(stamp)));
      const meta = h_flex().h(16).gap(6).items_center().text_size(11.5).text_color(t.dim)
        .child(div().size(8).flex_none().rounded(3).bg(x.color))
        .child(div().flex_shrink(1).min_w(0).truncate().text_color(t.muted).child(x.under))
        .when(Boolean(x.machine), (el) => el.child(this.remote(t, x, x.machine)))
        .when(Boolean(x.branch), (el) => el.child(div().flex_none().text_color(t.dim).child("·")).child(this.branchLine(t, x).flex_1().min_w(0)));
      return h_flex()
        .id(`tm-${x.address}`)
        .relative()
        .px(8)
        .py(6)
        .gap(10)
        .items_center()
        .flex_none()
        .rounded(10)
        .when(x.focused, (el) => el.bg(t.selected))
        .when(!x.focused, (el) => el.hover((s) => s.bg(t.hover)))
        .cursor_pointer()
        .on_hover((on, cx) => {
          if (on) this.hovered = x.address;
          else if (this.hovered === x.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: x.pane }))
        .when(x.focused, (el) => el.child(div().absolute().left(0).top(10).bottom(10).w(3).rounded(2).bg(t.accent)))
        .child(tile)
        .child(v_flex().flex_1().min_w(0).gap(1).child(titleLine).child(meta));
    };
    const busyShells = shells.filter((x) => x.job).sort((x, y) => (y.job.at ?? 0) - (x.job.at ?? 0) || x.address.localeCompare(y.address));
    const quietShells = shells.filter((x) => !x.job).sort((x, y) => y.at - x.at || x.address.localeCompare(y.address));
    const someQuiet = this.termsMore ? quietShells : quietShells.filter((x, i) => i < TERMS_FIRST || x.focused);
    // The switcher (projects-ui, projects.switch) lists the same terminals, in this order: mods share one runtime.
    // Stamped, so a list left behind by another layout isn't taken for a live one.
    globalThis.__genzTerminals = { at: now, list: [...busyShells, ...quietShells] };
    const termsHeader = () => h_flex().id("terms-header").px(10).pt(8).h(32).flex_none().gap(7).items_center().text_size(11.5).font_semibold().cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => {
        this.termsOpen = !this.termsOpen;
        localStorage.setItem("terms-open", String(this.termsOpen));
        cx.notify();
      })
      .child(svg("icons/shell.svg").size(12).flex_none().text_color(t.dim))
      .child(div().text_color(t.muted).child("Terminals"))
      .child(div().flex_none().px(6).h(16).rounded(8).bg(t.hover).flex().items_center()
        .text_size(10.5).font_medium().text_color(t.dim).child(String(shells.length)))
      .when(busyShells.length > 0, (el) => el.child(h_flex().id("terms-busy").flex_none().gap(4).items_center().text_size(10.5).font_medium().text_color(t.working)
        .tooltip(`${busyShells.length} running a command`)
        .child(div().size(6).rounded(3).bg(t.working)).child(String(busyShells.length))))
      .child(div().flex_1())
      .child(svg(`mods/workspace-chrome/chevron-${this.termsOpen ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim));
    const termsMoreRow = () => h_flex().id("terms-more").px(8).h(24).flex_none().items_center().text_size(11.5).text_color(t.dim).cursor_pointer()
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { this.termsMore = !this.termsMore; cx.notify(); })
      .child(this.termsMore ? "Show less" : `${quietShells.length - someQuiet.length} more`);
    const termRows = collapsed || shells.length === 0 ? [] : [
      termsHeader(),
      ...(this.termsOpen ? [...busyShells, ...someQuiet].map(shellRow) : []),
      ...(this.termsOpen && (this.termsMore ? quietShells.length > TERMS_FIRST : quietShells.length > someQuiet.length) ? [termsMoreRow()] : []),
    ];

    const rows = collapsed ? list.flatMap(withKids) : [...section(split ? groups.filter((g) => !BOTTOM.has(g.id)) : groups), ...termRows];
    const bottom = split ? section(groups.filter((g) => BOTTOM.has(g.id))) : [];
    this.lookup(cx);

    // genz: the Settled shelf, docked under the lists: a header (fold, count, the auto-settle pill) and slim rows, newest first.
    const days = settleDays(), park = parkDays();
    const slim = (a) => {
      const hov = this.hovered === a.address;
      const pic = icon(a.program, 14, t.muted);
      const undo = div().id(`unsettle-${a.address}`).size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Bring back")
        .on_click((_e, cx) => { cx.stop_propagation(); this.unsettle(a, cx); this.hovered = null; cx.notify(); })
        .child(svg("mods/genz-agents/undo.svg").size(14));
      // genz: Park: close the agent's terminal (frees its memory) but keep it on the shelf to resume later.
      const parkBtn = div().id(`park-${a.address}`).size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Park: close it, resume later")
        .on_click((_e, cx) => { cx.stop_propagation(); this.park(a, headOf(a)); this.hovered = null; cx.notify(); })
        .child(svg("mods/workspace-chrome/archive.svg").size(14));
      return h_flex().id(`st-${a.address}`).h(30).px(8).gap(8).flex_none().items_center().rounded(8).cursor_pointer()
        .when(a.focused, (el) => el.bg(t.selected))
        .when(!a.focused, (el) => el.hover((s) => s.bg(t.hover)))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .on_mouse_down("right", (e) => run(`projects.agent-menu:${a.address}@${Math.round(e.position.x)},${Math.round(e.position.y)}`))
        .child(h_flex().w(16).flex_none().items_center().justify_center()
          .child(pic ?? svg("mods/genz-agents/bot.svg").size(14).flex_none().text_color(t.dim)))
        .child(div().id(`stt-${a.address}`).flex_1().min_w(0).truncate().text_size(12.5)
          .text_color(a.focused ? t.foreground : t.muted).tooltip(headOf(a)).child(headOf(a)))
        .when(hov, (el) => el.child(undo).when(canPark(a), (e) => e.child(parkBtn)).child(closer(a)))
        .when(!hov, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - this.settledAt(a, term)[0]))));
    };
    // genz: a parked agent: dim row, click resumes it in a new tab; hover offers Resume and Forget.
    const pslim = (e) => {
      const hov = this.hovered === e.id;
      const pic = e.icon
        ? (e.tint ? svg(e.icon).size(14).flex_none().text_color(t.dim) : image(e.icon).w(14).h(14).flex_none())
        : svg("mods/genz-agents/bot.svg").size(14).flex_none().text_color(t.dim);
      const btn = (id, src, tip, danger, action) => div().id(`${id}-${e.id}`).size(24).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(t.dim).cursor_pointer()
        .hover((s) => s.bg(danger ? t.blocked + "26" : t.hover).text_color(danger ? t.blocked : t.foreground)).tooltip(tip)
        .on_click((_e, cx) => { cx.stop_propagation(); action(); this.hovered = null; cx.notify(); })
        .child(svg(src).size(14));
      return h_flex().id(`pk-${e.id}`).h(30).px(8).gap(8).flex_none().items_center().rounded(8).cursor_pointer().opacity(0.75)
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = e.id;
          else if (this.hovered === e.id) this.hovered = null;
          cx.notify();
        })
        .on_click(() => this.resume(e))
        .child(h_flex().w(16).flex_none().items_center().justify_center().child(pic))
        .child(div().id(`pkt-${e.id}`).flex_1().min_w(0).truncate().text_size(12.5).text_color(t.muted)
          .tooltip(`${e.title}\nParked, not running. ${e.cwd}\nClick to resume.`).child(e.title))
        .when(hov, (el) => el.child(btn("resume", "mods/genz-agents/play.svg", "Resume", false, () => this.resume(e)))
          .child(btn("forget", "mods/workspace-chrome/x.svg", "Forget (the session itself is not touched)", true, () => this.forget(e))))
        .when(!hov, (el) => el.child(h_flex().flex_none().gap(4).items_center().text_size(11).text_color(t.dim)
          .child(svg("mods/workspace-chrome/archive.svg").size(11)).child(duration(now - e.at))));
    };
    // Settled agents first, then parked ones.
    const items = [...settled.map((a) => ({ a })), ...this.parked.map((e) => ({ e }))];
    const shelf = () => {
      const open = this.settledOpen;
      const shownRows = (this.settledMore ? items : items.slice(0, SETTLED_FIRST)).map((it) => (it.a ? slim(it.a) : pslim(it.e)));
      // genz: the park/auto pills show only while the header is hovered, so it reads like the other group headers.
      const header = h_flex().id("settled-header").h(32).px(10).gap(7).flex_none().items_center().text_size(11.5).font_semibold().cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_hover((on, cx) => {
          if (this.settledHover === on) return;
          this.settledHover = on;
          cx.notify();
        })
        .on_click((_e, cx) => {
          this.settledOpen = !this.settledOpen;
          localStorage.setItem("settled-open", String(this.settledOpen));
          cx.notify();
        })
        .child(svg("mods/workspace-chrome/circle-check.svg").size(12).flex_none().text_color(t.dim))
        .child(div().text_color(t.muted).child("Settled"))
        .child(div().flex_none().px(6).h(16).rounded(8).bg(t.hover).flex().items_center()
          .text_size(10.5).font_medium().text_color(t.dim).child(String(settled.length + this.parked.length)))
        .child(div().flex_1())
        .when(Boolean(this.settledHover), (el) => el.child(div().id("park-days").flex_none().px(6).h(16).rounded(8).flex().items_center().text_size(10.5).font_medium()
          .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(park ? `Auto-settled agents are closed after ${park} day${park > 1 ? "s" : ""} and kept here to resume. Click to change.` : "Auto-settled agents stay running. Click to have them parked (closed, resumable) after some days.")
          .on_click((_e, cx) => {
            cx.stop_propagation();
            setShared("agents.parkDays", PARK_CHOICES[(PARK_CHOICES.indexOf(park) + 1) % PARK_CHOICES.length]);
            cx.notify();
          })
          .child(park ? `park ${park}d` : "park off"))
        .child(div().id("settle-days").flex_none().px(6).h(16).rounded(8).flex().items_center().text_size(10.5).font_medium()
          .text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(days ? `Settles agents idle for ${days} day${days > 1 ? "s" : ""}. Click to change.` : "Auto-settle is off. Click to change.")
          .on_click((_e, cx) => {
            cx.stop_propagation();
            setShared("agents.settleDays", SETTLE_CHOICES[(SETTLE_CHOICES.indexOf(days) + 1) % SETTLE_CHOICES.length]);
            cx.notify();
          })
          .child(days ? `auto ${days}d` : "auto off")))
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim));
      const more = h_flex().id("settled-more").px(8).h(24).flex_none().items_center().text_size(11.5).text_color(t.dim).cursor_pointer()
        .hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.settledMore = !this.settledMore; cx.notify(); })
        .child(this.settledMore ? "Show less" : `${items.length - SETTLED_FIRST} more`);
      return v_flex().id("ag-settled").flex_none().px(8).border_t(1).border_color(t.border)
        .child(header)
        .when(open && items.length === 0, (el) => el.child(div().px(10).pb(10).text_size(11.5).text_color(t.dim)
          .child(days ? `Nothing yet. Agents idle for ${days}d land here.` : "Nothing yet. Settle an agent from its card.")))
        .when(open && items.length > 0, (el) => el.child(v_flex().id("ag-settled-rows").gap(1).pb(6).max_h(SETTLED_MAX_H).overflow_y_scroll()
          .children([...shownRows, ...(items.length > SETTLED_FIRST ? [more] : [])])));
    };

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      // genz: the rule over this list only separates it from Spaces when both show.
      .when(listShown() === null, (el) => el.border_t(1).border_color(t.border))
      .text_size(13)
      // personal: switcher, sort and new agent on the header; in the rail, the Spaces switch and new agent on top.
      // genz: the Spaces | Agents switch (with live counts of what needs you / is working), search, a two-way view switch, new agent.
      .when(!collapsed, (el) => el.child(h_flex().pl(10).pr(10).h(38).pt(6).flex_none().items_center().gap(4)
        .text_size(12).font_semibold().text_color(t.muted)
        .child(listSwitch("agents", t, { spaces: spaces().length, blocked: nBlocked, working: nWorking }))
        .child(div().flex_1())
        .child(headerButton("ag-find", "mods/workspace-chrome/search.svg", "Switch agent or terminal (⌃⇧A)", t, () => run("projects.switch")))
        .child(h_flex().gap(1).p(2).mx(2).rounded(7).bg(t.hover).children(SORTS.map((s) => {
          const on = s.id === sort.id;
          return div().id(`seg-${s.id}`).size(20).flex_none().flex().items_center().justify_center().rounded(5)
            .text_color(on ? t.foreground : t.dim)
            .when(on, (e) => e.bg(t.raised))
            .when(!on, (e) => e.hover((x) => x.text_color(t.foreground)))
            .tooltip(s.label).on_click(() => setShared("agents.sort", s.id))
            .child(svg(`mods/workspace-chrome/${s.icon}.svg`).size(13));
        })))
        .child(headerButton("ag-new", "mods/workspace-chrome/square-pen.svg", "New agent", t, () => run("projects.compose")))))
      .when(collapsed, (el) => el.child(v_flex().pt(7).pb(7).gap(6).flex_none().items_center()
        .child(railSwitch("agents", t))
        .child(headerButton("ag-new", "mods/workspace-chrome/square-pen.svg", "New agent", t, () => run("projects.compose")))))
      .when(list.length === 0 && !collapsed, (el) =>
        el.child(div().px(16).py(6).text_size(12).text_color(t.dim).child("No agents yet. Start one with the pen above.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).gap(2).px(collapsed ? 0 : 8).overflow_y_scroll().children(rows))
      // personal: the working tray is docked under the list with its own rule, so it reads as a place rather than a leftover.
      .when(bottom.length > 0, (el) => el.child(v_flex().id("ag-bottom").flex_shrink_1().min_h(0).gap(2).px(8).pb(6).border_t(1).border_color(t.border).overflow_y_scroll().children(bottom)))
      // genz: the Settled shelf sits last, under the working tray.
      .when(!collapsed, (el) => el.child(shelf()))
      .when(collapsed, (el) => el.child(
        h_flex().h(28).items_center().justify_center().child(
          div().id("collapse").text_size(13).text_color(t.dim).hover((s) => s.text_color(t.foreground)).on_click(toggleSidebar).child("»"))));
  }
}
