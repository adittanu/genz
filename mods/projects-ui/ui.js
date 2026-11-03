// What projects-ui's views share: the projects host's cache (globalThis.__wranglerProjects, filled by the
// always-loaded projects mod), the host's commands, and small drawing helpers. Kept small on purpose: Herdr
// loads a fresh copy of an overlay's modules on every open and never frees it.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex, Popup } from "gpui-base";
import { closeOverlay, home, panes, run, shared, spaces, theme } from "herdr";

export const ICON = (name) => `mods/workspace-chrome/${name}.svg`;

const C = () => globalThis.__wranglerProjects ?? null;
export const allProjects = () => C()?.known?.projects ?? [];
export const projects = () => allProjects().filter((p) => p.id && p.folder);
const peek = (key) => C()?.memo.get(key)?.v;
/** Agent addresses, most recently focused first (kept by the host). */
export const mru = () => C()?.mru ?? [];

export const expand = (p) => (p === "~" || p?.startsWith("~/") ? home() + p.slice(1) : p);
export const tilde = (p) => (p === home() || p?.startsWith(home() + "/") ? "~" + p.slice(home().length) : p);
const base = (p) => p.replace(/\/+$/, "").split("/").pop();

/** A folder's cached checkout { top, main, linked, branch } (null outside git), undefined when not read yet. */
export const checkoutOf = (cwd, on = null) => peek(`co|${on ?? ""}|${cwd}`);
/** A project's cached bases (see the host's bases()), undefined when not read yet. */
export const basesOf = (project, src) => peek(`bases|${project.machine ?? ""}|${expand(project.folder)}|${src ?? ""}`);

/** A bases' refs with "Current HEAD" first: one shared array per bases object (closed overlays stay in memory). */
export function headed(b) {
  const w = C()?.headed;
  let a = w?.get(b);
  if (!a) { a = [{ name: "HEAD", head: true, at: 0 }, ...b.refs]; w?.set(b, a); }
  return a;
}

/** Where a space is now: its first terminal's live folder, else where it was made. */
export function place(s, ps = panes()) {
  const tabs = new Set((s.tabs ?? []).map((t) => t.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}

const inside = (p, root) => !!p && (p === root || p.startsWith(root + "/"));

/** The open space shown for a project: one at its folder, else one inside it. */
export function shownSpace(project, sp = spaces(), ps = panes()) {
  const root = expand(project.folder);
  const all = sp.filter((s) => (s.machine ?? null) === (project.machine ?? null) && inside(place(s, ps), root));
  return all.find((s) => place(s, ps) === root) ?? all[0] ?? null;
}

/** The saved project of a space's folder from the cache: null when none, undefined when not read yet. */
export function savedOf(s) {
  if (!s) return null;
  const co = checkoutOf(place(s), s.machine);
  if (co === undefined || !C()?.known) return undefined;
  return projects().find((x) => (x.machine ?? null) === (s.machine ?? null) && expand(x.folder) === (co?.top ?? place(s))) ?? null;
}

/** A space's checkout and its project from the cache: { project, saved, src, branch }, null outside git,
 *  undefined when not read yet. An unsaved repo gets a draft project (defaultBase null). */
export function ownerOf(s) {
  const co = checkoutOf(place(s), s.machine);
  if (co === undefined || !C()?.known) return undefined;
  if (!co) return null;
  const on = s.machine ?? null, all = allProjects();
  const saved = all.find((x) => (x.machine ?? null) === on && expand(x.folder) === co.main);
  if (saved) return { project: saved, saved: true, src: co.top, branch: co.branch };
  const name = base(co.main), taken = all.map((x) => x.id);
  let id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
  for (let n = 2; taken.includes(id); n++) id = `${id.replace(/-\d+$/, "")}-${n}`;
  return { project: { id, name, folder: tilde(co.main), machine: on, defaultBase: null, layout: null }, saved: false, src: co.top, branch: co.branch };
}

const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

/** A space's avatar color, or null when it has none yet. */
export function spaceHue(id) {
  const c = shared("space.colors")?.[id];
  return c ? (c.startsWith("#") ? c : (MARK[c] ?? theme()[c])) : null;
}

/** A project's color: its open space's avatar color, else one by its position in the list. sp/ps: a snapshot. */
export function hue(p, sp, ps) {
  const s = shownSpace(p, sp, ps);
  const c = s && spaceHue(s.id);
  if (c) return c;
  const all = Object.values(MARK);
  return all[Math.max(0, allProjects().findIndex((x) => x.id === p.id)) % all.length];
}

export const badge = (p, sp, ps) => h_flex().size(18).flex_none().rounded(5).bg(hue(p, sp, ps)).items_center().justify_center()
  .text_size(10.5).font_bold().text_color("#ffffff").child([...p.name][0]?.toUpperCase() ?? "?");

export function summary(p) {
  const tabs = p.layout?.tabs ?? [];
  if (!tabs.length) return "";
  const count = (n) => (n.split ? n.children.reduce((a, c) => a + count(c), 0) : 1);
  const n = tabs.reduce((a, t) => a + count(t.root), 0);
  return tabs.length > 1 ? `${tabs.length} tabs` : n > 1 ? `${n} panes` : "1 pane";
}

export const ago = (s) => {
  const d = Date.now() / 1000 - s;
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};

export const worktreePath = (root, branch) => `${root}/${branch.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")}`;

/** A list that builds only its max visible rows (a virtual list keeps state for every item, and Herdr keeps
 *  closed overlays with it). st: the view's { off, acc }; row(i) draws item i, rowH tall; the wheel scrolls. */
export function windowed(t, id, st, n, max, rowH, row) {
  const h = rowH * Math.min(n, max);
  st.off = Math.max(0, Math.min(st.off ?? 0, n - max));
  const rows = [];
  for (let i = st.off; i < Math.min(n, st.off + max); i++) rows.push(row(i));
  return v_flex().id(id).relative().flex_none().h(h).overflow_hidden()
    .on_scroll_wheel((ev, cx) => {
      st.acc = (st.acc ?? 0) + (ev.delta_lines ? ev.delta_lines.y * rowH : ev.delta.y);
      const step = Math.trunc(st.acc / rowH);
      if (!step) return;
      st.acc -= step * rowH;
      st.off = Math.max(0, Math.min(st.off - step, n - max));
      cx.notify();
    })
    .children(rows)
    .when(n > max, (el) => el.child(div().absolute().right(0).w(3).rounded(2).bg(t.border)
      .top(Math.round(h * st.off / n)).h(Math.max(12, Math.round(h * max / n)))));
}

/** Scrolls a windowed list (st, max rows) just enough to show item k. */
export const reveal = (st, k, max) => { if (k >= 0) st.off = Math.min(k, Math.max(st.off ?? 0, k - max + 1)); };

/** A dropdown field: a focusable trigger and a list that opens over the dialog. The list takes the keyboard
 *  itself (an input would swallow the arrows and Esc), the filter shows in the trigger: type to filter, backspace, ↑↓, ↵ or tab picks, esc
 *  closes. Closed, ↓ or space on the trigger opens it. items(filter) lists what to show; pick(item, cx) takes
 *  the choice; current() is the picked item's index in items(""). */
export class Dropdown {
  constructor(cx, { placeholder, items, pick, current = () => -1, max = 8, rowH = 28 }) {
    Object.assign(this, { placeholder, items, pickFn: pick, current, max, rowH, open: false, at: 0, list: { off: 0 }, filter: "", shut: 0 });
    this.trigger = cx.focus_handle();
    this.panel = cx.focus_handle();
  }
  shown() { return this.items(this.filter.trim().toLowerCase()); }
  show(cx) {
    this.open = true;
    this.filter = "";
    this.list.off = 0;
    this.sync(true);
    this.panel.focus();
    cx.notify();
  }
  hide(cx) { this.open = false; this.shut = Date.now(); this.trigger.focus(); cx.notify(); }
  /** Moves the highlight to the picked item (items arrived after it opened). */
  sync(force) {
    if (!this.open || (this.filter && !force)) return;
    this.at = Math.max(0, this.current());
    reveal(this.list, this.at, this.max);
  }
  choose(i, cx) {
    const it = this.shown()[i];
    if (!it) return;
    this.open = false;
    this.trigger.focus();
    this.pickFn(it, cx);
    cx.notify();
  }
  /** Handles a key for the dropdown; true when it did. */
  key(e, cx) {
    if (!this.open) {
      if (!this.trigger.is_focused() || !(e.key === "down" || e.key === "space")) return false;
      this.show(cx);
      return true;
    }
    const n = this.shown().length, m = e.modifiers ?? {};
    if (e.key === "down" || e.key === "up") {
      if (n) this.at = (this.at + (e.key === "down" ? 1 : n - 1)) % n;
    } else if (e.key === "enter" || e.keystroke === "tab") return this.choose(this.at, cx), true;
    else if (e.key === "escape") return this.hide(cx), true;
    else if (e.key === "backspace") this.filter = this.filter.slice(0, -1);
    else if (e.key_char && !m.control && !m.alt && !m.platform) this.filter += e.key_char;
    else return false;
    if (e.key !== "down" && e.key !== "up") { this.at = 0; this.list.off = 0; }
    reveal(this.list, this.at, this.max);
    cx.notify();
    return true;
  }
  /** The trigger (label: its content) with the list over the dialog under it; row(item, selected) draws an item. */
  draw(t, id, w, label, row, empty = "Nothing matches.") {
    const items = this.open ? this.shown() : [];
    const trigger = h_flex().id(`${id}-trigger`).track_focus(this.trigger).w(w).h(32).px(10).gap(8).items_center().rounded(6).border(1)
      .cursor_pointer().border_color(this.open || this.trigger.is_focused() ? t.accent : t.input).bg(t.background).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { if (this.open) this.hide(cx); else if (Date.now() - this.shut > 250) this.show(cx); })
      .child(h_flex().flex_1().min_w(0).gap(8).items_center().children(!this.open ? [label].flat() : [
        svg(ICON("search")).size(12).flex_none().text_color(t.dim),
        h_flex().flex_1().min_w(0).items_center()
          .when(!!this.filter, (el) => el.child(div().truncate().text_color(t.foreground).child(this.filter)))
          .child(div().w(1).h(14).flex_none().bg(t.accent))
          .when(!this.filter, (el) => el.child(div().pl(2).truncate().text_color(t.dim).child(this.placeholder))),
      ]))
      .child(svg(ICON("chevron-down")).size(11).flex_none().text_color(t.dim));
    return Popup.new(id, trigger).anchor("top_left").when(this.open, (el) => el.content(
      v_flex().id(`${id}-panel`).track_focus(this.panel).w(w).mt(4).p(4).gap(2).rounded(8).border(1).border_color(t.border).bg(t.popover).shadow_lg()
        .text_size(13)
        .on_key_down((e, cx) => { if (this.key(e, cx)) cx.stop_propagation(); })
        .on_mouse_down_out((_e, cx) => { if (this.open) this.hide(cx); })
        .when(!!items.length, (el) => el.child(windowed(t, `${id}-list`, this.list, items.length, this.max, this.rowH, (i) =>
          h_flex().id(`${id}-r-${i}`).h(this.rowH).px(8).gap(8).items_center().rounded(6).cursor_pointer()
            .when(i === this.at, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.choose(i, cx)).children([row(items[i], i === this.at)].flat()))))
        .when(!items.length, (el) => el.child(div().px(8).py(6).text_color(t.dim).child(empty)))));
  }
}

export const spinner = (t, text) => h_flex().gap(6).items_center().child(svg(ICON("spinner")).size(12).spin(900)).child(text);

/** A key as a small chip. */
export const keycap = (t, k) => div().h(18).min_w(18).px(5).flex().items_center().justify_center().rounded(4).border(1).border_color(t.border)
  .bg(t.background).text_size(10.5).text_color(t.muted).child(k);

/** Key hints for a dialog footer: [[key, label], ...]. */
export const hints = (t, list) => h_flex().flex_1().min_w(0).gap(10).items_center().text_size(11).text_color(t.dim)
  .children(list.map(([k, l]) => h_flex().flex_none().gap(5).items_center().child(keycap(t, k)).child(l)));

/** Runs projects.<cmd>[:arg] on the host. */
export const send = (cmd, arg) => run(`projects.${cmd}${arg == null || arg === "" ? "" : `:${arg}`}`);
export const sendJson = (cmd, o) => send(cmd, JSON.stringify(o));

let seq = 0;
/** A new id for a host request; reqState(id) is { stage?, error?, done?, value? } once the host answers. */
export const newReq = () => `r${Date.now().toString(36)}${(seq++).toString(36)}`;
export const reqState = (id) => (id ? C()?.reqs?.get(id) ?? null : null);

/** Calls fn() and re-renders whenever the host's cache changes, or watch()'s value does (input events can't
 *  re-render the view), while this overlay is open. The view's tick runs on main.js's init timer: a timer
 *  started from start(), which runs in a task, fires but can't re-render. */
export function follow(view, fn, watch = () => null) {
  let v = C()?.ver, w = watch();
  view.tick = () => {
    const now = C()?.ver, was = w;
    w = watch();
    if (now === v && w === was) return false;
    if (now !== v) fn?.();
    v = now;
    return true;
  };
}

/** A view's close(): closes its overlay (this.p: the props captured at init). */
export function closeSelf() { closeOverlay(this.p.overlay); }

/** Opens an overlay from the host: one opened by a closing overlay gets its input states released with it. */
export const openFromHost = (spec) => sendJson("overlay", spec);

/** The new-worktree dialog. src: the checkout whose HEAD "Current HEAD" means; an unsaved project goes whole. */
export function worktreeDialog(p, mode, branch, src, saved = true) {
  openFromHost({ mod: "projects-ui", kind: "dialog", width: 520, props: { view: "worktree", id: p.id, ...(saved ? {} : { project: p }), ...(src ? { src } : {}), ...(mode ? { mode } : {}), ...(branch ? { branch } : {}) } });
}

/** Confirms removing a project from the list. */
export const removeDialog = (p) => openFromHost({ mod: "projects-ui", kind: "dialog", width: 420, props: { view: "project-remove", id: p.id } });
