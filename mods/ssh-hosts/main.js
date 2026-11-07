// SSH Hosts: a host manager that lives in its own tab.
// Left: All / Recent / groups. Middle: search + a dense, keyboard-driven host list.
// Right: the selected host (connect, split, copy, edit), the host form, or Import / Export.
// Enter connects, Shift+Enter splits, double click connects. Hosts live in <appHome>/data/ssh-hosts.json.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import { run, hc, exec, window, terminals, focused, shared, setShared, theme, appHome, home, readTextFile, writeTextFile, notify, nextCommand, pickFolder } from "herdr";
import { fromLiteTerm, mergeHosts, toLiteTerm } from "./liteterm.js";

const ICON = (n) => `mods/ssh-hosts/${n}.svg`;
const ROW_H = 54;
const RECENT = "\u0000recent"; // the Recent view's group key; no real group can be named this
const FIELDS = [
  ["label", "Label", "prod-api"],
  ["host", "Address", "203.0.113.10 or example.com"],
  ["user", "Username", "root"],
  ["password", "Password", "Typed for you when ssh asks"],
  ["port", "Port", "22"],
  ["group", "Group", "Production"],
  ["identity", "Key file", "~/.ssh/id_ed25519"],
];
const AUTHS = [
  ["default", "Default", "ssh uses your agent, ~/.ssh keys or ~/.ssh/config, and asks for a password if it needs one."],
  ["password", "Password", "Saved as plain text in data/ssh-hosts.json and typed once when ssh asks for it."],
  ["key", "Key file", "Passed to ssh with -i."],
];

// Named hosts from ~/.ssh/config (no wildcard patterns).
function parseConfig(text) {
  const out = [];
  let cur = null;
  for (const raw of (text ?? "").split("\n")) {
    const m = raw.trim().match(/^([^\s#=]+)\s*=?\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "host") {
      const name = value.split(/\s+/).find((h) => h && !/[*?!]/.test(h));
      cur = name ? { label: name, alias: name, host: "", user: "", port: "", identity: "", group: "ssh config" } : null;
      if (cur) out.push(cur);
    } else if (key === "match") cur = null;
    else if (cur && key === "hostname") cur.host = value;
    else if (cur && key === "user") cur.user = value;
    else if (cur && key === "port") cur.port = value;
    else if (cur && key === "identityfile") cur.identity = value;
  }
  return out;
}

function sshArgv(h) {
  if (h.alias) return ["ssh", h.alias];
  const argv = ["ssh"];
  if (h.port && h.port !== "22") argv.push("-p", String(h.port));
  if (h.identity) argv.push("-i", h.identity.replace(/^~/, home()));
  argv.push(h.user ? `${h.user}@${h.host}` : h.host);
  return argv;
}
const shellLine = (argv) => argv.map((a) => (/^[\w@%+=:,./~-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, "\\$1")}"`)).join(" ");

const target = (h) => (h.alias && !h.host ? h.alias : `${h.user ? h.user + "@" : ""}${h.host}${h.port && h.port !== "22" ? ":" + h.port : ""}`);
const authOf = (h) => (h.identity ? "key" : h.password ? "password" : "default");
const expand = (p) => String(p ?? "").trim().replace(/^~(?=$|[\\/])/, home());

function initials(text) {
  const parts = String(text ?? "").split(/[\s._\-:@/]+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function ago(ms, short) {
  if (!ms) return short ? "" : "Never";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return short ? "now" : "Just now";
  const [n, unit] = s < 3600 ? [Math.floor(s / 60), "m"] : s < 86400 ? [Math.floor(s / 3600), "h"] : [Math.floor(s / 86400), "d"];
  if (short) return n > 99 && unit === "d" ? `${Math.floor(n / 30)}mo` : `${n}${unit}`;
  return `${n}${unit} ago`;
}

function hash(text) {
  let x = 0;
  for (const ch of String(text ?? "")) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return x;
}

// Dummy names are chosen from the host's place in the list, never from its real text.
const DUMMY_LABELS = ["web-01", "db-primary", "api-edge", "cache-01", "worker-02", "mail-01", "git-01", "monitor", "bastion", "files-01", "staging-app", "backup-01", "queue-01", "search-01", "edge-01", "metrics"];
const DUMMY_USERS = ["deploy", "ubuntu", "app", "svc", "admin"];
const DUMMY_GROUPS = ["Production", "Staging", "Internal", "Lab", "Shared"];
const PRIVACY_MODES = ["normal", "blur", "dummy"];
const MASKED_FIELDS = ["label", "host", "user", "group", "identity"];

function dummyPick(list, index) {
  const base = list[index % list.length];
  const lap = Math.floor(index / list.length);
  return lap ? `${base}-${lap + 1}` : base;
}
const dummyLabel = (index) => dummyPick(DUMMY_LABELS, index);
const dummyUser = (index) => DUMMY_USERS[index % DUMMY_USERS.length];
const dummyAddress = (index) => `10.${(index % 8) + 1}.${(index % 16) + 1}.${(index % 200) + 10}`;
function dummyGroupName(hosts, name) {
  const names = [];
  for (const h of hosts) {
    const g = h.group || "Ungrouped";
    if (!names.includes(g)) names.push(g);
  }
  return dummyPick(DUMMY_GROUPS, Math.max(0, names.indexOf(name || "Ungrouped")));
}

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

// A typed or pasted name: example.com, or https://example.com:443/path.
function domainOf(raw) {
  let s = String(raw ?? "").trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  s = s.split(/[/?#]/)[0].replace(/:\d+$/, "").replace(/\.$/, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(s)) return null;
  if (IPV4.test(s)) return null;
  return s;
}

function parseAddresses(text) {
  const ips = new Set();
  const v4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
  const v6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi;
  const body = String(text ?? "");
  for (const m of body.matchAll(v4)) ips.add(m[0]);
  for (const m of body.matchAll(v6)) ips.add(m[0].toLowerCase());
  return [...ips];
}

// One address per line. Windows uses the system resolver; elsewhere, nslookup after the "Name:" line
// so the resolver's own address is not treated as the answer.
async function resolveName(name) {
  try {
    if (window()?.platform === "windows") {
      const script = `foreach ($t in 'A','AAAA') { Resolve-DnsName -Name '${name}' -Type $t -ErrorAction SilentlyContinue | ForEach-Object { $_.IPAddress } }`;
      const r = await exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
      return parseAddresses(r.stdout);
    }
    const r = await exec("nslookup", [name]);
    const text = `${r.stdout}\n${r.stderr}`;
    const at = text.search(/^Name:/im);
    return at < 0 ? [] : parseAddresses(text.slice(at).replace(/^Name:.*$/im, ""));
  } catch {
    return null;
  }
}

// Our own data file ({ hosts: [...] }) can be imported too, not only LiteTerm's.
function ownHosts(text) {
  try {
    const d = JSON.parse(text);
    if (Array.isArray(d?.hosts) && d.hosts.length && d.hosts.every((h) => h && (h.host || h.alias))) return d.hosts.map((h) => ({ ...h }));
  } catch {}
  return null;
}

function store(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function keep(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}

export default class SshHosts extends View {
  init(_props, cx) {
    this.hosts = [];
    this.raw = null; // file text as last read, for writeTextFile's check
    this.loaded = false;
    this.query = "";
    this.group = null; // null = all hosts, RECENT, or a group name
    this.selected = null; // index into this.hosts
    this.sort = store("sort", "name"); // name | recent
    this.panel = null; // null (details) | "form" | "transfer"
    this.size = null;
    this.lastClick = null; // { key, at } for double click on a row
    this.undo = null; // { entry, index, id }
    this.copied = null; // index whose command was just copied
    this.error = "";
    this.focusedField = null;
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();

    // Import / Export
    this.busy = false;
    this.note = "";
    this.noteError = false;
    this.overwrite = null; // path the next Export may replace
    this.pathInput = this.field({ placeholder: "C:\\Users\\you\\Downloads\\liteterm-hosts.json", value: [home(), "Downloads", "liteterm-hosts.json"].join(this.sep()) }, "path", cx);
    this.pathInput.on("change", (_e, cx) => { this.overwrite = null; cx.notify(); });
    this.pathInput.on("submit", (_e, cx) => this.importFile(this.pathInput.value(), cx));

    // DNS: a typed domain also finds saved hosts on the same server.
    this.dns = new Map(); // hostname -> addresses
    this.dnsPending = new Map();
    this.lookup = null; // { name, status: wait|loading|done|error, ips }
    this.lookupGen = 0;
    this.lookupWait = 0;

    this.search = this.field({ placeholder: "Search label, address, user or group" }, "search", cx);
    this.search.on("change", (_e, cx) => {
      this.query = this.search.value();
      this.scheduleLookup(cx);
      const first = this.query.trim() ? this.filtered()[0] : null;
      if (first) { this.selected = first.i; this.scroll.scroll_to_item(0); }
      cx.notify();
    });
    this.search.on("submit", (e, cx) => {
      const row = this.current() ?? this.filtered()[0];
      if (row) this.connect(row.h, e?.shift ? "split" : "tab", cx);
    });

    // Host form
    this.editing = null; // index being edited, or null for a new host
    this.values = {};
    this.auth = "default";
    this.showPassword = false;
    this.errors = {};
    this.inputs = {};
    const hidden = this.viewMode() !== "normal";
    for (const [key, , ph] of FIELDS) {
      const s = this.field({ placeholder: ph }, key, cx);
      if (key === "password" || (hidden && MASKED_FIELDS.includes(key))) s.set_masked(true);
      s.on("change", (_e, cx) => { this.values[key] = s.value(); if (this.errors[key]) delete this.errors[key]; cx.notify(); });
      s.on("submit", (_e, cx) => this.save(cx));
      this.inputs[key] = s;
    }

    this.pending = []; // ssh terminals waiting for their password prompt
    cx.timer.every(500, (cx) => this.tick(cx));
    cx.timer.every(60000, (cx) => cx.notify()); // "3m ago" labels

    cx.spawn(async (cx) => {
      this.raw = await readTextFile(this.file()).catch(() => null);
      try { this.hosts = this.raw ? JSON.parse(this.raw).hosts ?? [] : []; } catch { this.hosts = []; }
      this.loaded = true;
      cx.notify();
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.search.focus();
        cx.notify();
      }
    });
    cx.timer.after(120, () => this.search.focus());
  }

  field(options, name, _cx) {
    const s = InputState.new(options);
    s.on("focus", (_e, cx) => { this.focusedField = name; cx.notify(); });
    s.on("blur", (_e, cx) => { if (this.focusedField === name) this.focusedField = null; cx.notify(); });
    return s;
  }

  file() { return `${appHome()}/data/ssh-hosts.json`; }
  sep() { return window()?.platform === "windows" ? "\\" : "/"; }

  async persist() {
    const text = JSON.stringify({ hosts: this.hosts }, null, 2);
    try {
      await writeTextFile(this.file(), text, this.raw);
      this.raw = text;
      this.error = "";
    } catch (e) {
      this.error = `Couldn't save: ${e}`;
    }
  }

  saveLater(cx) {
    cx.spawn(async (cx) => { await this.persist(); cx.notify(); });
  }

  // ---- data ----

  groups() {
    const m = new Map();
    for (const h of this.hosts) m.set(h.group || "Ungrouped", (m.get(h.group || "Ungrouped") ?? 0) + 1);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
  }

  recentCount() { return this.hosts.filter((h) => h.lastUsed).length; }

  filtered() {
    const tokens = this.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const name = domainOf(this.query);
    const found = name && this.lookup?.name === name && this.lookup.status === "done" ? new Set(this.lookup.ips) : null;
    const recent = this.group === RECENT;
    const rows = this.hosts
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => {
        if (found && this.sharesAddress(h, found)) return true;
        const inGroup = this.group === null || (recent ? Boolean(h.lastUsed) : (h.group || "Ungrouped") === this.group);
        const hay = [h.label, h.host, h.user, h.group, h.alias, h.port].map((v) => String(v ?? "").toLowerCase()).join(" ");
        return inGroup && tokens.every((tok) => hay.includes(tok));
      })
      .map((row) => {
        const addr = (row.h.host || "").trim().toLowerCase();
        const byIp = Boolean(found && this.sharesAddress(row.h, found) && addr !== name);
        return { ...row, via: byIp ? `${name} is on this server` : null };
      });
    const byName = (a, b) => String(a.h.label || target(a.h)).localeCompare(String(b.h.label || target(b.h)), undefined, { sensitivity: "base", numeric: true });
    if (recent || this.sort === "recent") rows.sort((a, b) => (b.h.lastUsed ?? 0) - (a.h.lastUsed ?? 0) || byName(a, b));
    else rows.sort(byName);
    return rows;
  }

  current() {
    if (this.selected === null) return null;
    return this.filtered().find((r) => r.i === this.selected) ?? null;
  }

  sharesAddress(h, ips) {
    const addr = (h.host || "").trim().toLowerCase();
    if (!addr) return false;
    if (ips.has(addr)) return true;
    const known = this.dns.get(addr);
    return Array.isArray(known) && known.some((ip) => ips.has(ip));
  }

  // Wait until typing pauses, then resolve the domain and any saved hostnames.
  scheduleLookup(cx) {
    const name = domainOf(this.query);
    this.lookupWait += 1;
    const wait = this.lookupWait;
    if (!name) { this.lookup = null; this.lookupGen += 1; return; }
    this.lookup = { name, status: "wait", ips: this.dns.get(name) ?? [] };
    cx.timer.after(350, (cx) => {
      if (wait !== this.lookupWait) return;
      this.resolveQuery(name, cx);
    });
  }

  addresses(name) {
    if (this.dns.has(name)) return Promise.resolve(this.dns.get(name));
    if (this.dnsPending.has(name)) return this.dnsPending.get(name);
    const pending = resolveName(name).then((ips) => {
      this.dnsPending.delete(name);
      if (ips) this.dns.set(name, ips);
      return ips;
    });
    this.dnsPending.set(name, pending);
    return pending;
  }

  resolveQuery(name, cx) {
    const gen = ++this.lookupGen;
    this.lookup = { name, status: "loading", ips: this.dns.get(name) ?? [] };
    cx.notify();
    cx.spawn(async (cx) => {
      const ips = await this.addresses(name);
      const names = [...new Set(this.hosts.map((h) => (h.host || "").trim().toLowerCase())
        .filter((n) => n && n !== name && !IPV4.test(n) && !n.includes(":")))];
      for (let i = 0; i < names.length; i += 4) {
        await Promise.all(names.slice(i, i + 4).map((n) => this.addresses(n)));
        if (gen !== this.lookupGen) return;
      }
      if (gen !== this.lookupGen) return;
      this.lookup = { name, status: ips ? "done" : "error", ips: ips ?? [] };
      cx.notify();
    });
  }

  // ---- actions ----

  connect(h, place, cx) {
    h.lastUsed = Date.now();
    this.saveLater(cx);
    const argv = sshArgv(h);
    const known = h.password ? new Set(terminals().map((t) => t.address)) : null;
    const before = focused()?.terminal ?? null;
    if (place === "split") run("pane.split", { direction: "right", argv });
    else run("tab.new", { name: this.sessionName(h), argv });
    // A saved password: find the terminal ssh started (the new, focused one) and type the
    // password once when ssh asks for it. The first host-key question is left to the person.
    if (h.password) this.pending.push({ known, before, address: null, password: h.password, started: Date.now(), busy: false });
    cx.notify();
  }

  tick(cx) {
    if (!this.pending.length) return;
    // Once only, ever: a wrong password is retyped by hand. A finished entry must never be read
    // again: right after the password goes in, the screen still ends in "password:" until ssh
    // prints its banner, and a second read would type the password into the remote shell.
    this.pending = this.pending.filter((p) => !p.dead);
    for (const p of this.pending) {
      if (p.busy || p.dead) continue;
      if (Date.now() - p.started > 120000) { p.dead = true; continue; }
      if (!p.address) {
        const f = focused()?.terminal;
        if (f && f !== p.before && !p.known.has(f)) p.address = f;
        else continue;
      }
      p.busy = true;
      cx.spawn(async () => {
        try {
          const r = await hc(["read", p.address]);
          if (p.dead) return;
          if (r.code !== 0) { p.dead = true; return; }
          const lines = r.stdout.split("\n").map((l) => l.trimEnd()).filter(Boolean);
          const last = lines[lines.length - 1] ?? "";
          if (/password[^\n]*:\s*$/i.test(last) && !/passphrase/i.test(last)) {
            p.dead = true; // before the send, so no other read can get here
            await hc(["send", "--force", "--", p.address, p.password]);
          }
        } catch { p.dead = true; } finally { p.busy = false; }
      });
    }
  }

  copyCommand(i, cx) {
    const h = this.hosts[i];
    if (!h) return;
    cx.write_to_clipboard(shellLine(sshArgv(h)));
    this.copied = i;
    cx.timer.after(1600, (cx) => { if (this.copied === i) { this.copied = null; cx.notify(); } });
    cx.notify();
  }

  select(i, cx, scroll) {
    this.selected = i;
    if (this.panel === "form") this.panel = null;
    if (scroll) {
      const at = this.filtered().findIndex((r) => r.i === i);
      if (at >= 0) this.scroll.scroll_to_item(at);
    }
    cx.notify();
  }

  move(delta, cx) {
    const rows = this.filtered();
    if (!rows.length) return;
    const at = rows.findIndex((r) => r.i === this.selected);
    const next = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + delta));
    this.selected = rows[next].i;
    this.scroll.scroll_to_item(next);
    cx.notify();
  }

  rowClick(key, cx) {
    const i = Number(key);
    const now = Date.now();
    const twice = this.lastClick && this.lastClick.key === key && now - this.lastClick.at < 450;
    this.lastClick = twice ? null : { key, at: now };
    this.handle.focus();
    if (twice && this.hosts[i]) this.connect(this.hosts[i], "tab", cx);
    else this.select(i, cx, false);
  }

  edit(index, cx, preset, focusKey) {
    this.panel = "form";
    this.editing = index;
    this.errors = {};
    this.error = "";
    this.showPassword = false;
    this.inputs.password.set_masked(true);
    const h = preset ?? (index === null ? { group: this.group && this.group !== RECENT ? this.group : "" } : this.hosts[index]);
    for (const [key] of FIELDS) {
      this.values[key] = h[key] ?? "";
      this.inputs[key].set_value(h[key] ?? "");
    }
    this.auth = authOf(h);
    cx.notify();
    cx.timer.after(80, () => this.inputs[focusKey ?? "label"].focus());
  }

  duplicate(i, cx) {
    const h = this.hosts[i];
    if (!h) return;
    this.edit(null, cx, { ...h, host: h.host || h.alias, label: `${h.label || target(h)} copy` }, "label");
  }

  // The domain is not saved. Open the form with its name and address filled in.
  addResolved(ip, cx) {
    const name = domainOf(this.query) ?? "";
    this.edit(null, cx, { label: name, host: ip, port: "22", group: this.group && this.group !== RECENT ? this.group : "" }, "user");
  }

  closePanel(cx) {
    this.panel = null;
    this.errors = {};
    this.error = "";
    cx.notify();
    cx.timer.after(30, () => this.handle.focus());
  }

  save(cx) {
    const v = this.values;
    const old = this.editing !== null ? this.hosts[this.editing] : null;
    const alias = old?.alias;
    const errors = {};
    if (!v.host?.trim() && !alias) errors.host = "Enter an address or hostname.";
    if (v.port?.trim() && !(/^\d{1,5}$/.test(v.port.trim()) && Number(v.port) > 0 && Number(v.port) < 65536)) errors.port = "Port must be a number from 1 to 65535.";
    if (this.auth === "key" && !v.identity?.trim()) errors.identity = "Enter the path to a private key.";
    if (this.auth === "password" && !v.password) errors.password = "Enter the password, or pick Default.";
    this.errors = errors;
    if (Object.keys(errors).length) {
      cx.notify();
      const first = ["host", "port", "password", "identity"].find((k) => errors[k]);
      if (first) this.inputs[first].focus();
      return;
    }
    // Keep what the form doesn't show (os, lastUsed, alias).
    const entry = old ? { ...old } : {};
    for (const [key] of FIELDS) entry[key] = key === "password" ? (v[key] ?? "") : (v[key] ?? "").trim();
    if (this.auth !== "password") delete entry.password;
    if (this.auth !== "key") entry.identity = "";
    if (this.auth === "default") delete entry.authMethod;
    else entry.authMethod = this.auth;
    if (!entry.password) delete entry.password;
    if (alias) entry.alias = alias;
    if (!entry.label) entry.label = entry.host || alias;
    if (this.editing === null) { this.hosts.push(entry); this.selected = this.hosts.length - 1; }
    else { this.hosts[this.editing] = entry; this.selected = this.editing; }
    this.panel = null;
    this.saveLater(cx);
    const at = this.filtered().findIndex((r) => r.i === this.selected);
    if (at >= 0) this.scroll.scroll_to_item(at);
    cx.notify();
    cx.timer.after(30, () => this.handle.focus());
  }

  remove(index, cx) {
    const entry = this.hosts[index];
    if (!entry) return;
    // Pick the neighbour in the visible order before the list shifts.
    const rows = this.filtered();
    const at = rows.findIndex((r) => r.i === index);
    const next = rows[at + 1] ?? rows[at - 1] ?? null;
    this.hosts.splice(index, 1);
    this.selected = next ? (next.i > index ? next.i - 1 : next.i) : null;
    if (this.group !== null && this.group !== RECENT && !this.groups().some(([g]) => g === this.group)) this.group = null;
    if (this.panel === "form") this.panel = null;
    const id = Date.now();
    this.undo = { entry, index, id };
    cx.timer.after(8000, (cx) => { if (this.undo?.id === id) { this.undo = null; cx.notify(); } });
    this.saveLater(cx);
    cx.notify();
  }

  restore(cx) {
    if (!this.undo) return;
    const { entry, index } = this.undo;
    this.hosts.splice(Math.min(index, this.hosts.length), 0, entry);
    this.selected = this.hosts.indexOf(entry);
    this.undo = null;
    this.saveLater(cx);
    cx.notify();
  }

  importConfig(cx) {
    cx.spawn(async (cx) => {
      const found = parseConfig(await readTextFile(`${home()}/.ssh/config`).catch(() => null));
      const have = new Set(this.hosts.map((h) => h.alias).filter(Boolean));
      const fresh = found.filter((f) => !have.has(f.alias));
      this.hosts.push(...fresh);
      if (fresh.length) await this.persist();
      this.note = fresh.length ? `Imported ${fresh.length} host${fresh.length === 1 ? "" : "s"} from ~/.ssh/config.` : found.length ? "Every host in ~/.ssh/config is already here." : "No named hosts in ~/.ssh/config.";
      this.noteError = false;
      // With the Import / Export panel shut, the result goes out as a toast instead.
      if (this.panel !== "transfer") { notify({ title: "SSH hosts", body: this.note, level: "info" }); this.note = ""; }
      cx.notify();
    });
  }

  openTransfer(cx) {
    this.panel = this.panel === "transfer" ? null : "transfer";
    this.note = "";
    this.noteError = false;
    this.overwrite = null;
    cx.notify();
  }

  importFile(path, cx) {
    const p = expand(path);
    if (!p) { this.note = "Enter the path of a .json file."; this.noteError = true; cx.notify(); return; }
    this.busy = true;
    this.note = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(p);
        if (text == null) throw new Error("There's no file at that path.");
        let incoming;
        try { incoming = fromLiteTerm(text); } catch (e) { incoming = ownHosts(text); if (!incoming) throw e; }
        const { added, skipped } = mergeHosts(this.hosts, incoming);
        this.hosts.push(...added);
        if (added.length) await this.persist();
        const s = (n) => (n === 1 ? "" : "s");
        this.note = added.length
          ? `Imported ${added.length} host${s(added.length)}${skipped ? `, skipped ${skipped} already saved` : ""}.`
          : skipped ? `All ${skipped} host${s(skipped)} in that file are already saved.` : "That file has no hosts.";
        this.noteError = false;
      } catch (e) {
        this.note = String(e?.message ?? e);
        this.noteError = true;
      }
      this.busy = false;
      cx.notify();
    });
  }

  exportFile(path, cx) {
    const p = expand(path);
    if (!p) { this.note = "Enter where to save the .json file."; this.noteError = true; cx.notify(); return; }
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const existing = await readTextFile(p).catch(() => null);
        if (existing != null && this.overwrite !== p) {
          this.overwrite = p;
          this.note = "A file already exists there. Press Export again to replace it.";
          this.noteError = true;
        } else {
          await writeTextFile(p, toLiteTerm(this.hosts), existing);
          this.overwrite = null;
          const withPw = this.hosts.filter((h) => h.password).length;
          this.note = `Exported ${this.hosts.length} host${this.hosts.length === 1 ? "" : "s"}.${withPw ? ` ${withPw} include a plain-text password: keep the file private.` : ""}`;
          this.noteError = false;
        }
      } catch (e) {
        this.note = `Couldn't export: ${e?.message ?? e}`;
        this.noteError = true;
      }
      this.busy = false;
      cx.notify();
    });
  }

  browse(cx) {
    cx.spawn(async (cx) => {
      const dir = await pickFolder({ prompt: "Use this folder" });
      if (!dir) return;
      const name = expand(this.pathInput.value()).split(/[\\/]/).pop() || "liteterm-hosts.json";
      this.pathInput.set_value(`${dir.replace(/[\\/]$/, "")}${this.sep()}${/\.json$/i.test(name) ? name : "liteterm-hosts.json"}`);
      this.overwrite = null;
      cx.notify();
    });
  }

  key(e, cx) {
    const k = e.key;
    const m = e.modifiers ?? {};
    const cmd = m.control || m.platform;
    const typing = this.focusedField !== null && this.focusedField !== "search";
    const stop = (fn) => { cx.stop_propagation(); fn(); cx.notify(); };

    if (this.panel === "form") {
      if (k === "escape") return stop(() => this.closePanel(cx));
      if (cmd && (k === "enter" || k === "s")) return stop(() => this.save(cx));
      return;
    }
    if (this.panel === "transfer" && k === "escape") return stop(() => this.closePanel(cx));
    if (typing) return;

    if (cmd && k === "f") return stop(() => this.search.focus());
    if (cmd && k === "n") return stop(() => this.edit(null, cx));
    if (k === "down" || (k === "j" && !this.focusedField)) return stop(() => this.move(1, cx));
    if (k === "up" || (k === "k" && !this.focusedField)) return stop(() => this.move(-1, cx));
    if (k === "pagedown") return stop(() => this.move(8, cx));
    if (k === "pageup") return stop(() => this.move(-8, cx));
    if (k === "escape") {
      if (this.undo) return stop(() => { this.undo = null; });
      if (this.query) return stop(() => { this.search.set_value(""); this.query = ""; this.lookup = null; });
      if (this.focusedField === "search") return stop(() => this.handle.focus());
      if (this.selected !== null) return stop(() => { this.selected = null; });
      return;
    }
    if (this.focusedField === "search") return; // Enter there is the input's submit

    const row = this.current();
    if (cmd && k === "z" && this.undo) return stop(() => this.restore(cx));
    if (cmd && k === "c" && row) return stop(() => this.copyCommand(row.i, cx));
    if (cmd) return;
    if (k === "/") return stop(() => this.search.focus());
    if (k === "n") return stop(() => this.edit(null, cx));
    if (!row) return;
    if (k === "enter") return stop(() => this.connect(row.h, m.shift ? "split" : "tab", cx));
    if (k === "e") return stop(() => this.edit(row.i, cx));
    if (k === "d") return stop(() => this.duplicate(row.i, cx));
    if (k === "c") return stop(() => this.copyCommand(row.i, cx));
    if (k === "delete" || k === "backspace") return stop(() => this.remove(row.i, cx));
  }

  // ---- privacy ----

  // Display mode: normal, blur, or dummy. Shared across copies and kept between runs.
  // Older installs stored `true` for blur.
  viewMode() {
    const v = shared("ssh-hosts.privacy");
    if (v === true || v === "blur") return "blur";
    if (v === "dummy") return "dummy";
    return "normal";
  }

  cyclePrivacy() {
    const next = PRIVACY_MODES[(PRIVACY_MODES.indexOf(this.viewMode()) + 1) % PRIVACY_MODES.length];
    setShared("ssh-hosts.privacy", next === "normal" ? false : next);
    const hidden = next !== "normal";
    for (const key of MASKED_FIELDS) this.inputs[key].set_masked(hidden);
  }

  sessionName(h) {
    const mode = this.viewMode();
    if (mode === "blur") return "ssh session";
    if (mode === "dummy") return dummyLabel(Math.max(0, this.hosts.indexOf(h)));
    return h.label || target(h);
  }

  // What a host shows as, in the current mode. `hidden` (blur): draw bars instead of text.
  shown(h, i) {
    const mode = this.viewMode();
    if (mode === "dummy") {
      const port = h.port && h.port !== "22" ? h.port : "22";
      return { hidden: false, label: dummyLabel(i), target: `${dummyUser(i)}@${dummyAddress(i)}`, host: dummyAddress(i), user: dummyUser(i), port, group: dummyGroupName(this.hosts, h.group), identity: h.identity ? "~/.ssh/id_ed25519" : "" };
    }
    return {
      hidden: mode === "blur",
      label: h.label || target(h),
      target: target(h),
      host: h.host || h.alias || "",
      user: h.user || "",
      port: h.port || "22",
      group: h.group || "Ungrouped",
      identity: h.identity || "",
    };
  }

  groupLabel(g) {
    const mode = this.viewMode();
    return mode === "dummy" ? dummyGroupName(this.hosts, g) : g;
  }

  // There is no native blur, so hidden text is replaced by a soft bar of a similar width.
  // The real text is never drawn, so a screenshot cannot recover it.
  redact(t, text, size, max = 190) {
    const w = Math.min(max, Math.max(36, String(text ?? "").length * size * 0.58));
    return div().h(size + 4).flex().items_center().child(div().w(w).h(size * 0.7).rounded(size * 0.35).bg(t.muted + "38"));
  }

  text(t, hidden, value, size, color, extra) {
    if (hidden) return this.redact(t, value, size);
    let el = div().text_size(size).text_color(color).truncate().min_w(0).child(String(value ?? ""));
    return extra ? extra(el) : el;
  }

  // ---- pieces ----

  groupColor(t, name) {
    const palette = [t.ansi4, t.ansi5, t.ansi6, t.ansi2, t.ansi3, t.ansi1, t.ansi12, t.ansi13, t.ansi14, t.ansi10].filter(Boolean);
    return palette.length ? palette[hash(name || "Ungrouped") % palette.length] : t.accent;
  }

  avatar(t, h, i, size) {
    const color = this.groupColor(t, h.group);
    const s = this.shown(h, i);
    return div().w(size).h(size).rounded(size * 0.26).flex().items_center().justify_center().flex_none()
      .bg(color + "2b").text_color(color).text_size(size * 0.36).font_semibold()
      .child(s.hidden ? svg(ICON("server")).size(size * 0.46) : initials(s.label));
  }

  kbd(t, text) {
    return div().h(18).px(5).rounded(4).flex().items_center().flex_none().border_1().border_color(t.border).bg(t.raised)
      .text_size(10.5).text_color(t.muted).child(text);
  }

  button(t, id, text, kind, action, icon, hint) {
    const primary = kind === "primary";
    const danger = kind === "danger";
    const fg = primary ? t.accent_foreground : danger ? t.blocked : t.foreground;
    return h_flex().id(id).h(32).px(12).gap(7).items_center().justify_center().min_w(0).rounded(8).cursor_pointer()
      .border_1().border_color(primary ? t.accent : danger ? t.blocked + "55" : t.input).bg(primary ? t.accent : t.raised)
      .text_color(fg).text_size(12.5).font_semibold()
      .hover((s) => (primary ? s.opacity(0.9) : s.bg(danger ? t.blocked + "1f" : t.hover)))
      .active((s) => s.opacity(0.8))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((e, cx) => { cx.stop_propagation(); action(e, cx); })
      .when(Boolean(icon), (el) => el.child(svg(ICON(icon)).size(14).flex_none()))
      .child(div().min_w(0).truncate().child(text))
      .when(Boolean(hint), (el) => el.child(div().text_size(10.5).font_normal().opacity(0.7).child(hint)));
  }

  iconButton(t, id, icon, action, label, active, danger) {
    return div().id(id).w(32).h(32).rounded(8).flex().items_center().justify_center().flex_none().cursor_pointer()
      .border_1().border_color(active ? t.accent : "#00000000")
      .bg(active ? t.accent + "22" : "#00000000")
      .text_color(danger ? t.blocked : active ? t.accent : t.muted)
      .tooltip(label).accessibility_label(label)
      .hover((s) => s.bg(danger ? t.blocked + "1f" : t.hover).text_color(danger ? t.blocked : t.foreground))
      .active((s) => s.opacity(0.75))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); cx.notify(); })
      .child(svg(ICON(icon)).size(15));
  }

  input(t, key, state, extra) {
    const err = this.errors[key];
    const focus = this.focusedField === key;
    let el = Input.new(state).h(34).px(10).rounded(8).border_1()
      .border_color(err ? t.blocked : focus ? t.accent : t.input).bg(t.background).text_size(13).text_color(t.foreground);
    return extra ? extra(el) : el;
  }

  // ---- sidebar ----

  navItem(t, id, icon, label, count, active, action, dot) {
    return h_flex().id(id).h(32).px(10).gap(9).items_center().flex_none().rounded(8).cursor_pointer()
      .bg(active ? t.selected : "#00000000").text_color(active ? t.foreground : t.muted).text_size(13)
      .when(active, (el) => el.font_medium())
      .when(!active, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .active((s) => s.opacity(0.86))
      .on_click((_e, cx) => { action(cx); cx.notify(); })
      .child(dot
        ? div().w(16).flex().justify_center().flex_none().child(div().w(8).h(8).rounded(4).bg(dot))
        : svg(ICON(icon)).size(15).flex_none())
      .child(typeof label === "string" ? div().flex_1().min_w(0).truncate().child(label) : div().flex_1().min_w(0).child(label))
      .child(div().text_size(11).text_color(t.dim).child(String(count)));
  }

  pickGroup(g, cx) {
    this.group = g;
    const first = this.filtered()[0];
    if (!this.current()) this.selected = first ? first.i : null;
    this.scroll.scroll_to_item(0);
    if (this.panel === "form") this.panel = null;
  }

  sidebar(t) {
    const mode = this.viewMode();
    return v_flex().w(220).flex_none().h_full().bg(t.chrome).border_r(1).border_color(t.border)
      .child(h_flex().h(56).px(16).gap(10).items_center().flex_none().border_b(1).border_color(t.border)
        .child(div().w(28).h(28).rounded(8).flex().items_center().justify_center().bg(t.accent).text_color(t.accent_foreground).child(svg(ICON("server")).size(15)))
        .child(v_flex()
          .child(div().text_size(14).font_semibold().child("SSH Hosts"))
          .child(div().text_size(11).text_color(t.dim).child(this.loaded ? `${this.hosts.length} saved` : "Loading…"))))
      .child(v_flex().id("ssh-nav").flex_1().min_h(0).overflow_y_scroll().p(10).gap(2)
        .child(this.navItem(t, "nav-all", "layers", "All hosts", this.hosts.length, this.group === null, (cx) => this.pickGroup(null, cx)))
        .child(this.navItem(t, "nav-recent", "clock", "Recent", this.recentCount(), this.group === RECENT, (cx) => this.pickGroup(RECENT, cx)))
        .child(div().px(10).pt(16).pb(6).text_size(10.5).font_semibold().text_color(t.dim).child("GROUPS"))
        .children(this.groups().map(([g, n]) => this.navItem(t, `nav-g-${g}`, null,
          mode === "blur" ? this.redact(t, g, 12, 120) : this.groupLabel(g), n, this.group === g, (cx) => this.pickGroup(g, cx), this.groupColor(t, g)))))
      .child(v_flex().p(10).gap(6).flex_none().border_t(1).border_color(t.border)
        .child(this.button(t, "ssh-transfer", "Import / Export", this.panel === "transfer" ? "primary" : "plain", (_e, cx) => this.openTransfer(cx), "swap").w_full())
        .child(this.button(t, "ssh-import", "Import ~/.ssh/config", "plain", (_e, cx) => this.importConfig(cx), "file").w_full()));
  }

  // ---- list ----

  row(t, r, showGroup) {
    const { h, i, via } = r;
    const sel = this.selected === i;
    const s = this.shown(h, i);
    const auth = authOf(h);
    return h_flex().h(ROW_H).px(12).gap(12).items_center().rounded(10).cursor_pointer()
      .border_1().border_color(sel ? t.accent + "88" : "#00000000")
      .bg(sel ? t.selected : "#00000000")
      .when(!sel, (el) => el.hover((st) => st.bg(t.hover)))
      .child(this.avatar(t, h, i, 34))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(this.text(t, s.hidden, s.label, 13.5, t.foreground, (el) => el.font_semibold()))
        .child(via
          ? div().text_size(12).text_color(t.accent).truncate().child(s.hidden || this.viewMode() === "dummy" ? "On this server" : via)
          : this.text(t, s.hidden, s.target, 12, sel ? t.muted : t.dim)))
      .when(showGroup, (el) => el.child(
        h_flex().h(22).px(8).gap(6).items_center().rounded(11).flex_none().max_w(150).bg(t.raised)
          .child(div().w(6).h(6).rounded(3).flex_none().bg(this.groupColor(t, h.group)))
          .child(s.hidden ? this.redact(t, s.group, 10, 70) : div().text_size(11).text_color(t.muted).truncate().child(s.group))))
      .child(div().w(18).flex().justify_center().flex_none().text_color(t.dim)
        .when(auth !== "default", (el) => el.child(svg(ICON(auth === "key" ? "key" : "lock")).size(13))))
      .child(div().w(34).flex_none().text_size(11).text_color(t.dim).text_right().child(ago(h.lastUsed, true)));
  }

  emptyState(t, rows) {
    const name = domainOf(this.query);
    const lookup = name && this.lookup?.name === name ? this.lookup : null;
    const looking = lookup && (lookup.status === "wait" || lookup.status === "loading");
    const offers = lookup?.status === "done" && !rows.length ? lookup.ips : [];
    if (offers.length) {
      return v_flex().p(20).gap(12)
        .child(div().text_size(14).font_medium().child(`${name} is not in your hosts`))
        .child(div().text_size(12).text_color(t.dim).child("Add one of its addresses, then fill in a username and how to log in."))
        .child(v_flex().gap(8).children(offers.map((ip, n) =>
          h_flex().id(`offer-${n}`).h(52).px(12).gap(12).items_center().rounded(10).border_1().border_color(t.border).bg(t.surface)
            .child(div().w(34).h(34).rounded(9).flex().items_center().justify_center().flex_none().bg(t.accent + "22").text_color(t.accent).child(svg(ICON("globe")).size(16)))
            .child(v_flex().flex_1().min_w(0)
              .child(div().text_size(13).font_semibold().truncate().child(ip))
              .child(div().text_size(12).text_color(t.dim).child(name)))
            .child(this.button(t, `offer-add-${n}`, "Add host", "primary", (_e, cx) => this.addResolved(ip, cx), "plus")))));
    }
    let title = "No host matches";
    let body = "Try fewer words, another group, or a domain name to find hosts on the same server.";
    let action = null;
    if (!this.hosts.length) {
      title = "No hosts yet";
      body = "Add a server, or bring in the ones you already have.";
      action = h_flex().gap(8).pt(8)
        .child(this.button(t, "empty-new", "New host", "primary", (_e, cx) => this.edit(null, cx), "plus"))
        .child(this.button(t, "empty-import", "Import ~/.ssh/config", "plain", (_e, cx) => this.importConfig(cx), "file"));
    } else if (this.group === RECENT && !this.query.trim()) {
      title = "Nothing connected yet";
      body = "Hosts you connect to show up here, newest first.";
    } else if (looking) { title = `Looking up ${name}…`; body = "Checking it against your saved hosts."; }
    else if (lookup?.status === "error") { title = `Couldn't look up ${name}`; body = "Check the name, or search by the address you saved."; }
    else if (lookup?.status === "done" && !lookup.ips.length) { title = `No address for ${name}`; body = "That name did not resolve."; }
    else if (this.query.trim()) action = h_flex().pt(8).child(this.button(t, "empty-clear", "Clear search", "plain", (_e, cx) => { this.search.set_value(""); this.query = ""; this.lookup = null; cx.notify(); }, "x"));
    return v_flex().pt(72).px(24).items_center().gap(6)
      .child(div().w(52).h(52).mb(6).rounded(14).flex().items_center().justify_center().bg(t.raised).text_color(t.dim).child(svg(ICON(looking ? "globe" : "server")).size(24)))
      .child(div().text_size(14).font_semibold().child(title))
      .child(div().max_w(340).text_size(12.5).line_height("18px").text_color(t.dim).text_center().child(body))
      .when(Boolean(action), (el) => el.child(action));
  }

  heading(t, rows) {
    const mode = this.viewMode();
    let title;
    if (this.group === null) title = div().text_size(16).font_semibold().child("All hosts");
    else if (this.group === RECENT) title = div().text_size(16).font_semibold().child("Recent");
    else if (mode === "blur") title = this.redact(t, this.group, 16);
    else title = h_flex().gap(8).items_center()
      .child(div().w(9).h(9).rounded(5).bg(this.groupColor(t, this.group)))
      .child(div().text_size(16).font_semibold().child(this.groupLabel(this.group)));
    const name = domainOf(this.query);
    const looking = name && this.lookup?.name === name && (this.lookup.status === "wait" || this.lookup.status === "loading");
    const sortable = this.group !== RECENT;
    return h_flex().px(20).pt(14).pb(8).gap(10).items_center().flex_none()
      .child(title)
      .child(div().text_size(12).text_color(t.dim).child(`${rows.length}${this.query.trim() ? ` of ${this.group === RECENT ? this.recentCount() : this.group === null ? this.hosts.length : (this.groups().find(([g]) => g === this.group)?.[1] ?? 0)}` : ""}`))
      .when(Boolean(looking) && rows.length > 0, (el) => el.child(div().text_size(12).text_color(t.muted).child(`Looking up ${name}…`)))
      .child(div().flex_1())
      .when(sortable, (el) => el.child(
        h_flex().h(26).p(2).gap(2).rounded(7).bg(t.raised).flex_none()
          .children([["name", "A–Z"], ["recent", "Recent"]].map(([k, label]) =>
            div().id(`sort-${k}`).h(22).px(9).rounded(5).flex().items_center().cursor_pointer().text_size(11.5)
              .bg(this.sort === k ? t.background : "#00000000").text_color(this.sort === k ? t.foreground : t.dim)
              .when(this.sort === k, (e) => e.font_medium())
              .on_click((_e, cx) => { this.sort = k; keep("sort", k); this.scroll.scroll_to_item(0); cx.notify(); })
              .child(label)))));
  }

  main(t, narrow) {
    const rows = this.filtered();
    const showGroup = this.group === null || this.group === RECENT || rows.some((r) => r.via);
    const searchFocused = this.focusedField === "search";
    const toolbar = h_flex().h(56).px(16).gap(10).items_center().flex_none().border_b(1).border_color(t.border)
      .child(h_flex().flex_1().max_w(620).h(36).pl(11).pr(6).gap(8).items_center().rounded(9).border_1()
        .border_color(searchFocused ? t.accent : t.input).bg(t.background)
        .child(svg(ICON("search")).size(15).flex_none().text_color(searchFocused ? t.accent : t.dim))
        .child(div().flex_1().min_w(0).child(Input.new(this.search).h(32).text_size(13).text_color(t.foreground)))
        .when(Boolean(this.query), (el) => el.child(this.iconButton(t, "search-clear", "x", () => { this.search.set_value(""); this.query = ""; this.lookup = null; this.search.focus(); }, "Clear search").w(24).h(24)))
        .when(!this.query && !searchFocused, (el) => el.child(this.kbd(t, "/"))))
      .child(this.privacyButton(t))
      .when(narrow, (el) => el.child(this.iconButton(t, "ssh-transfer-small", "swap", (cx) => this.openTransfer(cx), "Import / Export", this.panel === "transfer")))
      .child(this.button(t, "ssh-new", "New host", "primary", (_e, cx) => this.edit(null, cx), "plus"));

    let body;
    if (!this.loaded) body = div().p(20).text_size(12.5).text_color(t.dim).child("Loading…");
    else if (!rows.length) body = v_flex().id("ssh-empty").flex_1().min_h(0).overflow_y_scroll().child(this.emptyState(t, rows));
    else body = div().flex_1().min_h(0).relative().px(8)
      .child(v_virtual_list("ssh-rows", rows.length, ROW_H + 2, (n) => String(rows[n].i),
        (range) => rows.slice(range.start, range.end).map((r) => div().pb(2).child(this.row(t, r, showGroup))))
        .track_scroll(this.scroll)
        .on_item_click((key, cx) => this.rowClick(key, cx))
        .size_full())
      .child(Scrollbar.vertical("ssh-rows").absolute().inset_0());

    return v_flex().flex_1().min_w(0).h_full().relative()
      .child(toolbar)
      .when(this.loaded && this.hosts.length > 0, (el) => el.child(this.heading(t, rows)))
      .child(body)
      .when(Boolean(this.error) && this.panel !== "form", (el) => el.child(div().px(20).py(8).text_size(12).text_color(t.blocked).child(this.error)))
      .when(Boolean(this.undo), (el) => el.child(this.undoBar(t)));
  }

  undoBar(t) {
    const s = this.shown(this.undo.entry, this.undo.index);
    return div().absolute().bottom(16).left(0).right(0).flex().justify_center()
      .child(h_flex().h(40).pl(14).pr(6).gap(12).items_center().rounded(10).border_1().border_color(t.border).bg(t.popover).shadow_lg()
        .child(svg(ICON("trash")).size(14).text_color(t.muted))
        .child(h_flex().gap(5).items_center().text_size(12.5)
          .child("Deleted")
          .child(s.hidden ? this.redact(t, s.label, 12, 90) : div().font_semibold().max_w(200).truncate().child(s.label)))
        .child(this.button(t, "ssh-undo", "Undo", "plain", (_e, cx) => this.restore(cx), "undo", "Ctrl+Z").h(28)));
  }

  privacyButton(t) {
    const mode = this.viewMode();
    const icon = mode === "blur" ? "eye-off" : mode === "dummy" ? "ghost" : "eye";
    const tip = mode === "normal" ? "Showing real hosts. Click to blur them."
      : mode === "blur" ? "Hosts are blurred. Click for dummy names."
      : "Showing dummy names. Click for real hosts.";
    return this.iconButton(t, "ssh-privacy", icon, () => this.cyclePrivacy(), tip, mode !== "normal");
  }

  // ---- right panel ----

  infoRow(t, icon, label, value, hidden, mono) {
    return h_flex().min_h(34).gap(10).items_center().border_b(1).border_color(t.border)
      .child(svg(ICON(icon)).size(14).flex_none().text_color(t.dim))
      .child(div().w(78).flex_none().text_size(12).text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).flex().justify_end()
        .child(hidden ? this.redact(t, value, 12, 120) : div().text_size(12.5).text_color(t.foreground).truncate().when(Boolean(mono), (e) => e.font_family("JetBrains Mono")).child(value || "—")));
  }

  details(t) {
    const row = this.current();
    if (!row) return this.shortcuts(t);
    const { h, i } = row;
    const s = this.shown(h, i);
    const auth = authOf(h);
    const authText = h.alias && !h.host ? "From ~/.ssh/config" : auth === "key" ? "Key file" : auth === "password" ? "Saved password" : "Default";
    const command = shellLine(sshArgv(h));
    const copied = this.copied === i;
    return v_flex().size_full()
      .child(v_flex().id("ssh-detail").flex_1().min_h(0).overflow_y_scroll().p(18).gap(16)
        .child(h_flex().gap(12).items_center()
          .child(this.avatar(t, h, i, 48))
          .child(v_flex().flex_1().min_w(0).gap(3)
            .child(this.text(t, s.hidden, s.label, 16, t.foreground, (e) => e.font_semibold()))
            .child(this.text(t, s.hidden, s.target, 12.5, t.muted))))
        .child(v_flex().gap(8)
          .child(this.button(t, "ssh-connect", "Connect", "primary", (_e, cx) => this.connect(h, "tab", cx), "play", "Enter").w_full().h(36))
          .child(this.button(t, "ssh-split", "Open in split", "plain", (_e, cx) => this.connect(h, "split", cx), "split", "Shift+Enter").w_full()))
        .child(v_flex()
          .child(this.infoRow(t, "globe", "Address", s.host, s.hidden))
          .child(this.infoRow(t, "user", "Username", s.user, s.hidden))
          .child(this.infoRow(t, "terminal", "Port", s.port, false))
          .child(this.infoRow(t, auth === "key" ? "key" : "lock", "Login", auth === "key" ? s.identity : authText, auth === "key" && s.hidden))
          .child(this.infoRow(t, "folder", "Group", s.group, s.hidden))
          .child(this.infoRow(t, "clock", "Last used", ago(h.lastUsed, false), false))
          .when(Boolean(h.os) && h.os !== "unknown", (el) => el.child(this.infoRow(t, "server", "System", h.os, false))))
        .child(v_flex().gap(6)
          .child(div().text_size(10.5).font_semibold().text_color(t.dim).child("COMMAND"))
          .child(h_flex().id("ssh-command").min_h(36).pl(10).pr(4).gap(8).items_center().rounded(8).bg(t.background).border_1().border_color(t.border)
            .child(div().flex_1().min_w(0).child(s.hidden || this.viewMode() === "dummy"
              ? (s.hidden ? this.redact(t, command, 11.5, 160) : div().text_size(11.5).font_family("JetBrains Mono").text_color(t.muted).truncate().child(`ssh ${s.target}`))
              : div().text_size(11.5).font_family("JetBrains Mono").text_color(t.muted).truncate().child(command)))
            .child(this.iconButton(t, "ssh-copy", copied ? "check" : "copy", (cx) => this.copyCommand(i, cx), copied ? "Copied" : "Copy command (C)", copied)))))
      .child(h_flex().p(12).gap(6).items_center().flex_none().border_t(1).border_color(t.border)
        .child(this.button(t, "ssh-edit", "Edit", "plain", (_e, cx) => this.edit(i, cx), "pencil", "E").flex_1())
        .child(this.iconButton(t, "ssh-dup", "duplicate", (cx) => this.duplicate(i, cx), "Duplicate (D)"))
        .child(this.iconButton(t, "ssh-del", "trash", (cx) => this.remove(i, cx), "Delete (Del) — you can undo", false, true)));
  }

  shortcuts(t) {
    const line = (keys, what) => h_flex().h(28).gap(10).items_center()
      .child(h_flex().w(92).gap(4).flex_none().children(keys.map((k) => this.kbd(t, k))))
      .child(div().text_size(12).text_color(t.muted).child(what));
    return v_flex().size_full().p(18).gap(14)
      .child(v_flex().pt(24).items_center().gap(6)
        .child(div().w(48).h(48).rounded(13).flex().items_center().justify_center().bg(t.raised).text_color(t.dim).child(svg(ICON("terminal")).size(22)))
        .child(div().text_size(13.5).font_semibold().child("Pick a host"))
        .child(div().text_size(12).text_color(t.dim).text_center().child("Click once to see it, twice to connect.")))
      .child(v_flex().pt(10)
        .child(line(["↑", "↓"], "Move"))
        .child(line(["Enter"], "Connect in a new tab"))
        .child(line(["Shift", "Enter"], "Connect in a split"))
        .child(line(["/"], "Search"))
        .child(line(["N"], "New host"))
        .child(line(["E"], "Edit"))
        .child(line(["D"], "Duplicate"))
        .child(line(["C"], "Copy ssh command"))
        .child(line(["Del"], "Delete (undo with Ctrl+Z)"))
        .child(line(["Esc"], "Clear search / close")));
  }

  label(t, text, err) {
    return h_flex().pt(12).pb(5).gap(6).items_center()
      .child(div().text_size(11.5).font_medium().text_color(t.muted).child(text))
      .when(Boolean(err), (el) => el.child(div().flex_1().text_right().text_size(11).text_color(t.blocked).truncate().child(err)));
  }

  section(t, title) {
    return div().pt(18).pb(2).text_size(10.5).font_semibold().text_color(t.dim).child(title);
  }

  formPanel(t) {
    const old = this.editing !== null ? this.hosts[this.editing] : null;
    const aliasOnly = Boolean(old?.alias && !old?.host);
    const mode = this.viewMode();
    const groupChips = mode === "normal" ? this.groups().map(([g]) => g).filter((g) => g !== "Ungrouped" && g !== (this.values.group ?? "").trim()).slice(0, 10) : [];
    const authHelp = AUTHS.find(([k]) => k === this.auth)?.[2] ?? "";
    return v_flex().size_full()
      .child(h_flex().h(56).px(18).items_center().flex_none().border_b(1).border_color(t.border)
        .child(div().flex_1().text_size(15).font_semibold().child(this.editing === null ? "New host" : "Edit host"))
        .child(this.iconButton(t, "form-close", "x", (cx) => this.closePanel(cx), "Close (Esc)")))
      .child(v_flex().id("form-scroll").flex_1().min_h(0).overflow_y_scroll().px(18).pb(18)
        .child(this.section(t, "CONNECTION"))
        .child(h_flex().gap(10).items_start()
          .child(v_flex().flex_1().min_w(0)
            .child(this.label(t, "Address", this.errors.host))
            .child(this.input(t, "host", this.inputs.host)))
          .child(v_flex().w(78).flex_none()
            .child(this.label(t, "Port"))
            .child(this.input(t, "port", this.inputs.port))))
        .when(Boolean(this.errors.port), (el) => el.child(div().pt(5).text_size(11.5).text_color(t.blocked).child(this.errors.port)))
        .when(aliasOnly, (el) => el.child(div().pt(5).text_size(11.5).text_color(t.dim).child(`Connects with "ssh ${mode === "normal" ? old.alias : "…"}" from ~/.ssh/config. Leave the address empty to keep it that way.`)))
        .child(this.label(t, "Username"))
        .child(this.input(t, "user", this.inputs.user))
        .child(this.section(t, "LOGIN"))
        .child(h_flex().mt(8).p(3).gap(3).rounded(9).bg(t.raised)
          .children(AUTHS.map(([k, name]) => div().id(`auth-${k}`).flex_1().h(28).rounded(7).flex().items_center().justify_center().cursor_pointer()
            .text_size(12).bg(this.auth === k ? t.background : "#00000000").text_color(this.auth === k ? t.foreground : t.muted)
            .when(this.auth === k, (e) => e.font_semibold().border_1().border_color(t.border))
            .when(this.auth !== k, (e) => e.hover((s) => s.text_color(t.foreground)))
            .on_click((_e, cx) => {
              this.auth = k;
              delete this.errors.password; delete this.errors.identity;
              cx.notify();
              if (k !== "default") cx.timer.after(40, () => this.inputs[k === "key" ? "identity" : "password"].focus());
            })
            .child(name))))
        .when(this.auth === "password", (el) => el
          .child(this.label(t, "Password", this.errors.password))
          .child(h_flex().gap(6).items_center()
            .child(div().flex_1().min_w(0).child(this.input(t, "password", this.inputs.password)))
            .child(this.iconButton(t, "pw-eye", this.showPassword ? "eye-off" : "eye", () => {
              this.showPassword = !this.showPassword;
              this.inputs.password.set_masked(!this.showPassword);
            }, this.showPassword ? "Hide password" : "Show password", this.showPassword))))
        .when(this.auth === "key", (el) => el
          .child(this.label(t, "Key file", this.errors.identity))
          .child(this.input(t, "identity", this.inputs.identity)))
        .child(div().pt(8).text_size(11.5).line_height("16px").text_color(t.dim).child(authHelp))
        .child(this.section(t, "ORGANIZE"))
        .child(this.label(t, "Label"))
        .child(this.input(t, "label", this.inputs.label))
        .child(this.label(t, "Group"))
        .child(this.input(t, "group", this.inputs.group))
        .when(groupChips.length > 0, (el) => el.child(h_flex().pt(8).gap(6).flex_wrap()
          .children(groupChips.map((g) => h_flex().id(`chip-${g}`).h(24).px(9).gap(6).items_center().rounded(12).cursor_pointer()
            .border_1().border_color(t.border).bg(t.surface).text_size(11.5).text_color(t.muted)
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { this.values.group = g; this.inputs.group.set_value(g); cx.notify(); })
            .child(div().w(6).h(6).rounded(3).bg(this.groupColor(t, g)))
            .child(g))))))
      .when(Boolean(this.error), (el) => el.child(div().px(18).pb(6).text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().p(12).gap(8).items_center().flex_none().border_t(1).border_color(t.border)
        .child(div().flex_1().text_size(11).text_color(t.dim).child("Ctrl+Enter to save"))
        .child(this.button(t, "ssh-cancel", "Cancel", "plain", (_e, cx) => this.closePanel(cx)))
        .child(this.button(t, "ssh-save", this.editing === null ? "Add host" : "Save", "primary", (_e, cx) => this.save(cx), "check")));
  }

  transferPanel(t) {
    const pathFocus = this.focusedField === "path";
    return v_flex().size_full()
      .child(h_flex().h(56).px(18).items_center().flex_none().border_b(1).border_color(t.border)
        .child(div().flex_1().text_size(15).font_semibold().child("Import / Export"))
        .child(this.iconButton(t, "transfer-close", "x", (cx) => this.closePanel(cx), "Close (Esc)")))
      .child(v_flex().id("transfer-scroll").flex_1().min_h(0).overflow_y_scroll().p(18).gap(14)
        .child(div().text_size(12.5).line_height("18px").text_color(t.muted).child("Move hosts in and out as a LiteTerm hosts file (.json). You can also drop a .json file anywhere on this tab."))
        .child(v_flex().gap(6)
          .child(div().text_size(11.5).font_medium().text_color(t.muted).child("File"))
          .child(h_flex().gap(6).items_center()
            .child(div().flex_1().min_w(0).child(Input.new(this.pathInput).h(34).px(10).rounded(8).border_1()
              .border_color(pathFocus ? t.accent : t.input).bg(t.background).text_size(12).text_color(t.foreground)))
            .child(this.iconButton(t, "ssh-browse", "folder", (cx) => this.browse(cx), "Choose a folder"))))
        .child(h_flex().gap(8)
          .child(this.button(t, "ssh-do-import", "Import", "primary", (_e, cx) => this.importFile(this.pathInput.value(), cx), "download").flex_1())
          .child(this.button(t, "ssh-do-export", this.overwrite ? "Replace file" : "Export", this.overwrite ? "danger" : "plain", (_e, cx) => this.exportFile(this.pathInput.value(), cx), "upload").flex_1()))
        .when(this.busy, (el) => el.child(div().text_size(12).text_color(t.muted).child("Working…")))
        .when(Boolean(this.note) && !this.busy, (el) => el.child(
          h_flex().p(10).gap(8).items_start().rounded(8).bg((this.noteError ? t.blocked : t.working) + "1a")
            .child(svg(ICON(this.noteError ? "x" : "check")).size(14).flex_none().mt(1).text_color(this.noteError ? t.blocked : t.working))
            .child(div().flex_1().min_w(0).text_size(12).line_height("17px").text_color(t.foreground).child(this.note))))
        .child(div().h(1).bg(t.border))
        .child(v_flex().gap(8)
          .child(div().text_size(11.5).font_medium().text_color(t.muted).child("From this computer"))
          .child(this.button(t, "ssh-import-config", "Import ~/.ssh/config", "plain", (_e, cx) => this.importConfig(cx), "file").w_full())))
      .child(div().p(18).flex_none().text_size(11.5).line_height("16px").text_color(t.dim)
        .child("Import skips hosts you already have (same label, address, user and port). Saved passwords are stored and exported as plain text."));
  }

  render() {
    const t = theme();
    const width = this.size?.width ?? 1200;
    const showSidebar = width >= 860;
    const narrow = !showSidebar;
    const panelOpen = this.panel !== null;
    const showRight = panelOpen || width >= 640;
    const right = this.panel === "form" ? this.formPanel(t) : this.panel === "transfer" ? this.transferPanel(t) : this.details(t);
    return h_flex().id("ssh-hosts").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .on_drop((e, cx) => {
        const p = (e.paths ?? []).find((x) => /\.json$/i.test(x));
        if (!p) return;
        this.panel = "transfer";
        this.pathInput.set_value(p);
        this.importFile(p, cx);
      })
      .size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .when(showSidebar, (el) => el.child(this.sidebar(t)))
      .child(this.main(t, narrow))
      .when(showRight, (el) => el.child(v_flex().w(this.panel === "form" ? 360 : 320).flex_none().h_full().bg(t.chrome).border_l(1).border_color(t.border).child(right)));
  }
}
