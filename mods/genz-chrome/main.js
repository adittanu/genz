// Sidebar chrome: the brand row (over the layout's gradient) and the footer.
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, window, shared, setShared, updates, layout } from "herdr";

const ICON = (n) => `mods/workspace-chrome/${n}.svg`;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// genz: the footer is one row (Notes | Settings) in the full sidebar and two stacked icons in the rail,
// so its block follows the sidebar's width. Asked once per change; it settles once the layout matches.
const FOOTER_PX = { row: 42, rail: 68 };
let footerAsked = null;
function fitFooter(collapsed) {
  const want = collapsed ? FOOTER_PX.rail : FOOTER_PX.row;
  const have = find(layout(), "sidebar-footer")?.size?.px;
  if (have === undefined || have === want) { footerAsked = null; return; }
  if (footerAsked === want) return;
  footerAsked = want;
  run("layout.resize", { id: "sidebar-footer", px: want });
}

function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

export default class WorkspaceChrome extends View {
  button(id, label, action, tip) {
    const t = theme();
    return div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).bg("#06162a8c").text_color(t.foreground).hover(s => s.bg("#06162acc").text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action)
      .when(Boolean(tip), el => el.tooltip(tip)).child(label);
  }

  render() {
    const t = theme();
    const collapsed = narrow();
    if (props()?.footer) {
      fitFooter(collapsed);
      const row = (id, icon, label, dim, action) => h_flex().id(id).h(28).px(8).gap(9).flex_none().items_center().rounded(8)
        .text_color(dim ? t.dim : t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .on_click(action).child(svg(icon.startsWith("mods/") ? icon : ICON(icon)).size(14))
        .when(!collapsed, el => el.child(label))
        .when(collapsed, el => el.tooltip(label));
      const notes = row("notes", "mods/genz-chrome/notes.svg", "Notes", false, () => run("mod.open", { name: "apple-notes" }));
      const settings = row("settings", "settings", "Settings", false, () => run("app.settings"))
        .when(Boolean(updates().app.ready), el => el.child(div().size(6).rounded_full().bg(t.accent)));
      // genz: one row in the full sidebar, Notes left and Settings right; stacked icons in the rail.
      const box = collapsed ? v_flex().justify_center() : h_flex().items_center().gap(4);
      return box.size_full().bg(t.chrome).border_t(1).border_color(t.border).px(8).text_size(13)
        .child(notes)
        .when(!collapsed, el => el.child(div().flex_1()))
        .child(settings);
    }
    // No background: the layout paints the brand block's gradient.
    return h_flex().size_full().pl(collapsed ? 6 : 14).pr(10).gap(4).items_center().text_size(14)
      .when(window()?.platform === "macos" && !collapsed, el => el.pl(76))
      .when(!collapsed, el => el.child(h_flex().flex_1().gap(9).items_center()
        // genz: the brand is Kreat, a three-wave mark drawn in the text color right on the header's sea.
        .child(svg("mods/genz-chrome/kreat.svg").size(20).flex_none().text_color(t.foreground))
        .child(div().font_semibold().text_color(t.foreground).child("Kreat"))))
      .when(!(collapsed && window()?.platform === "macos"), el => el.child(this.button("sidebar-toggle", svg(ICON("sidebar")).size(15), toggleSidebar, "Toggle sidebar")));
  }
}
