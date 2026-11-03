// The agent switcher (projects.switch): every agent, sub-agents under their parent. Blocked ones first, then most
// recently focused (the host's mru), the focused one last; it opens on the previous agent, so open + Enter flips
// between two. Type to filter (space-separated words, each a subsequence), ↑↓ or ctrl-j/k move, Enter goes, ⇧Enter
// peeks, 1-9 (no filter) goes to that row.
import { div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { agents, focused, panes, run, spaces, terminals } from "herdr";
import { ICON, allProjects, badge, checkoutOf, closeSelf, expand, follow, hints, mru, reveal, send, spaceHue, windowed } from "./ui.js";

const ROW = 36, MAX = 10;
const WORD = { working: "Working", blocked: "Needs you", done: "Done", idle: "Idle" };
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();
const nameOf = (k) => k.name || k.template || k.program?.name || k.address;
const fits = (hay, f) => f.split(/\s+/).filter(Boolean).every((w) => { let i = 0; for (const c of hay) if (c === w[i]) i++; return i >= w.length; });

function age(ms) {
  if (!ms) return "";
  const m = Math.floor((Date.now() - (ms < 1e12 ? ms * 1000 : ms)) / 60000);
  return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`;
}

function glyph(t, st) {
  const box = h_flex().w(14).flex_none().items_center().justify_center();
  if (st === "working") return box.child(svg(ICON("spinner")).size(12).text_color(t.working).spin(900));
  if (st === "blocked") return box.child(div().size(14).rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!"));
  if (st === "done") return box.child(svg(ICON("circle-check")).size(13).text_color(t.done));
  return box.child(div().size(7).rounded(4).border(1.5).border_color(st === "idle" ? t.idle : t.dim));
}

const icon = (p, size, color) => !p?.icon ? null : p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();

export const views = {
  switch: {
    close: closeSelf,

    start() {
      this.filter = "";
      this.list = { off: 0 };
      const f = focused(), live = new Set(agents().map((a) => a.address));
      this.here = f?.agent ?? f?.terminal ?? null;
      this.sel = mru().find((x) => x !== this.here && live.has(x)) ?? this.rows().find((r) => r.addr !== this.here)?.addr ?? null;
      follow(this);
    },

    /** Where an agent works: its project (else its space), task, folder and branch. */
    where(a, sp, ps) {
      const pane = ps.find((p) => p.pane === a.pane), s = sp.find((x) => x.id === a.space), tab = s?.tabs.find((x) => x.id === a.tab);
      const on = s?.machine ?? null, cwd = pane?.cwd ?? null, co = cwd ? checkoutOf(cwd, on) : null;
      const p = co ? allProjects().find((x) => (x.machine ?? null) === on && expand(x.folder) === co.main) ?? null : null;
      const live = clean(a.title), prog = a.program?.name;
      const task = live && live !== prog && !/^[~/]/.test(live) && !live.includes("@") ? live : tab?.named ? tab.name : "";
      const since = a.status === "working" ? tab?.working_since : tab?.changed_at;
      return { p, s, name: p?.name ?? a.space_name, cwd, branch: co?.branch ?? pane?.branch ?? null, linked: !!co?.linked, task, since };
    },

    rows() {
      const sp = spaces(), ps = panes(), all = agents(), order = mru(), f = this.filter.trim().toLowerCase();
      const listed = new Map(all.map((a) => [a.address, a.status]));
      const kids = terminals().filter((k) => k.parent && k.state === "live" && !listed.has(k.address));
      const rank = (a) => (a.address === this.here ? 2 : a.status === "blocked" ? 0 : 1);
      const seen = (a) => { const i = order.indexOf(a.address); return i < 0 ? Infinity : i; };
      const out = [];
      for (const a of [...all].sort((x, y) => rank(x) - rank(y) || seen(x) - seen(y) || y.seq - x.seq)) {
        const w = this.where(a, sp, ps), team = [];
        const walk = (addr, depth) => kids.filter((k) => k.parent === addr).forEach((k) => {
          team.push({ k, addr: k.address, depth, status: k.status === "error" ? "blocked" : k.status === "done" ? "idle" : k.status });
          walk(k.address, depth + 1);
        });
        walk(a.address, 1);
        if (f && !fits([w.name, w.task, w.branch, a.program?.name, a.space_name, ...team.map((x) => nameOf(x.k))].join(" ").toLowerCase(), f)) continue;
        out.push({ a, addr: a.address, w, status: a.status, depth: 0 }, ...team);
      }
      return out;
    },

    go(r, peek = false) {
      if (!r) return;
      this.close();
      if (peek) send("peek", r.addr);
      else run("agent.focus", { terminal: r.addr });
    },

    setFilter(f) {
      this.filter = f;
      this.sel = null;
      this.list.off = 0;
    },

    row(t, r, i, on) {
      const el = h_flex().id(`sw-${r.addr}`).h(ROW).px(10).gap(10).items_center().rounded(8).cursor_pointer()
        .when(on, (el) => el.bg(t.hover)).hover((s) => s.bg(t.hover))
        .on_click(() => this.go(r))
        .child(div().w(10).flex_none().text_size(11).text_color(t.dim).child(!this.filter && i < 9 ? `${i + 1}` : ""));
      if (r.depth) return el
        .child(div().w(r.depth * 14).flex_none().text_right().text_color(t.dim).child("└"))
        .child(glyph(t, r.status))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(nameOf(r.k)));
      const w = r.w, sp = spaces(), ps = panes(), here = r.addr === this.here;
      const mark = w.p ? badge(w.p, sp, ps) : h_flex().size(18).flex_none().rounded(5).bg(spaceHue(r.a.space) ?? t.dim).items_center().justify_center()
        .text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?");
      const word = WORD[r.status], ago = age(w.since);
      return el
        .child(mark)
        .child(icon(r.a.program, 15, t.foreground) ?? div())
        .child(div().flex_shrink(0).max_w(140).truncate().text_size(13).text_color(t.foreground).child(w.name))
        .when(here, (el) => el.child(div().flex_none().px(5).h(16).flex().items_center().rounded(4).bg(t.raised).text_size(10.5).text_color(t.dim).child("here")))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(t.muted).child(w.task))
        .when(!!w.branch, (el) => el.child(h_flex().flex_shrink(1).max_w(150).min_w(0).gap(5).items_center().text_size(11.5).text_color(t.dim)
          .child(svg(ICON("branch")).size(12).flex_none())
          .child(div().min_w(0).truncate().child(w.branch))))
        .child(h_flex().w(108).flex_none().justify_end().gap(5).items_center().text_size(11.5)
          .text_color(r.status === "idle" || !word ? t.dim : t[r.status])
          .child(glyph(t, r.status))
          .child(`${word ?? r.status ?? ""}${(r.status === "working" || r.status === "idle") && ago && ago !== "now" ? ` ${ago}` : ""}`));
    },

    draw(t) {
      const rows = this.rows(), n = rows.length;
      let at = rows.findIndex((r) => r.addr === this.sel);
      if (at < 0) { at = 0; this.sel = rows[0]?.addr ?? null; }
      reveal(this.list, at, MAX);
      const sel = rows[at];
      return v_flex().id("switcher").track_focus(this.handle).size_full().bg(t.popover).text_size(13)
        .on_key_down((e, cx) => {
          const m = e.modifiers ?? {}, k = e.key;
          const move = (d) => { if (n) { at = (at + d + n) % n; this.sel = rows[at].addr; reveal(this.list, at, MAX); } };
          if (k === "escape" && this.filter) this.setFilter("");
          else if (k === "escape") return this.close();
          else if (k === "enter") return this.go(sel, e.keystroke === "shift-enter");
          else if (k === "down" || (m.control && (k === "j" || k === "n"))) move(1);
          else if (k === "up" || (m.control && (k === "k" || k === "p"))) move(-1);
          else if (m.control && k === "u") this.setFilter("");
          else if (k === "backspace" || (m.control && k === "w")) this.setFilter(m.control || m.alt || k === "w" ? this.filter.replace(/\S*\s*$/, "") : this.filter.slice(0, -1));
          else if (!this.filter && /^[1-9]$/.test(k) && !m.control && !m.alt) return this.go(rows[+k - 1]);
          else if (e.key_char && !m.control && !m.alt && !m.platform) this.setFilter(this.filter + e.key_char);
          else return;
          cx.stop_propagation();
          cx.notify();
        })
        .child(h_flex().h(46).flex_none().px(16).gap(10).items_center().border_b(1).border_color(t.border)
          .child(svg(ICON("search")).size(16).flex_none().text_color(t.dim))
          .child(h_flex().flex_1().min_w(0).items_center().text_size(14)
            .when(!!this.filter, (el) => el.child(div().truncate().text_color(t.foreground).child(this.filter)))
            .child(div().w(1).h(16).flex_none().bg(t.accent))
            .when(!this.filter, (el) => el.child(div().pl(2).truncate().text_color(t.dim).child("Switch to an agent…"))))
          .child(div().flex_none().text_size(11.5).text_color(t.dim).child(`${n} agent${n === 1 ? "" : "s"}`)))
        .child(v_flex().flex_1().min_h(0).p(6)
          .when(!!n, (el) => el.child(windowed(t, "sw-list", this.list, n, MAX, ROW, (i) => this.row(t, rows[i], i, i === at))))
          .when(!n, (el) => el.child(div().px(10).py(8).text_color(t.dim).child(this.filter ? "No agent matches." : "No agents running."))))
        .child(h_flex().flex_none().px(16).py(9).border_t(1).border_color(t.border)
          .child(hints(t, [["↵", "go"], ["⇧↵", "peek"], ["1-9", "jump"], ["esc", "close"]])));
    },
  },
};
