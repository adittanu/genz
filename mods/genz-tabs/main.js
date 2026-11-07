import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, layout, settings, nextCommand } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Tabs nobody named show their number. Agents put a summary of the first
// prompt in their terminal title ("OC | ...", "kiro: ...", "✳ ..."), so an
// unnamed tab can take that title once the agent reports one.
const AUTO_TITLES = "auto-titles";
const GENERIC_TITLE = /^(?:opencode|codebuddy|kiro(?:[ -]?cli)?|claude(?:[ -]?code)?|codex|gemini|copilot|pwsh(?:\.exe)?|powershell|windows powershell|cmd(?:\.exe)?|command prompt|bash|zsh|fish|sh|terminal|shell|new session|untitled|home|working|idle|done|blocked)(?:[ -]?cli)?(?:[ -]?v?\d+(?:\.\d+)*)?$/i;

function cleanTitle(raw, pane) {
  let s = (raw ?? "").trim().replace(/^[^\p{L}\p{N}]+/u, "").replace(/\s+/g, " ").trim();
  s = s.replace(/^(?:OC|opencode|codebuddy|kiro(?:[ -]?cli)?|claude(?:[ -]?code)?|codex|gemini|copilot)(?:[ -]?cli)?(?:\s+v?\d+(?:\.\d+)*)?\s*[-–—|:·•]\s*/i, "");
  s = s.replace(/\s*[-–—|·•:]\s*(?:opencode|codebuddy|kiro(?:[ -]?cli)?|claude(?:[ -]?code)?|codex|gemini|copilot)(?:[ -]?cli)?\s*$/i, "");
  s = s.replace(/^[|:·•—–-]+\s*/, "").trim();
  if (!s || GENERIC_TITLE.test(s) || /^\d+\.?$/.test(s) || /^(?:SSH|Insights)$/i.test(s)) return null;
  if (/^[~/]|^[A-Za-z]:[\\/]|^\\\\/.test(s) || /^[^\s@]+@[^\s@]+(?::|\s|$)/.test(s)) return null;
  const program = pane?.program;
  if (program) {
    const key = (program.key ?? "").toLowerCase();
    const name = (program.name ?? "").toLowerCase();
    if (s.toLowerCase() === key || s.toLowerCase() === name) return null;
  }
  const base = pane?.cwd?.split(/[\\/]/).filter(Boolean).pop()?.toLowerCase();
  if (base && s.toLowerCase() === base) return null;
  if (pane?.branch && s.toLowerCase() === pane.branch.toLowerCase()) return null;
  const chars = Array.from(s);
  return chars.length > 80 ? chars.slice(0, 79).join("").trimEnd() + "…" : s;
}

// Open Insights as a tab in the active space, or focus the copy that is already there.
function showInsights() {
  const active = spaces().find((space) => space.active);
  const tabIds = new Set(active?.tabs.map((tab) => tab.id) ?? []);
  const open = panes().find((pane) => pane.mod === "insights" && tabIds.has(pane.tab));
  if (open) {
    const zoomed = panes().find((pane) => pane.tab === open.tab && pane.zoomed);
    if (zoomed && zoomed.pane !== open.pane) run("pane.zoom", { pane: zoomed.pane });
    return run("pane.focus", { pane: open.pane });
  }
  return run("tab.new", { name: "Insights", mod: "insights" });
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    // The Files / Changes / Quota / SSH / Insights / Poké Ball group starts folded.
    this.toolsOpen = localStorage.getItem("tools-open") === "1";
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
    let autoNamed = {};
    try { autoNamed = JSON.parse(localStorage.getItem(AUTO_TITLES) ?? "{}") ?? {}; } catch {}
    this.autoNamed = autoNamed && typeof autoNamed === "object" && !Array.isArray(autoNamed) ? autoNamed : {};
    this.renaming = new Map();
    cx.timer.every(2000, () => this.autoTitle());
    this.autoTitle();
    // Key commands from keys.json ("genz-tabs.ssh").
    cx.spawn(async () => {
      for (;;) {
        if (await nextCommand() === "ssh") this.toggleSsh();
      }
    });
  }

  // Ctrl+Shift+S: to the space's SSH tab (opened if it isn't there) with its search ready;
  // pressed again on the SSH tab, back to the tab you came from.
  toggleSsh() {
    const tabs = spaces().find(p => p.active)?.tabs ?? [];
    const ssh = tabs.find(x => x.name === "SSH");
    if (ssh?.active) {
      const back = tabs.find(x => x.id === this.beforeSsh);
      if (back) run("tab.select", { id: back.id });
      return;
    }
    this.beforeSsh = tabs.find(x => x.active)?.id ?? null;
    if (!ssh) { run("tab.new", { name: "SSH", mod: "ssh-hosts" }); return; }
    run("tab.select", { id: ssh.id });
    run("ssh-hosts.focus");
  }

  // Name each unnamed tab after the title its agent reports, once. A tab the
  // person named is never touched; a name this code set is remembered, so
  // clearing it (rename to "") does not make the title come back.
  autoTitle() {
    const all = panes();
    const live = new Set();
    let changed = false;
    for (const space of spaces()) {
      for (const tab of space.tabs) {
        live.add(tab.id);
        if (tab.named) { this.renaming.delete(tab.id); continue; }
        if (this.autoNamed[tab.id]) continue;
        const pending = this.renaming.get(tab.id);
        if (pending && Date.now() - pending < 5000) continue;
        const title = all
          .filter(p => p.tab === tab.id && p.terminal && (p.program?.agent || p.status))
          .map(p => cleanTitle(p.title, p))
          .find(Boolean);
        if (!title) continue;
        this.renaming.set(tab.id, Date.now());
        this.autoNamed[tab.id] = title;
        changed = true;
        run("tab.rename", { id: tab.id, name: title });
      }
    }
    for (const id of Object.keys(this.autoNamed)) {
      if (!live.has(id)) { delete this.autoNamed[id]; changed = true; }
    }
    for (const id of this.renaming.keys()) if (!live.has(id)) this.renaming.delete(id);
    if (changed) localStorage.setItem(AUTO_TITLES, JSON.stringify(this.autoNamed));
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = panes().find(p => p.tab === c.id && p.program?.agent)?.program ?? panes().find(p => p.tab === c.id)?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    // "quota" is always a panel of this layout, whatever the welcome saved.
    const enabled = [...new Set([...(shared("workspace.panels") ?? ["files", "changes"]), "quota"])];
    this.syncPanel(space, panel, body, enabled);
    // The tool buttons. Folded (the default), only the ones that are on show, as icons, next to
    // the chevron; unfolded, every one shows with its label. The chevron flips between the two.
    const panelOn = id => Boolean(panel && !panel.hidden && body?.active === id);
    const togglePanel = id => {
      if (panelOn(id)) run("layout.hide", { id: "panel" });
      else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
    };
    // SSH Hosts: select the space's "SSH" tab, or open it as a tab whose only pane is the ssh-hosts mod.
    const sshTab = shown.find(x => x.name === "SSH");
    // Insights: select the space's Insights tab, or open it as a tab whose only pane is the insights mod.
    const insightsTab = shown.find(x => panes().some(p => p.tab === x.id && p.mod === "insights"));
    // Pokémon strip: shows or hides the pokemon-agents block, when this layout has one.
    const mons = find(root, "pokemon-agents");
    const tools = [
      enabled.includes("files") && { id: "panel-files", label: "Files", icon: "mods/files/file.svg", on: panelOn("files"), action: () => togglePanel("files") },
      enabled.includes("changes") && { id: "panel-changes", label: "Changes", icon: "mods/changes/changes.svg", on: panelOn("changes"), action: () => togglePanel("changes") },
      { id: "panel-quota", label: "Quota", icon: "mods/quota/gauge.svg", on: panelOn("quota"), action: () => togglePanel("quota") },
      { id: "panel-ssh", label: "SSH", icon: "mods/ssh-hosts/server.svg", on: Boolean(sshTab?.active),
        action: () => sshTab ? run("tab.select", { id: sshTab.id }) : run("tab.new", { name: "SSH", mod: "ssh-hosts" }) },
      { id: "panel-insights", label: "Insights", icon: "mods/insights/insights.svg", on: Boolean(insightsTab?.active), action: showInsights },
      mons && { id: "toggle-pokemon", label: "Pokémon", icon: "mods/pokemon-agents/pokeball.svg", on: !mons.hidden, iconOnly: true,
        action: () => run("layout.toggle", { id: "pokemon-agents" }) },
    ].filter(Boolean);
    const open = this.toolsOpen;
    const tool = x => {
      const labeled = open && !x.iconOnly;
      return h_flex().id(x.id).h(26).flex_none().items_center().rounded(6).text_size(12)
        .bg(x.on ? t.selected : t.chrome).text_color(x.on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop).on_click(x.action)
        .when(labeled, el => el.px(8).gap(5)).when(!labeled, el => el.w(26).justify_center().tooltip(x.label))
        .child(svg(x.icon).size(14))
        .when(labeled, el => el.child(x.label));
    };
    const toolsToggle = div().id("tools-toggle").size(26).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).on_mouse_down("left", stop)
      .tooltip(open ? "Fold the tools" : "Files, Changes, Quota, SSH, Insights")
      .on_click((_e, cx) => {
        this.toolsOpen = !this.toolsOpen;
        localStorage.setItem("tools-open", this.toolsOpen ? "1" : "0");
        cx.notify();
      })
      .child(svg(`mods/genz-tabs/${open ? "chevron-right" : "chevron-left"}.svg`).size(14));
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .children((open ? tools : tools.filter(x => x.on)).map(tool))
      .child(toolsToggle)
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/genz-tabs/win-min.svg").size(16) : "âˆ’", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/genz-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "â–¡", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/genz-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
