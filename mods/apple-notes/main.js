// Notes for Herdr, shaped like Apple Notes: folders on the left, the
// notes of one folder in the middle, the chosen note on the right.
// Everything is kept in data/apple-notes/notes.json, so the notes survive
// restarts and belong to no layout. Opens as a window (mod.json) with
// `mod.open:apple-notes`; Cmd/Ctrl+N makes a note and Cmd/Ctrl+F jumps to
// search. The trash button deletes the open note.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Editor, EditorState } from "gpui-base";
import { theme, settings, appHome, props, closeOverlay } from "herdr";
import * as fs from "fs/promises";

const YELLOW = "#f2c14e";
const FOLDER = "mods/apple-notes/";
const STORE = () => `${appHome()}/data/apple-notes/notes.json`;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = (n) => String(n).padStart(2, "0");

function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtFull(ts) {
  const d = new Date(ts);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} at ${fmtTime(ts)}`;
}
function fmtShort(ts) {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return fmtTime(ts);
  if (d.getFullYear() === now.getFullYear()) return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}
function groupOf(ts) {
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(new Date()) - day(new Date(ts))) / 86400000);
  if (diff <= 0) return "Today";
  if (diff < 7) return "Previous 7 Days";
  if (diff < 30) return "Previous 30 Days";
  return "Older";
}
const firstLine = (text) => (text ?? "").split("\n").map((s) => s.trim()).find(Boolean) ?? "";
const titleOf = (n) => n.title.trim() || firstLine(n.body) || "New Note";
const snippetOf = (n) => {
  const lines = (n.body ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
  return lines.length > 1 ? lines[1] : lines[0] ?? "No additional text";
};

function seed() {
  const now = Date.now();
  const day = 86400000;
  const mk = (folder, title, body, ago) => ({
    id: uid(),
    folder,
    title,
    body,
    created: now - ago,
    updated: now - ago,
  });
  return {
    folders: [
      { id: "notes", name: "Notes" },
      { id: "work", name: "Work" },
      { id: "ideas", name: "Ideas" },
    ],
    notes: [
      mk(
        "notes",
        "Welcome to Notes",
        "A quiet place for everything you don't want to forget.\n\nFolders keep things apart, search finds them again, and every word is saved as you type — no Save button, no dialog.",
        0,
      ),
      mk(
        "work",
        "Herdr mod checklist",
        "Write the mod, run `herdr-app check`, look at a screenshot, then write the recipe from the real files.\n\nA mod is one folder: main.js, mod.json and its icons.",
        day + 3600000,
      ),
      mk(
        "ideas",
        "Weekend",
        "Bike to the coast early, before the heat.\n\nBring the small camera and the notebook.",
        day * 3,
      ),
    ],
  };
}

export default class AppleNotes extends View {
  init(_props, cx) {
    this.data = null;
    this.folder = "all";
    this.selected = null;
    this.filter = "";
    this.creatingFolder = false;
    this.applying = false;
    this.saving = Promise.resolve();

    this.title = InputState.new({ placeholder: "Title" });
    this.body = EditorState.new({
      language: "txt",
      value: "",
      line_numbers: false,
      folding: false,
      soft_wrap: true,
      font_family: settings().ui_font_family,
      font_size: 13.5,
    });
    this.search = InputState.new({ placeholder: "Search" });
    this.folderName = InputState.new({ placeholder: "New Folder" });
    this.handle = cx.focus_handle();

    this.title.on("change", (_e, cx) => this.editTitle(cx));
    this.body.on("change", (_e, cx) => this.editBody(cx));
    this.search.on("change", (_e, cx) => {
      this.filter = this.search.value();
      cx.notify();
    });
    this.folderName.on("submit", (_e, cx) => this.addFolder(cx));

    this.load(cx);
  }

  load(cx) {
    cx.spawn(async (cx) => {
      let raw = null;
      try {
        raw = await fs.readFile(STORE(), "utf8");
      } catch {}
      if (raw) {
        try {
          this.data = JSON.parse(raw);
        } catch {
          this.data = seed();
          this.save();
        }
      } else {
        this.data = seed();
        this.save();
      }
      if (!Array.isArray(this.data.folders)) this.data.folders = seed().folders;
      if (!Array.isArray(this.data.notes)) this.data.notes = [];
      this.data.folders = this.data.folders.filter((f) => f && f.id && f.name);
      this.data.notes = this.data.notes.filter((n) => n && n.id);
      for (const n of this.data.notes) {
        n.title = n.title ?? "";
        n.body = n.body ?? "";
        n.updated = n.updated ?? n.created ?? Date.now();
        n.created = n.created ?? n.updated;
        if (!this.data.folders.some((f) => f.id === n.folder)) n.folder = this.data.folders[0]?.id ?? "notes";
      }
      if (!this.data.folders.length) this.data.folders = [{ id: "notes", name: "Notes" }];
      const first = this.notes()[0];
      if (first) this.show(first);
      cx.notify();
    });
  }

  save() {
    const path = STORE();
    const text = JSON.stringify(this.data, null, 2);
    const dir = path.slice(0, path.lastIndexOf("/"));
    this.saving = this.saving
      .then(async () => {
        try {
          await fs.mkdir(dir, { recursive: true });
          await fs.writeFile(path, text);
        } catch {}
      })
      .catch(() => {});
  }

  notes() {
    const f = this.filter.trim().toLowerCase();
    return this.data.notes
      .filter((n) => this.folder === "all" || n.folder === this.folder)
      .filter((n) => !f || `${n.title} ${n.body}`.toLowerCase().includes(f))
      .sort((a, b) => b.updated - a.updated);
  }

  current() {
    return this.data?.notes.find((n) => n.id === this.selected) ?? null;
  }

  countIn(folder) {
    return this.data.notes.filter((n) => folder === "all" || n.folder === folder).length;
  }

  show(note) {
    this.selected = note?.id ?? null;
    this.applying = true;
    this.title.set_value(note?.title ?? "");
    this.body.set_value(note?.body ?? "");
    this.applying = false;
  }

  editTitle(cx) {
    if (this.applying) return;
    const n = this.current();
    if (!n) return;
    const value = this.title.value();
    if (value === n.title) return;
    n.title = value;
    n.updated = Date.now();
    this.save();
    cx.notify();
  }

  editBody(cx) {
    if (this.applying) return;
    const n = this.current();
    if (!n) return;
    const value = this.body.value();
    if (value === n.body) return;
    n.body = value;
    n.updated = Date.now();
    this.save();
    cx.notify();
  }

  newNote(cx) {
    if (!this.data) return;
    const folder = this.folder === "all" ? this.data.folders[0]?.id ?? "notes" : this.folder;
    const now = Date.now();
    const n = { id: uid(), folder, title: "", body: "", created: now, updated: now };
    this.data.notes.push(n);
    this.show(n);
    this.save();
    this.title.focus();
    cx.notify();
  }

  deleteNote(cx) {
    const n = this.current();
    if (!n) return;
    const all = this.notes();
    const at = all.findIndex((x) => x.id === n.id);
    this.data.notes = this.data.notes.filter((x) => x.id !== n.id);
    const next = all[at + 1] ?? all[at - 1] ?? null;
    this.show(next);
    this.save();
    cx.notify();
  }

  pickFolder(id, cx) {
    this.folder = id;
    const list = this.notes();
    if (!list.some((n) => n.id === this.selected)) this.show(list[0] ?? null);
    cx.notify();
  }

  addFolder(cx) {
    if (!this.data) return;
    const name = this.folderName.value().trim();
    if (name) {
      const id = uid();
      this.data.folders.push({ id, name });
      this.folder = id;
      this.show(null);
      this.save();
    }
    this.creatingFolder = false;
    this.folderName.set_value("");
    cx.notify();
  }

  iconButton(name, size, color, onPress) {
    return h_flex()
      .id(`btn-${name}`)
      .w(26)
      .h(26)
      .flex_none()
      .items_center()
      .justify_center()
      .rounded(6)
      .hover((s) => s.bg(theme().hover))
      .on_click((_e, cx) => onPress(cx))
      .child(svg(`${FOLDER}${name}.svg`).size(size).text_color(color));
  }

  render(cx) {
    const t = theme();
    const dark = Boolean(settings().dark);
    const selectedBg = dark ? "#4a3c12" : "#f8e6a3";
    if (!this.data) {
      return v_flex().size_full().bg(t.background).items_center().justify_center().child(div().text_size(12).text_color(t.dim).child("Loading notes…"));
    }
    const notes = this.notes();
    const current = this.current();
    return h_flex()
      .id("notes-root")
      .size_full()
      .bg(t.background)
      .text_color(t.foreground)
      .text_size(13)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        const cmd = e.modifiers.control || e.modifiers.platform;
        if (!cmd) return;
        if (e.key === "n") this.newNote(cx);
        else if (e.key === "f") this.search.focus();
        else return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(this.sidebar(t, dark))
      .child(div().w(1).h_full().flex_none().bg(t.border))
      .child(this.listColumn(t, notes, selectedBg))
      .child(div().w(1).h_full().flex_none().bg(t.border))
      .child(this.editor(t, current));
  }

  sidebar(t, dark) {
    const folders = [{ id: "all", name: "All Notes" }, ...this.data.folders];
    return v_flex()
      .w(196)
      .h_full()
      .flex_none()
      .bg(t.chrome)
      .pt(16)
      .pb(8)
      .child(
        h_flex()
          .px(14)
          .pb(8)
          .items_center()
          .gap(6)
          .child(div().text_size(18).font_semibold().child("Notes"))
          .child(div().flex_1())
          .child(
            this.iconButton("folder-plus", 15, t.muted, (cx) => {
              this.creatingFolder = true;
              this.folderName.set_value("");
              this.folderName.focus();
              cx.notify();
            }),
          ),
      )
      .child(div().px(16).pb(3).text_size(10.5).font_semibold().text_color(t.dim).child("iCloud"))
      .child(
        v_flex()
          .gap(1)
          .children(
            folders.map((f) => {
              const here = this.folder === f.id;
              return h_flex()
                .id(`folder-${f.id}`)
                .mx(8)
                .px(9)
                .h(28)
                .gap(8)
                .items_center()
                .rounded(6)
                .when(here, (el) => el.bg(dark ? t.selected : "#dcdcd8"))
                .when(!here, (el) => el.hover((s) => s.bg(t.hover)))
                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                .on_click((_e, cx) => this.pickFolder(f.id, cx))
                .child(svg(`${FOLDER}${f.id === "all" ? "notes" : "folder"}.svg`).size(14).flex_none().text_color(YELLOW))
                .child(div().flex_1().truncate().text_size(12.5).child(f.name))
                .child(div().text_size(10.5).text_color(t.dim).child(String(this.countIn(f.id))));
            }),
          ),
      )
      .when(this.creatingFolder, (el) =>
        el.child(
          h_flex()
            .mx(8)
            .mt(4)
            .h(26)
            .px(7)
            .gap(6)
            .items_center()
            .rounded(6)
            .bg(t.background)
            .border_1()
            .border_color(t.input)
            .child(svg(`${FOLDER}folder.svg`).size(13).flex_none().text_color(YELLOW))
            .child(
              Input.new(this.folderName)
                .flex_1()
                .h_full()
                .font_family(settings().ui_font_family)
                .text_size(12)
                .text_color(t.foreground)
                .on_key_down((e, cx) => {
                  if (e.key !== "escape") return;
                  this.creatingFolder = false;
                  this.folderName.set_value("");
                  cx.stop_propagation();
                  cx.notify();
                }),
            ),
        ),
      )
      .child(div().flex_1());
  }

  listColumn(t, notes, selectedBg) {
    const folderName = this.folder === "all" ? "All Notes" : this.data.folders.find((f) => f.id === this.folder)?.name ?? "Notes";
    const groups = [];
    for (const n of notes) {
      const g = groupOf(n.updated);
      const last = groups[groups.length - 1];
      if (last?.name === g) last.notes.push(n);
      else groups.push({ name: g, notes: [n] });
    }
    return v_flex()
      .w(292)
      .h_full()
      .flex_none()
      .bg(t.background)
      .child(
        h_flex()
          .px(14)
          .pt(12)
          .pb(6)
          .gap(6)
          .items_center()
          .child(div().flex_1().truncate().text_size(18).font_semibold().child(folderName))
          .child(this.iconButton("square-pen", 17, t.muted, (cx) => this.newNote(cx))),
      )
      .child(
        h_flex()
          .px(12)
          .pb(8)
          .items_center()
          .child(
            h_flex()
              .flex_1()
              .h(28)
              .px(8)
              .gap(6)
              .items_center()
              .rounded(7)
              .bg(t.raised)
              .child(svg(`${FOLDER}search.svg`).size(12).flex_none().text_color(t.dim))
              .child(Input.new(this.search).flex_1().h_full().font_family(settings().ui_font_family).text_size(12).text_color(t.foreground)),
          ),
      )
      .child(
        v_flex()
          .id("note-list")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .pb(10)
          .when(notes.length === 0, (el) =>
            el.child(
              v_flex()
                .pt(40)
                .items_center()
                .gap(6)
                .child(svg(`${FOLDER}note.svg`).size(28).text_color(t.dim))
                .child(div().text_size(12).text_color(t.dim).child(this.filter.trim() ? "No Results" : "No Notes")),
            ),
          )
          .children(
            groups.flatMap((g) => [
              div().px(16).pt(12).pb(4).text_size(10.5).font_semibold().text_color(t.dim).child(g.name),
              ...g.notes.map((n) => this.noteRow(t, n, selectedBg)),
            ]),
          ),
      );
  }

  noteRow(t, n, selectedBg) {
    const here = n.id === this.selected;
    return v_flex()
      .id(`note-${n.id}`)
      .mx(8)
      .px(9)
      .py(7)
      .gap(3)
      .rounded(7)
      .when(here, (el) => el.bg(selectedBg))
      .when(!here, (el) => el.hover((s) => s.bg(t.hover)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        this.show(n);
        cx.notify();
      })
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().child(titleOf(n)))
          .child(div().flex_none().text_size(10.5).text_color(here ? t.muted : t.dim).child(fmtShort(n.updated))),
      )
      .child(div().text_size(11.5).text_color(t.muted).truncate().child(snippetOf(n)));
  }

  editor(t, note) {
    return v_flex()
      .flex_1()
      .min_w(0)
      .h_full()
      .bg(t.background)
      .px(30)
      .pt(8)
      .pb(14)
      .when(!note, (el) =>
        el
          .items_center()
          .justify_center()
          .gap(10)
          .child(svg(`${FOLDER}note.svg`).size(44).text_color(t.dim))
          .child(div().text_size(15).font_semibold().text_color(t.muted).child("No Note Selected"))
          .child(div().text_size(12).text_color(t.dim).child("Choose a note from the list, or start a new one."))
          .child(
            h_flex()
              .mt(4)
              .h(30)
              .px(12)
              .gap(6)
              .items_center()
              .rounded(7)
              .bg(t.solid)
              .on_click((_e, cx) => this.newNote(cx))
              .child(svg(`${FOLDER}square-pen.svg`).size(13).text_color(t.solid_foreground))
              .child(div().text_size(12).font_semibold().text_color(t.solid_foreground).child("New Note")),
          ),
      )
      .when(Boolean(note), (el) =>
        el
          .child(
            h_flex()
              .h(28)
              .flex_none()
              .items_center()
              .child(h_flex().flex_1().flex_basis(0))
              .child(div().flex_none().text_size(10.5).text_color(t.dim).child(fmtFull(note.updated)))
              .child(
                h_flex()
                  .flex_1()
                  .flex_basis(0)
                  .justify_end()
                  .gap(2)
                  .child(this.iconButton("trash", 15, t.muted, (cx) => this.deleteNote(cx)))
                  .child(
                    this.iconButton("x", 14, t.muted, () => {
                      if (props().overlay) closeOverlay(props().overlay);
                    }),
                  ),
              ),
          )
          .child(
            v_flex()
              .flex_none()
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .child(
                Input.new(this.title)
                  .h(38)
                  .flex_none()
                  .px(0)
                  .font_family(settings().ui_font_family)
                  .text_size(22)
                  .font_semibold()
                  .text_color(t.foreground),
              ),
          )
          .child(
            v_flex()
              .flex_1()
              .min_h(0)
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .child(
                Editor.new(this.body)
                  .flex_1()
                  .min_h(0)
                  .w_full()
                  .text_color(t.foreground),
              ),
          ),
      );
  }
}
