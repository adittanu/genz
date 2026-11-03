// Dialog pieces for compose.js and worktree.js only (menus, the switcher and the peek don't load them).
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { ICON, keycap } from "./ui.js";

/** A dialog's header: an icon tile in tone (default accent), the title, a dim subtitle after it and an esc chip. */
export const head = (t, icon, title, sub, tone = t.accent) => h_flex().gap(10).items_center()
  .child(h_flex().size(26).flex_none().rounded(7).bg(tone + "22").items_center().justify_center()
    .child(svg(ICON(icon)).size(14).text_color(tone)))
  .child(div().flex_none().max_w(320).truncate().text_size(15).font_semibold().text_color(t.foreground).child(title))
  .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(sub ?? ""))
  .child(keycap(t, "esc"));

/** A form row: a caption on the left (54px), then the control. */
export const field = (t, label, ...el) => h_flex().gap(8).items_center()
  .child(div().w(54).flex_none().text_size(12).text_color(t.dim).child(label)).children(el);

/** A dialog button: kind "primary" (solid), "danger" or plain; off dims it; key shows a chip after the text. */
export const button = (t, id, text, kind, fn, off = false, key = null) => {
  const bg = kind === "primary" ? t.solid : kind === "danger" ? t.blocked : null;
  const fg = kind === "primary" ? t.solid_foreground : kind === "danger" ? "#ffffff" : t.foreground;
  return h_flex().id(id).h(32).px(14).gap(8).items_center().justify_center().rounded(8).text_size(12.8).font_medium().text_color(fg)
    .when(!!bg, (el) => el.bg(bg)).when(!bg, (el) => el.border(1).border_color(t.border))
    .when(off, (el) => el.opacity(0.5))
    .when(!off, (el) => el.cursor_pointer().hover((s) => (bg ? s.opacity(0.88) : s.bg(t.hover))).on_click((_e, cx) => fn(cx)))
    .child(text)
    .when(!!key, (el) => el.child(div().text_size(11).opacity(0.6).child(key)));
};

/** The step of a host stage text in steps [{label, match}] (match: a stage prefix); -1 when none fits. */
export const stepOf = (stage, steps) => {
  const s = typeof stage === "string" ? stage : "";
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i].match && s.startsWith(steps[i].match)) return i;
  return -1;
};

/** A progress list: steps before at done, at in progress (or failed with error), the rest waiting. An error
 *  with no step reached (at < 0) shows on its own line above them. */
export const progress = (t, steps, at, error) => v_flex().gap(2).p(6).rounded(10).bg(t.background).border(1).border_color(t.border)
  .when(!!error && at < 0, (el) => el.child(h_flex().px(10).py(7).gap(10).rounded(7).bg(t.blocked + "14")
    .child(h_flex().size(16).flex_none().items_center().justify_center().child(svg(ICON("x")).size(14).text_color(t.blocked)))
    .child(div().flex_1().min_w(0).text_size(12.5).text_color(t.blocked).child(error))))
  .children(steps.map((st, i) => {
    const done = i < at, now = i === at, bad = now && !!error;
    const mark = bad ? svg(ICON("x")).size(14).text_color(t.blocked)
      : done ? svg(ICON("circle-check")).size(15).text_color(t.done)
      : now ? svg(ICON("spinner")).size(14).text_color(t.accent).spin(900)
      : div().size(10).rounded(5).border(1.5).border_color(t.border);
    return v_flex().px(10).py(7).gap(4).rounded(7).when(now, (el) => el.bg(bad ? t.blocked + "14" : t.hover))
      .child(h_flex().gap(10).items_center()
        .child(h_flex().size(16).flex_none().items_center().justify_center().child(mark))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_medium()
          .text_color(bad ? t.blocked : now || done ? t.foreground : t.dim).child(st.label))
        .when(!!st.detail, (el) => el.child(div().flex_none().max_w(220).truncate().text_size(11.5).text_color(t.dim).child(st.detail))))
      .when(bad, (el) => el.child(div().pl(26).text_size(12).text_color(t.muted).child(error)));
  }));

/** A one-line note under a form's fields, lined up with the controls. */
export const note = (t, icon, text, tone = t.dim) => h_flex().pl(62).h(18).gap(6).items_center()
  .child(svg(ICON(icon)).size(12).flex_none().text_color(t.dim))
  .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(tone).child(text));

/** A dimmed stand-in for a control that doesn't apply right now (keeps the dialog's height). */
export const ghost = (t, w, text, icon = null, fn = null) => h_flex().id(`ghost-${text}`).w(w).h(32).px(10).gap(8).items_center().rounded(6)
  .border(1).border_color(t.border).opacity(0.45).text_color(t.dim)
  .when(!!fn, (el) => el.cursor_pointer().on_click((_e, cx) => fn(cx)))
  .when(!!icon, (el) => el.child(svg(ICON(icon)).size(13).flex_none()))
  .child(div().flex_1().min_w(0).truncate().child(text));
