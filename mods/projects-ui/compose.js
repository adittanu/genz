// The "New agent" dialog: project, This folder | New worktree (optional branch, base), agent (programs' agents); Open runs it on the host.
import { div, image, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, knownAgents, panes, spaces } from "herdr";
import { Dropdown, ICON, ago, badge, basesOf, closeSelf, follow, headed, hints, newReq, projects, reqState, send, sendJson, shownSpace, summary, tilde, worktreePath } from "./ui.js";
import { button, field, ghost, head, note, progress, stepOf } from "./dialog.js";

const leaves = (n) => (n.split ? n.children.flatMap(leaves) : [n.pane]);
const agentLeaf = (layout, key) => (layout?.tabs ?? []).some((t) => leaves(t.root).some((p) => p.argv?.[0]?.split(/[\\/]/).pop().replace(/\.exe$/i, "") === key));
const CLAUDE = { key: "claude", name: "Claude Code", icon: "icons/claude.svg", tint: false };
// Fixed script; program names arrive as "$@", never as shell text.
const FOUND = `exec "\${SHELL:-/bin/sh}" -lic 'for p; do command -v "$p" >/dev/null 2>&1 && printf "wr-ok:%s\\n" "$p"; done' sh "$@"`;
/** Installed agents where `on` is; on another machine its login shell answers too (plain sh misses the profile's PATH). */
async function installedAgents(on) {
  const l = (await knownAgents(on ? { on } : undefined)).filter((a) => a.agent && a.key !== "agent");
  if (!on) return l.filter((a) => a.installed);
  const prog = (a) => a.run?.[0] ?? a.key;
  const r = await exec("sh", ["-c", FOUND, "sh", ...l.map(prog)], { on }).catch(() => null);
  const ok = new Set((r?.stdout ?? "").split("\n").filter((x) => x.startsWith("wr-ok:")).map((x) => x.slice(6)));
  return l.filter((a) => a.installed || ok.has(prog(a)));
}
const icon = (a, size, color) => (!a?.icon ? null : a.tint ? svg(a.icon).size(size).flex_none().text_color(color) : image(a.icon).w(size).h(size).flex_none());

export const views = {
  // props: id (the project to preselect), where ("local" | "worktree"), pick (open the base list).
  // Keys: tab / shift-tab move between fields, ←→ or space flip Where, ↓ opens a list, ↵ opens, esc cancels.
  compose: {
    close: closeSelf,
    start(cx) {
      this.where = this.p.where === "worktree" ? "worktree" : "local";
      this.agent = "claude";
      this.pid = this.p.id ?? projects()[0]?.id ?? null;
      this.base = null;
      this.stage = "";
      this.error = "";
      this.whereF = cx.focus_handle();
      this.branch = InputState.new({ placeholder: "optional: auto-named if empty" });
      this.branch.on("change", (_e, cx) => { this.error = ""; cx.notify(); });
      this.branch.on("submit", (_e, cx) => this.submit(cx));
      this.branch.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
      this.branch.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
      this.proj = new Dropdown(cx, {
        placeholder: "filter projects", max: 7, rowH: 32,
        items: (f) => [...projects().filter((x) => !f || `${x.name} ${x.folder}`.toLowerCase().includes(f)),
          { action: "add-folder", icon: "folder", label: "Add project…" }, { action: "add", icon: "folder-plus", label: "Add current space as project" }],
        current: () => projects().findIndex((x) => x.id === this.pid),
        pick: (x, cx) => {
          if (!x.action) return this.pick(x.id);
          this.before = new Set(projects().map((y) => y.id));
          send(x.action);
        },
      });
      this.agF = cx.focus_handle();
      this.agents = [CLAUDE];
      this.agentsVer = 0;
      this.loadAgents();
      this.from = new Dropdown(cx, {
        placeholder: "filter branches",
        items: (f) => (this.b ? headed(this.b) : []).filter((r) => !f || r.name.toLowerCase().includes(f)),
        current: () => (this.b ? headed(this.b).findIndex((r) => r.name === this.base) : -1),
        pick: (r) => { this.base = r.name; },
      });
      const wt = this.where === "worktree";
      if (wt && this.p.pick) this.from.show(cx);
      else if (wt) { this.branch.focus(); this.typing = true; }
      else this.proj.trigger.focus();
      cx.timer.after(600, () => { if (!this.typing && !this.proj.open && !this.from.open && !this.fields().some((h) => h.is_focused?.())) this.proj.trigger.focus(); });
      this.loadBases();
      follow(this, () => this.sync(), () => `${this.agentsVer}|${this.typing}|${this.branch.value()}|${this.fields().map((h) => (h.is_focused?.() ? 1 : 0)).join("")}`);
    },
    // Picks up fresh bases, a project just added from the list, and the host's progress on Open.
    sync() {
      if (this.before) {
        const fresh = projects().find((x) => !this.before.has(x.id));
        if (fresh) { this.before = null; this.pick(fresh.id); }
      }
      this.showBases();
      const r = reqState(this.req);
      if (!r) return;
      if (r.done) return this.close();
      if (r.error) { this.error = r.error; this.req = null; this.failed = true; }
      else this.stage = r.stage ?? "Starting…";
    },
    // From a failed run back to the form.
    back(cx) { this.failed = false; this.stage = ""; this.error = ""; cx?.notify(); },
    // The tab order: focus handles, and the branch input (no handle; its focus comes from events).
    fields() {
      return [this.proj.trigger, this.agF, this.whereF, ...(this.where === "worktree" ? [this.branch, this.from.trigger] : [])];
    },
    // Left/right (or up/down) on the agent row moves the pick.
    cycle(by) {
      const i = Math.max(0, this.agents.findIndex((a) => a.key === this.agent));
      this.agent = this.agents[(i + by + this.agents.length) % this.agents.length]?.key ?? this.agent;
    },
    step(by, cx) {
      for (const d of [this.proj, this.from]) if (d.open) return d.choose(d.at, cx);
      const fs = this.fields();
      const i = this.typing ? fs.indexOf(this.branch) : fs.findIndex((h) => h !== this.branch && h.is_focused());
      fs[(Math.max(0, i) + by + fs.length) % fs.length].focus();
    },
    project() {
      return projects().find((x) => x.id === this.pid);
    },
    loadBases() {
      const p = this.project();
      this.b = undefined;
      this.base = null;
      if (!p) return;
      sendJson("bases", { project: p, src: null, req: newReq() });
      this.showBases();
    },
    // The cached bases; a base already picked stays picked.
    showBases() {
      const p = this.project(), b = p && basesOf(p);
      if (!b || b === this.b) return;
      this.b = b;
      const want = this.base ?? p.defaultBase ?? b.origin;
      this.base = want === "HEAD" || b.refs.some((r) => r.name === want) ? want : b.refs[0]?.name ?? "HEAD";
      this.from.sync();
    },
    pick(id) {
      if (this.pid === id || this.stage) return;
      this.pid = id;
      this.error = "";
      this.loadBases();
      this.loadAgents();
    },
    // The agent list for the project's machine; a late answer for another machine is dropped.
    loadAgents() {
      const on = this.project()?.machine ?? null;
      if (this.agentsOn === on) return;
      this.agentsOn = on;
      installedAgents(on).then((l) => {
        if (this.agentsOn !== on) return;
        this.agents = l;
        this.agentsVer++;
        if (!l.some((a) => a.key === this.agent)) this.agent = l[0]?.key ?? "none";
      }).catch(() => null);
    },
    submit(cx) {
      if (this.stage) return;
      const p = this.project();
      if (!p) return (this.error = "Pick a project."), cx.notify();
      if (this.where === "worktree" && !this.base) return (this.error = "Pick a branch to start from."), cx.notify();
      this.error = "";
      this.stage = "Starting…";
      this.req = newReq();
      sendJson("agent-run", { id: p.id, where: this.where, base: this.base, branch: this.branch.value(), agent: this.agent, req: this.req });
      cx.notify();
    },
    key(e, cx) {
      if (this.stage) {
        if (e.key === "escape") return this.close();
        if (e.key === "enter" && this.failed) this.back(cx);
        return cx.stop_propagation();
      }
      if (this.proj.key(e, cx) || this.from.key(e, cx)) return cx.stop_propagation();
      if (this.agF.is_focused() && ["left", "right", "up", "down"].includes(e.key)) {
        this.cycle(e.key === "left" || e.key === "up" ? -1 : 1);
        cx.stop_propagation();
        return cx.notify();
      }
      const flip = e.key === "left" || e.key === "right" || e.key === "space";
      if (e.key === "escape") return this.close();
      if (e.keystroke === "tab") this.step(1, cx);
      else if (e.keystroke === "shift-tab") this.step(-1, cx);
      else if ((e.key_char ?? e.key) === "/" && !this.typing) this.proj.show(cx);
      else if (flip && this.whereF.is_focused()) this.where = this.where === "worktree" ? "local" : "worktree";
      else if (e.key === "enter" || e.keystroke === "ctrl-enter") this.submit(cx);
      else return;
      cx.stop_propagation();
      cx.notify();
    },
    draw(t) {
      try { return this.drawForm(t); } catch (e) { return div().p(16).w_full().bg(t.popover).text_size(11).text_color(t.blocked).child(String(e?.stack ?? e)); }
    },
    drawForm(t) {
      const p = this.project(), b = this.b, sp = spaces(), ps = panes();
      const wt = this.where === "worktree";
      const ag = this.agents.find((a) => a.key === this.agent) ?? { key: this.agent, name: this.agent };
      const agName = ag.key === "claude" ? "Claude" : ag.name;
      const branch = this.branch.value().trim();
      const open = !wt && p && shownSpace(p, sp, ps);
      const leaf = !open && agentLeaf(p?.layout, ag.key);
      const baseName = this.base === "HEAD" ? `current HEAD (${b?.head.branch ?? "detached"})` : this.base;
      const agentPart = this.agent === "none" ? "no agent" : leaf ? `${agName} in the layout's pane` : !open && !p?.layout?.tabs?.length ? `${agName} as its only tab` : `${agName} in a new tab`;
      const target = wt && b ? (branch ? tilde(worktreePath(b.root, branch)) : `${tilde(b.root)}/${b.prefix ?? "wr"}-…`) : p?.folder ?? "";
      const hint = !p ? "Pick a project to start in." : wt
        ? (!b ? "Reading branches…" : `${target} from ${baseName}, in a new space, ${agentPart}.`)
        : `${open ? "In its open space" : p.layout ? `In a new space (${summary(p)})` : "In a new space"}, ${agentPart}.`;
      const frame = (body, foot) => v_flex().id("projects-compose").track_focus(this.handle).key_context("WranglerDialog").w_full().bg(t.popover).text_size(13)
        .on_key_down((e, cx) => this.key(e, cx))
        .on_action("wrangler::Next", (_e, cx) => { if (!this.stage) this.step(1, cx); cx.notify(); })
        .on_action("wrangler::Prev", (_e, cx) => { if (!this.stage) this.step(-1, cx); cx.notify(); })
        .on_action("wrangler::Back", (_e, cx) => { for (const d of [this.proj, this.from]) if (d.open) return d.hide(cx); this.close(); })
        .child(v_flex().p(16).gap(12).child(body))
        .child(h_flex().px(16).py(10).gap(8).items_center().border_t(1).border_color(t.border).children(foot));

      // Running (or failed): the steps instead of the form.
      if (this.stage) {
        const steps = [
          ...(wt ? [{ label: `Fetching ${this.base === "HEAD" ? "current HEAD" : this.base}`, match: "Fetching" },
            { label: "Creating worktree", match: "Creating worktree", detail: branch || "auto-named" }] : []),
          { label: "Opening space", match: "Opening space", detail: wt ? "" : p?.name },
          ...(this.agent === "none" ? [] : [{ label: `Starting ${agName}`, match: "Starting " }]),
        ];
        const raw = stepOf(this.stage, steps), at = this.failed ? raw : Math.max(0, raw);
        return frame(
          v_flex().gap(12)
            .child(head(t, wt ? "git-branch" : "square-pen", this.failed ? "Couldn't start the agent" : wt ? "Creating worktree" : "Starting agent",
              `${p?.name ?? ""} · ${target}`, this.failed ? t.blocked : t.accent))
            .child(progress(t, steps, at, this.failed ? this.error : "")),
          [hints(t, this.failed ? [["↵", "back"], ["esc", "close"]] : [["esc", "close, it keeps going"]]),
            ...(this.failed ? [button(t, "cc-back", "Back", "primary", (cx) => this.back(cx))] : []),
            button(t, "cc-close", "Close", null, () => this.close())]);
      }

      const projLabel = (x) => [badge(x, sp, ps), div().flex_1().min_w(0).truncate().text_color(t.foreground).child(x.name)];
      const projRow = (x) => x.action
        ? [svg(ICON(x.icon)).size(14).flex_none().text_color(t.muted), div().flex_1().text_color(t.muted).child(x.label)]
        : [badge(x, sp, ps), div().flex_shrink(0).max_w(160).truncate().text_color(t.foreground).child(x.name),
          div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(x.folder),
          ...(shownSpace(x, sp, ps) ? [div().flex_none().text_size(11).text_color(t.accent).child("open")] : [])];
      const def = p?.defaultBase ?? b?.origin;
      const refLabel = (r) => [
        svg(ICON("branch")).size(13).flex_none().text_color(t.dim),
        div().flex_1().min_w(0).truncate().text_color(t.foreground).child(r.head ? `Current HEAD · ${b?.head.branch ?? "detached"} @ ${b?.head.sha ?? ""}` : r.name),
      ];
      const sel = b && headed(b).find((r) => r.name === this.base);
      const focusW = this.whereF.is_focused();
      const seg = (id, on, icon, text, fn) => h_flex().id(id).px(12).h(26).gap(7).items_center().rounded(6).cursor_pointer()
        .text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => { fn(); this.whereF.focus(); cx.notify(); })
        .child(svg(ICON(icon)).size(13).flex_none().text_color(on ? t.foreground : t.dim)).child(text);
      const W = 466;
      // personal: no saved project yet: say what one is and offer the two ways to make it, instead of an empty list.
      const addProject = (action) => { this.before = new Set(projects().map((y) => y.id)); send(action); };
      const empty = v_flex().w(W).gap(10).p(12).rounded(10).border(1).border_dashed().border_color(t.input).bg(t.background)
        .child(div().text_size(12.5).text_color(t.muted).child("No projects yet. A project is a folder Herdr can start agents in."))
        .child(h_flex().gap(8)
          .child(button(t, "cp-add-cur", "Add current space", "primary", () => addProject("add")))
          .child(button(t, "cp-add-dir", "Choose folder\u2026", null, () => addProject("add-folder"))));
      // personal: the agents as a row of icon tiles (name on hover; \u2190\u2192 moves the pick when the row has focus).
      const agFocus = this.agF.is_focused();
      const tile = (a) => {
        const on = a.key === this.agent;
        return div().id(`ca-${a.key}`).size(38).flex_none().flex().items_center().justify_center().rounded(9).cursor_pointer()
          .border(1).border_color(on ? t.accent : t.border).bg(on ? t.accent + "22" : t.background)
          .hover((s) => s.bg(on ? t.accent + "30" : t.hover))
          .tooltip(a.key === "claude" ? "Claude" : a.name)
          .on_click((_e, cx) => { this.agent = a.key; this.agF.focus(); cx.notify(); })
          .child(icon(a, 18, t.foreground) ?? div().text_size(13).font_semibold().text_color(t.foreground).child([...(a.name ?? a.key)][0]?.toUpperCase() ?? "?"));
      };
      // rows of ten (a wrapping row has no height inside a dialog that sizes to its content)
      const lines = []; for (let n = 0; n < this.agents.length; n += 10) lines.push(this.agents.slice(n, n + 10));
      const agentRow = v_flex().id("ca-row").track_focus(this.agF).w(W).p(2).gap(6).rounded(11).border(1)
        .border_color(agFocus ? t.accent : t.popover)
        .children(lines.map((l) => h_flex().gap(6).children(l.map(tile))));
      const toTree = (cx) => { this.where = "worktree"; this.branch.focus(); this.typing = true; cx.notify(); };
      return frame(
        v_flex().gap(12)
          .child(head(t, "square-pen", "New agent", p ? p.folder : ""))
          .child(v_flex().gap(10)
            .child(field(t, "Project", projects().length
              ? this.proj.draw(t, "cp-proj", W, p ? projLabel(p) : div().text_color(t.dim).child("Pick a project"), projRow, "No matching projects.")
              : empty))
            .child(field(t, "Agent", agentRow))
            .child(field(t, "Where", h_flex().id("cw").track_focus(this.whereF).p(2).gap(2).rounded(8).bg(t.background).border(1)
              .border_color(focusW ? t.accent : t.border).text_size(12.5)
              .child(seg("cw-local", !wt, "folder", "This folder", () => { this.where = "local"; }))
              .child(seg("cw-tree", wt, "git-branch", "New worktree", () => { this.where = "worktree"; }))))
            .child(field(t, "Branch", wt
              ? Input.new(this.branch).w(W).h(32).px(10).items_center().rounded(6).border(1)
                .border_color(this.typing && !this.from.open && !this.proj.open && !this.fields().some((h) => h !== this.branch && h.is_focused()) ? t.accent : t.input).bg(t.background).text_color(t.foreground)
              : ghost(t, W, "New worktree only", null, toTree)))
            .child(field(t, "From", wt
              ? this.from.draw(t, "cb-base", W, b === undefined ? div().text_color(t.dim).child("Reading branches…") : sel ? refLabel(sel) : div().text_color(t.dim).child("Pick a branch"),
                (r) => [...refLabel(r),
                  ...(r.name === def ? [div().flex_none().text_size(11).text_color(t.accent).child("default")] : []),
                  div().flex_none().text_size(11).text_color(t.dim).child(r.at ? ago(r.at) : "")],
                "No matching branches.")
              : ghost(t, W, sel ? (sel.head ? "Current HEAD" : sel.name) : "origin", "branch", toTree))))
          .child(note(t, wt ? "git-branch" : "folder", hint))
          .when(!!this.error, (el) => el.child(div().pl(62).text_size(12).text_color(t.blocked).child(this.error))),
        [hints(t, this.proj.open || this.from.open ? [["↑↓", "move"], ["↵", "pick"], ["esc", "back"]] : [["tab", "next"], ["←→", "agent / where"], ["/", "project"]]),
          button(t, "cc-cancel", "Cancel", null, () => this.close()),
          button(t, "cc-go", "Open", "primary", (cx) => this.submit(cx), !p, "↵")]);
    },
  },
};
