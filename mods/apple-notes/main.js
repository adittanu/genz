// Notes for Herdr, shaped like Apple Notes: folders on the left, the
// notes of one folder in the middle, the chosen note on the right.
// The body is still markdown in notes.json, but it edits like Apple Notes:
// "* ", "[]" and "1. " become a bullet, a checklist and a numbered line,
// and "# ", "> " and "---" become a heading, a quote and a divider.
// To-do, above the folders, lists every open checklist. Hover a checklist
// line to send that one item to an agent in the focused space, or to a new one.
// Everything is kept in data/apple-notes/notes.json, so the notes survive
// restarts and belong to no layout. Opens as a window (mod.json) with
// `mod.open:apple-notes`; Cmd/Ctrl+N makes a note and Cmd/Ctrl+F jumps to
// search. The trash button deletes the open note.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, Textarea, TextareaState, Checkbox, Link } from "gpui-base";
import { theme, settings, appHome, props, closeOverlay, exec, agents, focused, spaces, knownAgents, hc, run, notify, openOverlay } from "herdr";
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
const uiFont = () => settings().ui_font_family;
const monoFont = () => settings().font_family || settings().ui_font_family;
const LIST = new Set(["bullet", "number", "check"]);

function make(kind, text) {
  return { id: uid(), kind, text: text ?? "", indent: 0, checked: false };
}
function parseMarked(raw) {
  if (raw === "---") return make("rule", "");
  let m = raw.match(/^(#{1,3})\s+(.*)$/);
  if (m) return make(m[1].length === 1 ? "h1" : m[1].length === 2 ? "h2" : "h3", m[2]);
  m = raw.match(/^(?:[-*+]\s+)?\[([ xX])\]\s*(.*)$/);
  if (m) {
    const block = make("check", m[2]);
    block.checked = m[1].toLowerCase() === "x";
    return block;
  }
  m = raw.match(/^(?:[-*+]\s+)?\[\]\s*(.*)$/);
  if (m) return make("check", m[1]);
  m = raw.match(/^[-*+]\s+(.*)$/);
  if (m) return make("bullet", m[1]);
  m = raw.match(/^\d+[.)]\s+(.*)$/);
  if (m) return make("number", m[1]);
  m = raw.match(/^>\s(.*)$/);
  if (m) return make("quote", m[1]);
  return null;
}
function parseLine(line) {
  const spaces = line.match(/^ */)?.[0].length ?? 0;
  const marked = parseMarked(line.trimStart());
  if (!marked) return make("p", line);
  if (LIST.has(marked.kind)) marked.indent = Math.min(5, Math.floor(spaces / 2));
  return marked;
}
function parseBody(src) {
  const lines = String(src ?? "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (/^```/.test(lines[i].trim())) {
      const buf = [];
      i += 1;
      while (i < lines.length && !/^```/.test(lines[i].trim())) buf.push(lines[i++]);
      if (i < lines.length) i += 1;
      blocks.push(make("code", buf.join("\n")));
      continue;
    }
    blocks.push(parseLine(lines[i]));
    i += 1;
  }
  return blocks.length ? blocks : [make("p", "")];
}
function lineLooksMarked(line) {
  const raw = line.trimStart();
  if (/^```/.test(raw)) return true;
  return /^(?:#{1,3}\s|[-*+]\s|\d+[.)]\s|>\s|\[\]|\[ \]|\[(?:x|X)\]|---$)/.test(raw) || /^(?:[-*+]\s+)?\[[ xX]?\]/.test(raw);
}
function shortcut(text) {
  if (!/^(?:#{1,3}\s|[-*+]\s|\d+[.)]\s|>\s|\[\]|\[ \]|\[(?:x|X)\]|---$|```$)/.test(text) && !/^(?:[-*+]\s+)?\[[ xX]?\]/.test(text)) return null;
  if (/^```$/.test(text)) return make("code", "");
  return parseMarked(text);
}
function nextKind(kind) {
  return kind === "h1" || kind === "h2" || kind === "h3" || kind === "rule" || kind === "code" ? "p" : kind;
}
function displayNumbers(blocks) {
  const counters = new Map();
  return blocks.map((b) => {
    if (b.kind !== "number") {
      for (const key of [...counters.keys()]) if (key >= (b.indent || 0)) counters.delete(key);
      return 0;
    }
    for (const key of [...counters.keys()]) if (key > (b.indent || 0)) counters.delete(key);
    const n = (counters.get(b.indent || 0) || 0) + 1;
    counters.set(b.indent || 0, n);
    return n;
  });
}
function serialize(blocks) {
  const nums = displayNumbers(blocks);
  return blocks.map((b, i) => {
    const pad = "  ".repeat(b.indent || 0);
    if (b.kind === "h1") return `# ${b.text}`;
    if (b.kind === "h2") return `## ${b.text}`;
    if (b.kind === "h3") return `### ${b.text}`;
    if (b.kind === "bullet") return `${pad}- ${b.text}`;
    if (b.kind === "number") return `${pad}${nums[i]}. ${b.text}`;
    if (b.kind === "check") return `${pad}- [${b.checked ? "x" : " "}]${b.text ? ` ${b.text}` : ""}`;
    if (b.kind === "quote") return `> ${b.text}`;
    if (b.kind === "code") return "```\n" + b.text + "\n```";
    if (b.kind === "rule") return "---";
    return b.text;
  }).join("\n");
}
function inlineParts(text) {
  const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|<u>([\s\S]*?)<\/u>|`([^`\n]+)`|\*\*\*([^*\n]+)\*\*\*|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_/g;
  const parts = [];
  let last = 0;
  for (const m of String(text ?? "").matchAll(re)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    if (m[2]) parts.push({ text: m[1], href: m[2] });
    else if (m[3] != null) parts.push({ text: m[3], underline: true });
    else if (m[4] != null) parts.push({ text: m[4], code: true });
    else if (m[5] != null) parts.push({ text: m[5], bold: true, italic: true });
    else if (m[6] != null) parts.push({ text: m[6], bold: true });
    else if (m[7] != null) parts.push({ text: m[7], strike: true });
    else if (m[8] != null) parts.push({ text: m[8], bold: true });
    else if (m[9] != null) parts.push({ text: m[9], italic: true });
    else if (m[10] != null) parts.push({ text: m[10], italic: true });
    last = m.index + m[0].length;
  }
  if (last < String(text ?? "").length) parts.push({ text: String(text).slice(last) });
  return linkify(parts.length ? parts : [{ text: "" }]);
}
function linkify(parts) {
  const out = [];
  const re = /https?:\/\/[^\s<]+/g;
  for (const part of parts) {
    if (part.href || part.code || !part.text) {
      out.push(part);
      continue;
    }
    let last = 0;
    let hit = false;
    for (const m of part.text.matchAll(re)) {
      hit = true;
      const url = m[0].replace(/[.,;:!?)]+$/, "");
      if (m.index > last) out.push({ ...part, text: part.text.slice(last, m.index) });
      out.push({ text: url, href: url });
      last = m.index + url.length;
    }
    if (!hit) out.push(part);
    else if (last < part.text.length) out.push({ ...part, text: part.text.slice(last) });
  }
  return out;
}
function stripMarkup(line) {
  const raw = String(line ?? "");
  if (/^```/.test(raw.trim()) || raw.trim() === "---") return "";
  const marked = parseMarked(raw.trim());
  const text = marked ? marked.text : raw;
  return inlineParts(text).map((p) => p.text).join("").trim();
}
const plainLines = (text) => String(text ?? "").split("\n").map(stripMarkup).filter(Boolean);
const titleOf = (n) => n.title.trim() || plainLines(n.body)[0] || "New Note";
function openChecks(note) {
  const items = [];
  parseBody(note.body).forEach((b, index) => {
    if (b.kind !== "check" || b.checked) return;
    const text = stripMarkup(b.text);
    if (text) items.push({ index, text });
  });
  return items;
}
function taskPrompt(note, text) {
  const others = [];
  let skipped = false;
  for (const item of openChecks(note)) {
    if (!skipped && item.text === text) {
      skipped = true;
      continue;
    }
    others.push(item.text);
  }
  const lines = [`From Notes, "${titleOf(note)}":`, "", text];
  if (others.length) {
    lines.push("", "Other open items in this note, for context only. Do not do these unless asked:");
    for (const item of others) lines.push(`- ${item}`);
  }
  return lines.join("\n");
}
const snippetOf = (n) => {
  const lines = plainLines(n.body);
  return lines[1] || lines[0] || "No additional text";
};
function textSize(kind) {
  if (kind === "h1") return 28;
  if (kind === "h2") return 22;
  if (kind === "h3") return 17;
  if (kind === "code") return 13;
  return 15.5;
}
function wrapped(text, mark) {
  if (mark === "*") return text.length >= 2 && text.startsWith("*") && text.endsWith("*") && !text.startsWith("**") && !text.endsWith("**");
  if (mark === "<u>") return text.startsWith("<u>") && text.endsWith("</u>") && text.length >= 7;
  return text.length >= mark.length * 2 && text.startsWith(mark) && text.endsWith(mark);
}
function toggleMark(text, mark) {
  if (wrapped(text, mark)) {
    if (mark === "<u>") return text.slice(3, -4);
    return text.slice(mark.length, -mark.length);
  }
  if (mark === "<u>") return `<u>${text}</u>`;
  return mark + text + mark;
}
function placeholderFor(kind, solo) {
  if (kind === "h1") return "Title";
  if (kind === "h2") return "Heading";
  if (kind === "h3") return "Subheading";
  if (kind === "check") return "To-do";
  if (kind === "quote") return "Quote";
  if (kind === "code") return "Code";
  if (kind === "bullet" || kind === "number") return "List";
  if (solo) return "Type *   []   or  1.  then a space";
  return "";
}

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
    const given = props() ?? {};
    if (given.mode === "send") {
      this.agentChoices = [];
      this.agentsReady = false;
      const machine = given.machine;
      cx.spawn(async (cx) => {
        const list = await knownAgents(machine ? { on: machine } : {}).catch(() => []);
        this.agentChoices = list.filter((a) => a.installed);
        this.agentsReady = true;
        cx.notify();
      });
      return;
    }
    this.data = null;
    this.folder = "all";
    this.selected = null;
    this.filter = "";
    this.creatingFolder = false;
    this.applying = false;
    this.splitting = false;
    this.saving = Promise.resolve();
    this.blocks = [];
    this.lineStates = [];
    this.handles = {};
    this.focused = null;
    this.caret = 0;
    this.cursor = 0;
    this.hoverLine = null;

    this.title = InputState.new({ placeholder: "Title" });
    this.search = InputState.new({ placeholder: "Search" });
    this.folderName = InputState.new({ placeholder: "New Folder" });
    this.handle = cx.focus_handle();

    this.title.on("change", (_e, cx) => this.editTitle(cx));
    this.title.on("submit", (_e, cx) => {
      if (this.blocks.length) this.editLine(0, cx);
    });
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
      this.show(first ?? null);
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
    this.applying = false;
    this.mount(note ? parseBody(note.body) : []);
  }

  mount(blocks) {
    for (const state of this.lineStates ?? []) if (state) state.release();
    for (const handle of Object.values(this.handles ?? {})) handle.release();
    this.blocks = blocks;
    this.lineStates = blocks.map(() => null);
    this.handles = {};
    this.focused = null;
    this.caret = 0;
    this.cursor = 0;
    this.splitting = false;
  }

  close() {
    this.mount([]);
  }

  liveText(i) {
    const state = this.lineStates[i];
    if (state) {
      try {
        return state.value();
      } catch {}
    }
    return this.blocks[i]?.text ?? "";
  }

  makeState(block) {
    const solo = this.blocks.length === 1 && !block.text;
    const state = TextareaState.new({ value: block.text, rows: 1, placeholder: placeholderFor(block.kind, solo) });
    state.set_soft_wrap(true);
    state.set_auto_grow(block.kind === "code" ? 2 : 1, block.kind === "code" ? 24 : 10);
    state.on("change", (_e, cx) => this.onText(state, cx));
    state.on("submit", (_e, cx) => {
      if (this.applying || this.splitting) return;
      const i = this.lineStates.indexOf(state);
      const b = this.blocks[i];
      if (i < 0 || !b || b.kind === "code" || state.value().includes("\n")) return;
      this.applySplit(i, [b.text, ""], cx);
    });
    state.on("focus", (_e, cx) => {
      const i = this.lineStates.indexOf(state);
      if (i < 0 || this.focused === i) return;
      this.focused = i;
      this.caret = i;
      cx.notify();
    });
    return state;
  }

  editLine(i, cx, place) {
    const b = this.blocks[i];
    if (!b) return;
    this.caret = i;
    if (!this.handles[b.id]) this.handles[b.id] = cx.focus_handle();
    const len = b.text.length;
    if (typeof place === "number") this.cursor = Math.max(0, Math.min(len, place));
    else if (place === "start") this.cursor = 0;
    else if (place === "end" || this.focused !== i) this.cursor = len;
    this.focused = i;
    if (b.kind === "code" && !this.lineStates[i]) this.lineStates[i] = this.makeState(b);
    const noteId = this.selected;
    const handle = this.handles[b.id];
    const state = this.lineStates[i];
    cx.notify();
    cx.timer.after(20, () => {
      if (this.selected !== noteId || this.focused !== i) return;
      try {
        if (b.kind === "code" && state) {
          state.focus();
          const n = state.value().length;
          const at = this.cursor ?? n;
          state.set_selected_range({ start: at, end: at });
        } else handle.focus();
      } catch {}
    });
  }

  commit(cx) {
    const n = this.current();
    if (!n) return false;
    const value = serialize(this.blocks);
    if (value === n.body) return false;
    n.body = value;
    n.updated = Date.now();
    this.save();
    if (cx) cx.notify();
    return true;
  }

  onText(state, cx) {
    if (this.applying || this.splitting) return;
    const i = this.lineStates.indexOf(state);
    const b = this.blocks[i];
    if (!b) return;
    const text = state.value().replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (b.kind !== "code" && text.includes("\n")) {
      this.applySplit(i, text.split("\n"), cx);
      return;
    }
    if (b.kind !== "code" && text.includes("\t")) {
      const cleaned = text.replace(/\t/g, "");
      const added = text.length - cleaned.length;
      this.applying = true;
      state.set_value(cleaned);
      this.applying = false;
      if (b.kind === "p" || b.kind === "h1" || b.kind === "h2" || b.kind === "h3") b.kind = "bullet";
      else b.indent = Math.min(5, (b.indent || 0) + added);
      b.text = cleaned;
      this.commit(cx);
      return;
    }
    const hit = b.kind === "code" ? null : shortcut(text);
    if (hit) {
      this.applyShortcut(i, hit, cx);
      return;
    }
    if (text === b.text) return;
    b.text = text;
    this.commit(cx);
  }

  applyShortcut(i, hit, cx) {
    const b = this.blocks[i];
    const state = this.lineStates[i];
    if (!b) return;
    if (hit.kind === "rule") {
      b.kind = "rule";
      b.text = "";
      b.checked = false;
      const old = this.lineStates[i];
      this.lineStates[i] = null;
      this.focused = null;
      if (old) cx.timer.after(50, () => { try { old.release(); } catch {} });
      const para = make("p", "");
      this.blocks.splice(i + 1, 0, para);
      this.lineStates.splice(i + 1, 0, null);
      this.commit(cx);
      this.editLine(i + 1, cx);
      return;
    }
    b.kind = hit.kind;
    b.checked = !!hit.checked;
    b.text = hit.text;
    this.cursor = hit.text.length;
    if (state) {
      this.applying = true;
      state.set_value(hit.text);
      this.applying = false;
    }
    this.commit(cx);
    cx.notify();
  }

  applySplit(i, parts, cx) {
    if (this.splitting) return;
    const base = this.blocks[i];
    const state = this.lineStates[i];
    if (!base) return;
    this.splitting = true;
    cx.timer.after(80, () => { this.splitting = false; });
    const listish = LIST.has(base.kind) || base.kind === "quote";
    if (listish && parts.length >= 2 && parts.every((part) => part === "")) {
      if ((base.indent || 0) > 0 && base.kind !== "quote") base.indent -= 1;
      else {
        base.kind = "p";
        base.checked = false;
      }
      base.text = "";
      if (state) {
        this.applying = true;
        state.set_value("");
        this.applying = false;
      }
      this.commit(cx);
      return;
    }
    const produced = parts.map((line, idx) => {
      if (lineLooksMarked(line)) return parseLine(line);
      if (idx === 0) {
        base.text = line;
        return base;
      }
      const child = make(nextKind(base.kind), line);
      if (LIST.has(base.kind) || base.kind === "quote") child.indent = base.indent || 0;
      return child;
    });
    if (produced[0] === base) {
      if (state) {
        this.applying = true;
        state.set_value(base.text);
        this.applying = false;
      }
      const extra = produced.slice(1);
      this.blocks.splice(i + 1, 0, ...extra);
      this.lineStates.splice(i + 1, 0, ...extra.map(() => null));
    } else {
      const old = this.lineStates[i];
      this.blocks.splice(i, 1, ...produced);
      this.lineStates.splice(i, 1, ...produced.map(() => null));
      this.focused = null;
      if (old) cx.timer.after(50, () => { try { old.release(); } catch {} });
    }
    this.commit(cx);
    this.editLine(i + produced.length - 1, cx);
  }

  changeKind(i, kind, cx) {
    const b = this.blocks[i];
    if (!b) return;
    if (kind === "rule") {
      const rule = make("rule", "");
      const para = make("p", "");
      this.blocks.splice(i + 1, 0, rule, para);
      this.lineStates.splice(i + 1, 0, null, null);
      this.commit(cx);
      this.editLine(i + 2, cx);
      return;
    }
    b.kind = b.kind === kind ? "p" : kind;
    if (b.kind !== "check") b.checked = false;
    this.commit(cx);
    this.editLine(i, cx);
  }

  toggleWrap(i, mark, cx) {
    const b = this.blocks[i];
    if (!b || b.kind === "rule") return;
    const next = toggleMark(this.liveText(i), mark);
    b.text = next;
    const state = this.lineStates[i];
    if (state) {
      this.applying = true;
      state.set_value(next);
      this.applying = false;
    }
    this.commit(cx);
    this.editLine(i, cx);
  }

  toggleCheck(i, checked, cx) {
    const b = this.blocks[i];
    if (!b) return;
    b.checked = checked;
    this.caret = i;
    this.commit(cx);
  }

  removeBlock(i, cx) {
    const old = this.lineStates[i];
    const id = this.blocks[i]?.id;
    this.blocks.splice(i, 1);
    this.lineStates.splice(i, 1);
    if (old) cx.timer.after(50, () => { try { old.release(); } catch {} });
    if (this.handles[id]) {
      const handle = this.handles[id];
      delete this.handles[id];
      cx.timer.after(50, () => { try { handle.release(); } catch {} });
    }
    if (!this.blocks.length) {
      this.blocks.push(make("p", ""));
      this.lineStates.push(null);
    }
    this.commit(cx);
    this.editLine(Math.max(0, i - 1), cx);
  }

  onKey(i, e, cx) {
    const b = this.blocks[i];
    if (!b) return;
    if (e.key === "up") {
      if (i > 0) this.editLine(i - 1, cx, "end");
      cx.stop_propagation();
      return;
    }
    if (e.key === "down") {
      if (i + 1 < this.blocks.length) this.editLine(i + 1, cx, "start");
      cx.stop_propagation();
      return;
    }
    const cmd = e.modifiers.platform || e.modifiers.control;
    if (cmd && e.key === "b" && !e.modifiers.shift) return this.finishKey(cx, () => this.toggleWrap(i, "**", cx));
    if (cmd && e.key === "i" && !e.modifiers.shift) return this.finishKey(cx, () => this.toggleWrap(i, "*", cx));
    if (cmd && e.key === "u" && !e.modifiers.shift) return this.finishKey(cx, () => this.toggleWrap(i, "<u>", cx));
    if (cmd && e.modifiers.shift && e.key === "x") return this.finishKey(cx, () => this.toggleWrap(i, "~~", cx));
    if (cmd && e.modifiers.shift && e.key === "8") return this.finishKey(cx, () => this.changeKind(i, "bullet", cx));
    if (cmd && e.modifiers.shift && e.key === "7") return this.finishKey(cx, () => this.changeKind(i, "number", cx));
    if (cmd && e.key === "e" && !e.modifiers.shift) return this.finishKey(cx, () => this.changeKind(i, b.kind === "code" ? "p" : "code", cx));
    if (b.kind === "code" && e.key === "enter" && cmd) {
      const para = make("p", "");
      this.blocks.splice(i + 1, 0, para);
      this.lineStates.splice(i + 1, 0, null);
      this.commit(cx);
      this.editLine(i + 1, cx);
      cx.stop_propagation();
      return;
    }
    if ((e.key === "backspace" || e.key === "delete") && b.kind === "rule") {
      this.removeBlock(i, cx);
      cx.stop_propagation();
      return;
    }
    if (e.key === "backspace" && this.liveText(i) === "" && b.kind !== "code") {
      if (LIST.has(b.kind) && (b.indent || 0) > 0) {
        b.indent -= 1;
        this.commit(cx);
        cx.stop_propagation();
        return;
      }
      if (b.kind !== "p") {
        b.kind = "p";
        b.checked = false;
        this.commit(cx);
        cx.stop_propagation();
        return;
      }
      if (i > 0) {
        this.removeBlock(i, cx);
        cx.stop_propagation();
      }
      return;
    }
    if (e.key === "tab" && b.kind !== "code" && b.kind !== "rule") {
      if (e.modifiers.shift) {
        if ((b.indent || 0) > 0) b.indent -= 1;
        else if (b.kind !== "p") {
          b.kind = "p";
          b.checked = false;
        }
      } else if (b.kind === "p" || b.kind === "h1" || b.kind === "h2" || b.kind === "h3" || b.kind === "quote") {
        b.kind = "bullet";
      } else {
        b.indent = Math.min(5, (b.indent || 0) + 1);
      }
      this.commit(cx);
      cx.stop_propagation();
    }
  }

  finishKey(cx, fn) {
    fn();
    cx.stop_propagation();
  }

  keyLine(i, e, cx) {
    const b = this.blocks[i];
    if (!b) return;
    const cmd = e.modifiers.platform || e.modifiers.control;
    if (e.key === "up") {
      if (i > 0) this.editLine(i - 1, cx, "end");
      cx.stop_propagation();
      return;
    }
    if (e.key === "down") {
      if (i + 1 < this.blocks.length) this.editLine(i + 1, cx, "start");
      cx.stop_propagation();
      return;
    }
    if (e.key === "left") {
      if ((this.cursor || 0) > 0) {
        this.cursor -= 1;
        cx.notify();
      } else if (i > 0) this.editLine(i - 1, cx, "end");
      cx.stop_propagation();
      return;
    }
    if (e.key === "right") {
      if ((this.cursor || 0) < b.text.length) {
        this.cursor += 1;
        cx.notify();
      } else if (i + 1 < this.blocks.length) this.editLine(i + 1, cx, "start");
      cx.stop_propagation();
      return;
    }
    if (e.key === "home") {
      this.cursor = 0;
      cx.notify();
      cx.stop_propagation();
      return;
    }
    if (e.key === "end") {
      this.cursor = b.text.length;
      cx.notify();
      cx.stop_propagation();
      return;
    }
    if (e.key === "backspace") {
      this.backspaceLine(i, cx);
      cx.stop_propagation();
      return;
    }
    if (e.key === "delete") {
      this.deleteForward(i, cx);
      cx.stop_propagation();
      return;
    }
    if (e.key === "enter") {
      this.splitAtCursor(i, cx);
      cx.stop_propagation();
      return;
    }
    if (e.key === "tab") {
      this.onKey(i, e, cx);
      return;
    }
    if (cmd && e.key === "v") {
      cx.stop_propagation();
      cx.spawn(async (cx) => {
        let text = "";
        try {
          const got = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Get-Clipboard -Raw"]);
          text = got.stdout ?? "";
        } catch {
          return;
        }
        if (this.focused !== i) return;
        this.pasteText(i, text, cx);
      });
      return;
    }
    if (cmd && (e.key === "b" || e.key === "i" || e.key === "u" || e.key === "e" || (e.modifiers.shift && (e.key === "x" || e.key === "8" || e.key === "7")))) {
      this.onKey(i, e, cx);
      return;
    }
    if (e.key_char && !cmd && !e.modifiers.alt && !e.modifiers.control) {
      this.insertChars(i, e.key_char, cx);
      cx.stop_propagation();
    }
  }

  insertChars(i, extra, cx) {
    const b = this.blocks[i];
    if (!b || !extra) return;
    const next = b.text.slice(0, this.cursor || 0) + extra + b.text.slice(this.cursor || 0);
    const hit = b.kind === "code" ? null : shortcut(next);
    if (hit) {
      b.text = next;
      this.applyShortcut(i, hit, cx);
      return;
    }
    b.text = next;
    this.cursor = (this.cursor || 0) + extra.length;
    this.commit(cx);
    cx.notify();
  }

  pasteText(i, raw, cx) {
    const text = String(raw ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\u0000/g, "");
    if (!text || !this.blocks[i]) return;
    if (!text.includes("\n")) {
      this.insertChars(i, text, cx);
      return;
    }
    const b = this.blocks[i];
    const left = b.text.slice(0, this.cursor || 0);
    const right = b.text.slice(this.cursor || 0);
    const parts = text.split("\n");
    parts[0] = left + parts[0];
    parts[parts.length - 1] += right;
    b.text = parts[0];
    this.applySplit(i, parts, cx);
  }

  backspaceLine(i, cx) {
    const b = this.blocks[i];
    if (!b) return;
    const at = this.cursor || 0;
    if (at > 0) {
      b.text = b.text.slice(0, at - 1) + b.text.slice(at);
      this.cursor = at - 1;
      this.commit(cx);
      cx.notify();
      return;
    }
    if (b.kind === "code") return;
    if (LIST.has(b.kind) && (b.indent || 0) > 0) {
      b.indent -= 1;
      this.commit(cx);
      cx.notify();
      return;
    }
    if (b.kind !== "p") {
      b.kind = "p";
      b.checked = false;
      this.commit(cx);
      cx.notify();
      return;
    }
    if (i > 0) this.mergeUp(i, cx);
  }

  deleteForward(i, cx) {
    const b = this.blocks[i];
    if (!b) return;
    const at = this.cursor || 0;
    if (at < b.text.length) {
      b.text = b.text.slice(0, at) + b.text.slice(at + 1);
      this.commit(cx);
      cx.notify();
      return;
    }
    const next = this.blocks[i + 1];
    if (!next) return;
    if (next.kind === "rule") {
      this.blocks.splice(i + 1, 1);
      this.lineStates.splice(i + 1, 1);
      this.dropHandle(next.id, cx);
      this.commit(cx);
      this.editLine(i, cx, at);
      return;
    }
    b.text += next.text;
    this.blocks.splice(i + 1, 1);
    this.lineStates.splice(i + 1, 1);
    this.dropHandle(next.id, cx);
    this.commit(cx);
    this.editLine(i, cx, at);
  }

  mergeUp(i, cx) {
    const prev = this.blocks[i - 1];
    const cur = this.blocks[i];
    if (!prev || !cur) return;
    if (prev.kind === "rule") {
      this.blocks.splice(i - 1, 1);
      this.lineStates.splice(i - 1, 1);
      this.dropHandle(prev.id, cx);
      this.commit(cx);
      this.editLine(i - 1, cx, 0);
      return;
    }
    if (prev.kind === "code") {
      this.editLine(i - 1, cx, "end");
      return;
    }
    const at = prev.text.length;
    prev.text = prev.text + cur.text;
    if (this.lineStates[i - 1]) {
      this.applying = true;
      this.lineStates[i - 1].set_value(prev.text);
      this.applying = false;
    }
    this.blocks.splice(i, 1);
    this.lineStates.splice(i, 1);
    this.dropHandle(cur.id, cx);
    this.commit(cx);
    this.editLine(i - 1, cx, at);
  }

  dropHandle(id, cx) {
    const handle = this.handles[id];
    if (!handle) return;
    delete this.handles[id];
    cx.timer.after(40, () => { try { handle.release(); } catch {} });
  }

  splitAtCursor(i, cx) {
    const b = this.blocks[i];
    if (!b || b.kind === "code") return;
    const at = this.cursor || 0;
    const left = b.text.slice(0, at);
    const right = b.text.slice(at);
    const listish = LIST.has(b.kind) || b.kind === "quote";
    if (listish && left === "" && right === "") {
      if ((b.indent || 0) > 0 && b.kind !== "quote") b.indent -= 1;
      else {
        b.kind = "p";
        b.checked = false;
      }
      this.commit(cx);
      cx.notify();
      return;
    }
    b.text = left;
    const child = make(nextKind(b.kind), right);
    if (listish) child.indent = b.indent || 0;
    this.blocks.splice(i + 1, 0, child);
    this.lineStates.splice(i + 1, 0, null);
    this.commit(cx);
    this.editLine(i + 1, cx, "start");
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
    const folder = this.folder === "all" || this.folder === "todo" ? this.data.folders[0]?.id ?? "notes" : this.folder;
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
    if (id !== "todo") {
      const list = this.notes();
      if (!list.some((n) => n.id === this.selected)) this.show(list[0] ?? null);
    }
    cx.notify();
  }

  openCount() {
    return this.data.notes.reduce((n, note) => n + openChecks(note).length, 0);
  }

  taskGroups() {
    const f = this.filter.trim().toLowerCase();
    const groups = [];
    const notes = [...this.data.notes].sort((a, b) => b.updated - a.updated);
    for (const note of notes) {
      const items = openChecks(note).filter((item) => !f || `${item.text} ${titleOf(note)}`.toLowerCase().includes(f));
      if (items.length) groups.push({ note, items });
    }
    return groups;
  }

  openTask(note, index, cx) {
    this.show(note);
    this.editLine(index, cx, "end");
  }

  openSend(i, cx) {
    const note = this.current();
    const text = stripMarkup(this.liveText(i)).trim();
    if (!note || !text) return;
    this.commit(cx);
    const here = focused();
    const space = spaces().find((s) => s.id === here?.space) ?? spaces().find((s) => s.active);
    if (!space) {
      notify({ title: "No space open", body: "Open a space, then send the to-do.", level: "warning" });
      return;
    }
    openOverlay({
      mod: "apple-notes",
      kind: "popup",
      width: 280,
      props: {
        mode: "send",
        space: space.id,
        spaceName: space.name,
        machine: space.machine,
        folder: here?.cwd || space.folder || "",
        text: taskPrompt(note, text),
        taskName: text.replace(/\s+/g, " ").slice(0, 48),
      },
    });
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
    if ((props() ?? {}).mode === "send") return this.sendMenu(t);
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
      .child(this.folderRow(t, dark, { id: "todo", name: "To-do", icon: "todo", count: this.openCount() }))
      .child(div().px(16).pt(8).pb(3).text_size(10.5).font_semibold().text_color(t.dim).child("iCloud"))
      .child(
        v_flex()
          .gap(1)
          .children(
            folders.map((f) => this.folderRow(t, dark, { id: f.id, name: f.name, icon: f.id === "all" ? "notes" : "folder", count: this.countIn(f.id) })),
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

  folderRow(t, dark, row) {
    const here = this.folder === row.id;
    return h_flex()
      .id(`folder-${row.id}`)
      .mx(8)
      .px(9)
      .h(28)
      .gap(8)
      .items_center()
      .rounded(6)
      .when(here, (el) => el.bg(dark ? t.selected : "#dcdcd8"))
      .when(!here, (el) => el.hover((s) => s.bg(t.hover)))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => this.pickFolder(row.id, cx))
      .child(svg(`${FOLDER}${row.icon}.svg`).size(14).flex_none().text_color(YELLOW))
      .child(div().flex_1().truncate().text_size(12.5).child(row.name))
      .child(div().text_size(10.5).text_color(t.dim).child(String(row.count)));
  }

  listColumn(t, notes, selectedBg) {
    if (this.folder === "todo") return this.taskColumn(t);
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

  taskColumn(t) {
    const groups = this.taskGroups();
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
          .child(div().flex_1().truncate().text_size(18).font_semibold().child("To-do"))
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
          .id("todo-list")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .pb(10)
          .when(groups.length === 0, (el) =>
            el.child(
              v_flex()
                .pt(40)
                .px(16)
                .items_center()
                .gap(6)
                .child(svg(`${FOLDER}todo.svg`).size(28).text_color(t.dim))
                .child(div().text_size(12).text_color(t.dim).child(this.filter.trim() ? "No Results" : "No open to-dos"))
                .when(!this.filter.trim(), (box) => box.child(div().text_size(11).text_color(t.dim).child("Type [] in a note"))),
            ),
          )
          .children(
            groups.flatMap((g) => [
              div().px(16).pt(12).pb(4).text_size(10.5).font_semibold().text_color(t.dim).truncate().child(titleOf(g.note)),
              ...g.items.map((item) =>
                v_flex()
                  .id(`task-${g.note.id}-${item.index}`)
                  .mx(8)
                  .px(9)
                  .py(7)
                  .gap(2)
                  .rounded(7)
                  .hover((s) => s.bg(t.hover))
                  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                  .on_click((_e, cx) => this.openTask(g.note, item.index, cx))
                  .child(div().text_size(13).truncate().child(item.text))
                  .child(div().text_size(11).text_color(t.dim).truncate().child(titleOf(g.note))),
              ),
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
                  .font_family(uiFont())
                  .text_size(22)
                  .font_semibold()
                  .text_color(t.foreground),
              ),
          )
          .child(this.formatBar(t))
          .child(this.bodyColumn(t)),
      );
  }

  formatBar(t) {
    const b = this.blocks[this.caret];
    const text = b ? this.liveText(this.caret) : "";
    const tool = (id, label, tip, on, paint) =>
      h_flex()
        .id(id)
        .h(24)
        .px(7)
        .flex_none()
        .items_center()
        .justify_center()
        .rounded(6)
        .cursor_pointer()
        .tooltip(tip)
        .when(on, (el) => el.bg(t.selected))
        .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => paint(cx))
        .child(div().text_size(12).font_semibold().text_color(on ? t.foreground : t.muted).child(label));
    const kind = (id, label, tip, value) => tool(id, label, tip, b?.kind === value, (cx) => this.changeKind(this.caret || 0, value, cx));
    const mark = (id, label, tip, token) => tool(id, label, tip, wrapped(text, token), (cx) => this.toggleWrap(this.caret || 0, token, cx));
    return h_flex()
      .flex_none()
      .flex_wrap()
      .gap(2)
      .pt(2)
      .pb(8)
      .items_center()
      .child(kind("fmt-p", "Aa", "Body", "p"))
      .child(kind("fmt-h1", "H1", "Title", "h1"))
      .child(kind("fmt-h2", "H2", "Heading", "h2"))
      .child(kind("fmt-h3", "H3", "Subheading", "h3"))
      .child(div().w(1).h(14).mx(3).bg(t.border).flex_none())
      .child(kind("fmt-check", "☑", "Checklist", "check"))
      .child(kind("fmt-bullet", "•", "Bulleted list", "bullet"))
      .child(kind("fmt-num", "1.", "Numbered list", "number"))
      .child(div().w(1).h(14).mx(3).bg(t.border).flex_none())
      .child(mark("fmt-b", "B", "Bold", "**"))
      .child(mark("fmt-i", "I", "Italic", "*"))
      .child(mark("fmt-s", "S", "Strikethrough", "~~"))
      .child(mark("fmt-u", "U", "Underline", "<u>"))
      .child(div().w(1).h(14).mx(3).bg(t.border).flex_none())
      .child(kind("fmt-quote", "”", "Quote", "quote"))
      .child(tool("fmt-rule", "—", "Divider", false, (cx) => this.changeKind(this.caret || 0, "rule", cx)))
      .child(kind("fmt-code", "</>", "Code block", "code"));
  }

  bodyColumn(t) {
    const nums = displayNumbers(this.blocks);
    const solo = this.blocks.length === 1 && !this.blocks[0]?.text;
    return v_flex()
      .id("note-body")
      .flex_1()
      .min_h(0)
      .overflow_y_scrollbar()
      .pb(8)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .children([
        ...this.blocks.map((b, i) => this.blockRow(t, b, i, nums[i], solo)),
        div()
          .flex_1()
          .min_h(48)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => {
            cx.stop_propagation();
            if (this.blocks.length) this.editLine(this.blocks.length - 1, cx);
          }),
      ]);
  }

  blockRow(t, b, i, num, solo) {
    if (b.kind === "rule") {
      return h_flex()
        .id(`line-${b.id}`)
        .w_full()
        .h(18)
        .items_center()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.editLine(i, cx);
        })
        .on_key_down((e, cx) => this.onKey(i, e, cx))
        .when(Boolean(this.handles[b.id]), (el) => el.track_focus(this.handles[b.id]))
        .child(div().flex_1().h(1).rounded_full().bg(this.focused === i ? t.muted : t.border));
    }
    const codeEdit = this.focused === i && b.kind === "code" && Boolean(this.lineStates[i]);
    const textEdit = this.focused === i && b.kind !== "code" && Boolean(this.handles[b.id]);
    return h_flex()
      .id(`line-${b.id}`)
      .w_full()
      .min_w(0)
      .items_start()
      .gap(8)
      .py(b.kind === "h1" ? 6 : 2)
      .ml((b.indent || 0) * 18)
      .when(b.kind === "quote", (el) => el.pl(10).border_l(2).border_color(t.border))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_hover((hovered, cx) => {
        if (b.kind !== "check") return;
        const next = hovered ? b.id : null;
        if (this.hoverLine === next || (!hovered && this.hoverLine !== b.id)) return;
        this.hoverLine = next;
        cx.notify();
      })
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.editLine(i, cx);
      })
      .when(LIST.has(b.kind), (el) => el.child(this.gutter(t, b, i, num)))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .when(b.kind === "code", (el) => el.px(10).py(6).rounded(8).bg(t.raised))
          .child(codeEdit ? this.lineEditor(t, b, i) : textEdit ? this.lineField(t, b, i, solo) : this.lineView(t, b, solo)),
      )
      .when(b.kind === "check" && !!stripMarkup(b.text).trim() && this.hoverLine === b.id, (el) => el.child(this.sendButton(t, b, i)));
  }

  sendButton(t, b, i) {
    return h_flex()
      .id(`send-${b.id}`)
      .w(22)
      .h(22)
      .mt(2)
      .flex_none()
      .items_center()
      .justify_center()
      .rounded(5)
      .tooltip("Send to agent")
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.openSend(i, cx);
      })
      .child(svg(`${FOLDER}send.svg`).size(13).text_color(t.muted));
  }

  sendMenu(t) {
    const spec = props() ?? {};
    const here = agents().filter((a) => a.space === spec.space);
    const row = (id, label, sub, dot, onPress) =>
      h_flex()
        .id(id)
        .h(30)
        .px(6)
        .gap(8)
        .items_center()
        .rounded(6)
        .hover((s) => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => {
          cx.stop_propagation();
          onPress();
        })
        .child(div().w(7).h(7).rounded_full().flex_none().bg(dot || t.accent))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).child(label))
        .when(Boolean(sub), (el) => el.child(div().flex_none().max_w(110).truncate().text_size(10.5).text_color(t.dim).child(sub)));
    const safe = (s) => String(s ?? "").replace(/[^A-Za-z0-9_-]/g, "-");
    const heading = (text) => div().px(6).pt(6).pb(2).text_size(10.5).font_semibold().text_color(t.dim).child(text);
    return v_flex()
      .id("send-menu")
      .w_full()
      .max_h(360)
      .bg(t.popover)
      .p(8)
      .gap(2)
      .text_size(13)
      .text_color(t.foreground)
      .overflow_y_scrollbar()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(div().px(6).pb(2).truncate().text_size(12).font_semibold().child(spec.spaceName || "This space"))
      .child(heading("In this conversation"))
      .when(here.length === 0, (el) => el.child(div().px(6).pb(4).text_size(12).text_color(t.muted).child("No agent in this space")))
      .children(here.map((a) => row(`send-live-${safe(a.address)}`, a.program?.name || "Agent", a.title && a.title !== a.program?.name ? a.title : "", t[a.status] || t.idle, () => this.sendTo(a))))
      .child(heading("New conversation"))
      .when(!this.agentsReady, (el) => el.child(div().px(6).text_size(12).text_color(t.muted).child("Looking for agents…")))
      .when(this.agentsReady && this.agentChoices.length === 0, (el) => el.child(div().px(6).text_size(12).text_color(t.muted).child("No agents installed")))
      .children((this.agentChoices ?? []).map((agent, i) => row(`send-new-${safe(agent.key)}-${i}`, agent.name, "", t.accent, () => this.startAgent(agent))));
  }

  sendTo(agent) {
    const spec = props() ?? {};
    hc(["send", agent.address, spec.text])
      .then((r) => {
        if (r?.code) {
          notify({ title: "Couldn't send", body: (r.stderr || r.stdout || "The agent didn't take the message.").trim(), level: "warning" });
          return;
        }
        notify({ title: "Sent to the agent", body: agent.program?.name || "Agent", level: "success" });
        if (spec.overlay) closeOverlay(spec.overlay);
      })
      .catch((e) => notify({ title: "Couldn't send", body: String(e?.message ?? e), level: "warning" }));
  }

  startAgent(agent) {
    const spec = props() ?? {};
    run("tab.new", {
      space: spec.space,
      ...(spec.folder ? { folder: spec.folder } : {}),
      name: spec.taskName || agent.name,
      argv: agent.run,
      task: spec.text,
    });
    notify({ title: `Started ${agent.name}`, body: spec.taskName || "", level: "info" });
    if (spec.overlay) closeOverlay(spec.overlay);
  }

  gutter(t, b, i, num) {
    if (b.kind === "check") {
      return Checkbox.new(b.id)
        .checked(!!b.checked)
        .accessibility_label(b.checked ? "Checked" : "Unchecked")
        .mt(4)
        .w(16)
        .h(16)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(4)
        .border_1()
        .border_color(b.checked ? t.accent : t.muted)
        .cursor_pointer()
        .when(b.checked, (el) => el.bg(t.accent).child(div().text_size(11).text_color(t.accent_foreground).child("✓")))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_change((checked, cx) => this.toggleCheck(i, checked, cx));
    }
    if (b.kind === "bullet") {
      return h_flex().w(16).h(16).mt(6).flex_none().items_center().justify_center().child(div().w(5).h(5).rounded_full().bg(t.foreground));
    }
    if (b.kind === "number") {
      return div().w(22).mt(2).flex_none().text_size(15).text_color(t.muted).child(`${num}.`);
    }
    return div().w(0).flex_none();
  }

  lineField(t, b, i, solo) {
    const text = b.text;
    const at = Math.max(0, Math.min(this.cursor ?? text.length, text.length));
    const size = textSize(b.kind);
    const handle = this.handles[b.id];
    const paint = (el, dim) => {
      el.font_family(uiFont()).text_size(size).text_color(dim ? t.dim : b.checked || b.kind === "quote" ? t.dim : t.foreground);
      if (!dim && (b.kind === "h1" || b.kind === "h2" || b.kind === "h3")) el.font_semibold();
      if (!dim && b.kind === "quote") el.italic();
      if (!dim && b.checked) el.line_through();
      return el;
    };
    const caret = div().w(1).h(Math.max(16, Math.round(size + 4))).flex_none().bg(t.foreground).loop("opacity", { from: 1, to: 0, period: 1100 });
    const kids = [];
    for (let n = 0; n < text.length; n++) {
      if (n === at) kids.push(caret);
      kids.push(paint(div().flex_none(), false).child(text[n] === " " ? "\u00a0" : text[n]));
    }
    if (at >= text.length) kids.push(caret);
    if (!text) kids.push(paint(div().flex_none(), true).child(placeholderFor(b.kind, solo && b.kind === "p") || " "));
    return h_flex()
      .id(`edit-${b.id}`)
      .w_full()
      .min_w(0)
      .min_h(b.kind === "h1" ? 36 : 26)
      .flex_wrap()
      .items_center()
      .track_focus(handle)
      .on_key_down((e, cx) => this.keyLine(i, e, cx))
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        const avg = Math.max(7, size * 0.52);
        const x = e.local_position?.x ?? 0;
        this.editLine(i, cx, Math.max(0, Math.min(text.length, Math.round(x / avg))));
      })
      .on_click((_e, cx) => cx.stop_propagation())
      .children(kids);
  }

  lineEditor(t, b, i) {
    const field = Textarea.new(this.lineStates[i])
      .w_full()
      .min_h(b.kind === "h1" ? 36 : 24)
      .px(0)
      .font_family(b.kind === "code" ? monoFont() : uiFont())
      .text_size(textSize(b.kind))
      .text_color(b.checked || b.kind === "quote" ? t.muted : t.foreground)
      .on_key_down((e, cx) => this.onKey(i, e, cx));
    if (b.kind === "h1" || b.kind === "h2" || b.kind === "h3") field.font_semibold();
    if (b.kind === "quote") field.italic();
    if (b.checked) field.line_through();
    return field;
  }

  lineView(t, b, solo) {
    if (b.kind === "rule") return div().h(8);
    const hint = !b.text ? placeholderFor(b.kind, solo && b.kind === "p") : "";
    if (b.kind === "code") {
      const lines = (b.text || hint || " ").split("\n");
      return v_flex().w_full().children(
        lines.map((line) =>
          div()
            .font_family(monoFont())
            .text_size(13)
            .text_color(b.text ? t.foreground : t.dim)
            .whitespace_normal()
            .child(line || " "),
        ),
      );
    }
    const parts = b.text ? inlineParts(b.text) : [{ text: hint || " " }];
    return h_flex()
      .w_full()
      .min_w(0)
      .min_h(b.kind === "h1" ? 36 : 24)
      .flex_wrap()
      .items_center()
      .children(
        parts.map((p, n) => {
          if (p.href) {
            return Link.new(`${b.id}-${n}`)
              .href(p.href)
              .text_size(textSize(b.kind))
              .text_color(t.accent)
              .underline()
              .child(p.text);
          }
          const el = div()
            .min_w(0)
            .whitespace_normal()
            .font_family(p.code ? monoFont() : uiFont())
            .text_size(textSize(b.kind))
            .text_color(!b.text ? t.dim : b.checked ? t.dim : t.foreground)
            .child(p.text || " ");
          if (p.bold || b.kind === "h1" || b.kind === "h2" || b.kind === "h3") el.font_semibold();
          if (p.italic || b.kind === "quote") el.italic();
          if (p.strike || b.checked) el.line_through();
          if (p.underline) el.underline();
          if (p.code) el.px(4).rounded(4).bg(t.raised);
          return el;
        }),
      );
  }
}
