// Popup menus and the project picker.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { focused, panes, run, spaces } from "herdr";
import { ICON, badge, hints, openFromHost, closeSelf, follow, ownerOf, projects, removeDialog, savedOf, send, summary, tilde, worktreeDialog } from "./ui.js";

const common = {
  close: closeSelf,

  // Popup lists: entries {label, icon | project, run, on, hint, tree} plus {sep}, {head} and {scroll: [entries], max}
  // (a list that shows max rows and scrolls with the wheel); ↑/↓ Enter Esc, Tab/ctrl-Enter the row's tree action.
  // With a scroll list, typing filters it (shown in a search line on top); foot: key hints [[key, label]].
  popup(t, id, entries, foot = null) {
    const sp = spaces(), ps = panes();
    const ROW = 32;
    const q = (this.q ?? "").toLowerCase();
    const findable = entries.some((e) => e.scroll);
    if (q) entries = entries.map((e) => (e.scroll ? { ...e, scroll: e.scroll.filter((x) => x.label.toLowerCase().includes(q)) } : e));
    const flat = entries.flatMap((e) => e.scroll ?? [e]);
    const live = flat.filter((e) => e.run && e.on !== false);
    this.at = Math.max(0, Math.min(this.at ?? 0, live.length - 1));
    this.off ??= 0;
    const reveal = () => {
      const g = entries.find((e) => e.scroll?.includes(live[this.at]));
      const k = g ? g.scroll.indexOf(live[this.at]) : -1, max = g?.max ?? 8;
      if (k >= 0) this.off = Math.min(k, Math.max(this.off, k - max + 1));
    };
    const pick = (e) => { this.close(); e.run(); };
    const tool = (key, icon, tip, tone, fn) => div().id(key).size(24).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.dim).hover((s) => s.bg(t.raised).text_color(tone)).tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); this.close(); fn(); })
      .child(svg(ICON(icon)).size(14));
    const item = (e, i) => {
      const on = e.on !== false, n = live.indexOf(e), sel = on && n === this.at;
      return h_flex().id(`${id}-${i}`).h(ROW).px(10).gap(10).rounded(8).items_center().text_size(13)
        .text_color(on ? t.foreground : t.dim)
        .when(sel, (el) => el.bg(t.hover))
        .when(on, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => pick(e)))
        .when(!!e.more, (el) => el.on_mouse_down("right", () => { this.close(); e.more(); }))
        .when(!!e.drop || !!e.tree, (el) => el.on_hover((h, cx) => { if (h) this.hov = i; else if (this.hov === i) this.hov = null; cx.notify(); }))
        .child(e.project ? badge(e.project, sp, ps) : h_flex().size(18).flex_none().items_center().justify_center()
          .child(svg(ICON(e.icon)).size(15).text_color(on ? (sel ? t.foreground : t.muted) : t.dim)))
        .child(div().flex_1().min_w(0).truncate().child(e.label))
        .when(!!e.hint && this.hov !== i, (el) => el.child(div().flex_none().max_w(120).truncate().text_size(11.5).text_color(t.dim).child(e.hint)))
        .when(!!e.tree && (this.hov === i || sel), (el) => el.child(tool(`${id}-${i}-wt`, "branch", "New worktree", t.foreground, e.tree)))
        .when(!!e.drop && this.hov === i, (el) => el.child(tool(`${id}-${i}-rm`, "x", "Remove project", t.blocked, e.drop)));
    };
    const group = (e, i) => {
      const n = e.scroll.length, max = e.max ?? 8, h = ROW * Math.min(n, max);
      this.off = Math.max(0, Math.min(this.off, n - max));
      if (!n) return div().px(10).h(ROW).flex().items_center().text_size(12.5).text_color(t.dim).child(q ? "No matching projects" : "No projects yet");
      return v_flex().id(`${id}-group`).relative().flex_none().h(h).overflow_hidden()
        .on_scroll_wheel((ev, cx) => {
          this.acc = (this.acc ?? 0) + (ev.delta_lines ? ev.delta_lines.y * ROW : ev.delta.y);
          const step = Math.trunc(this.acc / ROW);
          if (!step) return;
          this.acc -= step * ROW;
          this.off = Math.max(0, Math.min(this.off - step, n - max));
          cx.notify();
        })
        .children(e.scroll.slice(this.off, this.off + max).map((x, k) => item(x, `${i}-${this.off + k}`)))
        .when(n > max, (el) => el.child(div().absolute().right(0).w(3).rounded(2).bg(t.border)
          .top(Math.round(h * this.off / n)).h(Math.max(12, Math.round(h * max / n)))));
    };
    return v_flex().id(id).track_focus(this.handle).w_full().min_h(0).bg(t.popover)
      .on_key_down((e, cx) => {
        const n = live.length, m = e.modifiers ?? {};
        if (e.key === "down" && n) { this.at = (this.at + 1) % n; reveal(); }
        else if (e.key === "up" && n) { this.at = (this.at + n - 1) % n; reveal(); }
        else if (e.key === "enter" && live[this.at]) pick(live[this.at]);
        else if ((e.keystroke === "tab" || e.keystroke === "ctrl-enter") && live[this.at]?.tree) { this.close(); live[this.at].tree(); }
        else if (e.key === "escape" && this.q) { this.q = ""; this.at = 0; this.off = 0; }
        else if (e.key === "escape") this.close();
        else if (findable && e.key === "backspace") { this.q = (this.q ?? "").slice(0, -1); this.at = 0; this.off = 0; }
        else if (findable && e.key_char && !m.control && !m.alt && !m.platform && e.key !== "space") { this.q = (this.q ?? "") + e.key_char; this.at = 0; this.off = 0; }
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .when(findable, (el) => el.child(h_flex().h(40).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
        .child(svg(ICON("search")).size(15).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(this.q ? t.foreground : t.dim).child(this.q || "Type to find a project"))))
      .child(v_flex().p(6).gap(1).children(entries.map((e, i) => e.sep ? div().mx(4).my(4).h(1).bg(t.border)
        : e.head ? div().px(10).pt(6).pb(4).text_size(10.5).font_semibold().text_color(t.dim).truncate().child(e.path ? e.head : e.head.toUpperCase())
        : e.scroll ? group(e, i)
        : item(e, i))))
      .when(!!foot, (el) => el.child(h_flex().mt_auto().px(14).py(9).border_t(1).border_color(t.border).child(hints(t, foot))));
  },
};

const focusedSpace = () => spaces().find((x) => x.id === focused()?.space);

export const views = {
  // The spaces header's + popup.
  new: {
    ...common,
    start(cx) { follow(this); },
    draw(t) {
      const m = savedOf(focusedSpace());
      return this.popup(t, "projects-new", [
        { label: "Empty space", icon: "plus", run: () => run("space.new") },
        { sep: true },
        { head: "Projects" },
        { scroll: projects().map((p) => ({ label: p.name, project: p, hint: summary(p), run: () => send("open", p.id), tree: () => worktreeDialog(p), more: () => send("menu", p.id), drop: () => removeDialog(p) })), max: 8 },
        { sep: true },
        { label: m ? `Save this space's layout to ${m.name}` : "Save this space's layout to project", icon: "layers", on: !!m, run: () => send("save", m.id) },
        { label: "Add project…", icon: "folder", run: () => send("add-folder") },
        { label: "Add current space as project", icon: "folder-plus", run: () => send("add") },
      ], [["↵", "open"], ["tab", "worktree"], ["esc", "close"]]);
    },
  },

  // A space row's right-click popup; props.main: the repo's own checkout, props.plain: not in git.
  "space-menu": {
    ...common,
    start(cx) { follow(this); },
    draw(t) {
      const id = this.p.space, s = spaces().find((x) => x.id === id), o = s ? ownerOf(s) : null;
      const unsaved = !!s && o !== undefined && (o ? !o.saved : savedOf(s) === null);
      const rename = { label: "Rename", icon: "square-pen", run: () => run("space.rename", { id }) };
      const save = unsaved ? [{ label: "Add as project", icon: "folder-plus", hint: o ? o.project.name : "", run: () => send("add-space", id) }] : [];
      const close = [{ sep: true }, { label: "Close", icon: "x", run: () => run("space.close", { id }) }];
      if (this.p.plain) return this.popup(t, "projects-space", [rename, ...save, ...close]);
      if (this.p.main) return this.popup(t, "projects-space", [
        rename,
        { label: "New worktree", icon: "branch", on: !!o, run: () => worktreeDialog(o.project, null, null, null, o.saved) },
        { label: "Open worktree", icon: "folder", run: () => openFromHost({ mod: "worktree", kind: "dialog", width: 560, height: 480, props: { space: id, action: "open" } }) },
        ...save,
        ...close,
      ]);
      return this.popup(t, "projects-space", [
        rename,
        { label: "New worktree from this branch", icon: "branch", hint: o?.branch ?? "", on: !!o, run: () => worktreeDialog(o.project, "head", null, o.src, o.saved) },
        { label: "Remove worktree", icon: "minus", run: () => openFromHost({ mod: "worktree", kind: "dialog", width: 440, height: 260, props: { space: id, action: "remove" } }) },
        ...save,
        ...close,
      ]);
    },
  },

  // An Agents row's right-click popup; props.agent from the host.
  "agent-menu": {
    ...common,
    draw(t) {
      const a = this.p.agent;
      return this.popup(t, "projects-agent", [
        { head: tilde(a.cwd), path: true },
        ...(a.branch ? [{ label: "Copy branch", icon: "branch", hint: a.branch, run: () => send("agent-copy", `${a.addr}|branch`) }] : []),
        { label: "Copy path", icon: "folder", run: () => send("agent-copy", `${a.addr}|path`) },
        ...(a.linked ? [{ sep: true }, { label: "Delete worktree…", icon: "minus", run: () => send("agent-delete", a.addr) }] : []),
      ]);
    },
  },

  // A project's popup (projects.menu:id).
  menu: {
    ...common,
    start(cx) { follow(this); },
    draw(t) {
      const p = projects().find((x) => x.id === this.p.id);
      if (!p) return this.popup(t, "projects-menu", [{ head: "No such project" }]);
      return this.popup(t, "projects-menu", [
        { head: p.folder, path: true },
        { label: "Open", icon: "folder", run: () => send("open", p.id) },
        { label: "Open new space anyway", icon: "plus", run: () => send("open-new", p.id) },
        { label: "Open in new worktree…", icon: "branch", run: () => worktreeDialog(p) },
        { label: "Save current space's layout here", icon: "layers", on: !!focused()?.space, run: () => send("save", p.id) },
        { label: "Clear layout", icon: "minus", on: !!p.layout, run: () => send("clear", p.id) },
        { sep: true },
        { label: "Remove project…", icon: "x", run: () => removeDialog(p) },
      ]);
    },
  },

  // mod.open:projects-ui: type to filter, Enter opens, Tab/ctrl-Enter new worktree.
  picker: {
    ...common,
    start(cx) {
      this.at = 0;
      this.filter = "";
      this.input = InputState.new({ placeholder: "Open a project…" });
      this.input.on("change", (_e, cx) => { this.filter = this.input.value(); this.at = 0; cx.notify(); });
      this.input.on("submit", (e) => this.choose(this.at, e?.secondary));
      this.input.focus();
      cx.timer.after(600, () => this.input.focus());
      follow(this, null, () => this.input.value());
    },
    rows() {
      const f = this.filter.toLowerCase();
      const list = projects().filter((p) => !f || `${p.name} ${p.folder}`.toLowerCase().includes(f));
      return [...list.map((p) => ({ p })), { act: "current", label: "Add current space as project", icon: "folder-plus" }, { act: "folder", label: "Add folder…", icon: "plus" }];
    },
    choose(i, alt = false) {
      const r = this.rows()[i];
      if (!r || (alt && !r.p)) return;
      this.close();
      if (r.p && alt) worktreeDialog(r.p);
      else if (r.p) send("open", r.p.id);
      else send(r.act === "current" ? "add" : "add-folder");
    },
    draw(t) {
      const rows = this.rows(), sp = spaces(), ps = panes();
      this.at = Math.min(this.at, rows.length - 1);
      const row = (r, i) => h_flex().id(`pp-${r.p?.id ?? r.act}`).mx(4).px(10).h(32).flex_none().gap(10).items_center().rounded(7).cursor_pointer()
        .when(i === this.at, (el) => el.bg(t.hover))
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.choose(i))
        .when(!!r.p, (el) => el
          .child(badge(r.p, sp, ps))
          .child(div().flex_shrink(0).text_color(t.foreground).child(r.p.name))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(r.p.folder))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(summary(r.p))))
        .when(!r.p, (el) => el.text_color(t.muted)
          .child(svg(ICON(r.icon)).size(14).flex_none())
          .child(div().flex_1().child(r.label)));
      return v_flex().id("projects-picker").track_focus(this.handle).w_full().min_h(0).p(18).gap(10).bg(t.popover).text_size(13)
        .on_key_down((e, cx) => {
          if (e.key === "escape") return this.close();
          if (e.keystroke === "tab" || e.keystroke === "ctrl-enter") this.choose(this.at, true);
          else if (e.key === "down") this.at = (this.at + 1) % rows.length;
          else if (e.key === "up") this.at = (this.at + rows.length - 1) % rows.length;
          else return;
          cx.stop_propagation();
          cx.notify();
        })
        .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Projects")).child(div().text_size(11).text_color(t.dim).child("Esc")))
        .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
          .child(svg(ICON("search")).size(15).text_color(t.dim))
          .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
        .child(v_flex().h(Math.min(360, 6 + rows.length * 32)).min_h(0).flex_shrink(1).pb(6).overflow_y_scrollbar().children(rows.map(row)))
        .child(h_flex().justify_end().text_size(11).text_color(t.dim).child(rows[this.at]?.p ? "↵ open · tab new worktree" : "↵ choose"));
    },
  },
};
