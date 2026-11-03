// The bar over a peeked terminal (projects.peek): who it is and how it's doing, then go to and close with their keys.
// Beats globalThis.__wranglerPeek so the host's peek-go / peek-close know a peek is open.
import { div, image, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, closeOverlay, panes, run, terminals } from "herdr";

// Self-contained: a peek loads this and main.js only, not ui.js (every overlay open keeps its modules).
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;
const keycap = (t, k) => div().h(18).min_w(18).px(5).flex().items_center().justify_center().rounded(4).border(1).border_color(t.border)
  .bg(t.background).text_size(10.5).text_color(t.muted).child(k);

const WORD = { working: "Working", blocked: "Needs you", done: "Done", idle: "Idle" };
const icon = (p, size, color) => (!p?.icon ? null : p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none());

export const views = {
  peek: {
    close() { closeOverlay(this.p.overlay); },
    start() {
      let was = "";
      this.tick = () => {
        globalThis.__wranglerPeek = { terminal: this.p.terminal, overlay: this.p.overlay, at: Date.now() };
        const k = terminals().find((x) => x.address === this.p.terminal);
        const now = `${k?.status}|${k?.name}|${agents().find((a) => a.address === this.p.terminal)?.status}`;
        if (now === was) return false;
        was = now;
        return true;
      };
    },
    draw(t) {
      const addr = this.p.terminal;
      const k = terminals().find((x) => x.address === addr);
      const st = agents().find((a) => a.address === addr)?.status ?? k?.status ?? null;
      const parent = k?.parent ? terminals().find((x) => x.address === k.parent) : null;
      const home = panes().some((x) => x.terminal === addr);
      const tone = t[st] ?? t.dim;
      const mark = st === "working" ? svg(ICON("spinner")).size(13).flex_none().text_color(tone).spin(900)
        : st === "done" ? svg(ICON("circle-check")).size(13).flex_none().text_color(tone)
        : div().size(8).flex_none().rounded(4).when(st === "blocked", (el) => el.bg(tone)).when(st !== "blocked", (el) => el.border(1.5).border_color(tone));
      const action = (id, text, key, fn) => h_flex().id(id).h(28).pl(10).pr(6).gap(8).items_center().rounded(7).cursor_pointer()
        .text_size(12.5).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => fn()).child(text).child(keycap(t, key));
      return h_flex().size_full().px(14).gap(10).items_center().bg(t.popover).border_b(1).border_color(t.border).text_size(13)
        .child(h_flex().size(16).flex_none().items_center().justify_center().child(mark))
        .child(icon(k?.program, 15, t.foreground) ?? div())
        .child(div().flex_shrink(0).max_w(260).truncate().font_semibold().text_color(t.foreground).child(k?.name || k?.template || k?.program?.name || addr))
        .when(!!st, (el) => el.child(div().flex_none().text_size(12).text_color(tone).child(WORD[st] ?? st)))
        .when(!!parent, (el) => el.child(div().min_w(0).truncate().text_size(12).text_color(t.dim).child(`from ${parent.name || parent.address}`)))
        .child(div().flex_1())
        .child(action("pk-go", home ? "Go to" : "Keep as tab", "⌃⇧↵", () => run("projects.peek-go")))
        .child(action("pk-close", "Close", "⌃⇧Q", () => this.close()));
    },
  },
};
