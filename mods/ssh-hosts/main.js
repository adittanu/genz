// SSH Hosts: a Termius-style host manager that lives in its own tab.
// Left: groups. Middle: search + NEW HOST + a grid of host cards.
// Right: the host form while adding or editing.
// Single click selects a card, double click (or the play button) opens ssh in a new tab.
// Hosts live in <appHome>/data/ssh-hosts.json.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, hc, exec, window, terminals, focused, shared, setShared, theme, appHome, home, readTextFile, writeTextFile, notify } from "herdr";
import { fromLiteTerm, mergeHosts, toLiteTerm } from "./liteterm.js";

const ICON = (n) => `mods/ssh-hosts/${n}.svg`;
const FIELDS = [
  ["label", "Label", "prod-api"],
  ["host", "Address", "203.0.113.10"],
  ["user", "Username", "root"],
  ["password", "Password (optional, saved as plain text)", ""],
  ["port", "Port", "22"],
  ["group", "Group", "Production"],
  ["identity", "Identity file (optional)", "~/.ssh/id_ed25519"],
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

const target = (h) => (h.alias && !h.host ? h.alias : `${h.user ? h.user + "@" : ""}${h.host}${h.port && h.port !== "22" ? ":" + h.port : ""}`);
const subtitle = (h) => ["ssh", h.user || (h.alias ? h.alias : ""), h.password ? "auto-login" : ""].filter(Boolean).join(", ");

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
const dummyTarget = (index) => `${dummyUser(index)}@${dummyAddress(index)}`;
const dummySubtitle = (index) => `ssh, ${dummyUser(index)}`;
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
    if (window().platform === "windows") {
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

export default class SshHosts extends View {
  init(_props, cx) {
    this.hosts = [];
    this.raw = null; // file text as last read, for writeTextFile's check
    this.loaded = false;
    this.query = "";
    this.group = null; // null = all hosts
    this.selected = null; // index into this.hosts
    this.form = false;
    this.transfer = false; // the Import / Export panel
    this.busy = false;
    this.note = ""; // result line in the transfer panel
    this.noteError = false;
    this.overwrite = null; // path the next Export may replace
    this.editing = null; // index being edited, or null for a new host
    this.values = {};
    this.pathInput = InputState.new({ placeholder: "C:\\Users\\you\\Downloads\\liteterm-hosts.json", value: `${home()}/Downloads/liteterm-hosts.json` });
    this.pathInput.on("change", (_e, cx) => { this.overwrite = null; cx.notify(); });
    this.pathInput.on("focus", (_e, cx) => { this.focusedField = "path"; cx.notify(); });
    this.pathInput.on("blur", (_e, cx) => { if (this.focusedField === "path") this.focusedField = null; cx.notify(); });
    this.pathInput.on("submit", (_e, cx) => this.importFile(this.pathInput.value(), cx));
    this.focusedField = null;
    this.error = "";
    this.handle = cx.focus_handle();

    this.dns = new Map(); // hostname -> addresses, or null while that lookup is failing
    this.dnsPending = new Map();
    this.lookup = null; // { name, status: wait|loading|done|error, ips }
    this.lookupGen = 0;
    this.lookupWait = 0;

    this.search = InputState.new({ placeholder: "Find a host or domain" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); this.scheduleLookup(cx); cx.notify(); });
    this.search.on("focus", (_e, cx) => { this.focusedField = "search"; cx.notify(); });
    this.search.on("blur", (_e, cx) => { if (this.focusedField === "search") this.focusedField = null; cx.notify(); });
    this.search.on("submit", (_e, cx) => {
      const first = this.filtered()[0];
      if (first) this.connect(first.h, "tab", cx);
    });

    this.pending = []; // ssh terminals waiting for their password prompt
    cx.timer.every(500, (cx) => this.tick(cx));

    this.inputs = {};
    for (const [key, , ph] of FIELDS) {
      const s = InputState.new({ placeholder: ph });
      if (key === "password" || (this.viewMode() !== "normal" && MASKED_FIELDS.includes(key))) s.set_masked(true);
      s.on("change", (_e, cx) => { this.values[key] = s.value(); cx.notify(); });
      s.on("focus", (_e, cx) => { this.focusedField = key; cx.notify(); });
      s.on("blur", (_e, cx) => { if (this.focusedField === key) this.focusedField = null; cx.notify(); });
      s.on("submit", (_e, cx) => this.save(cx));
      this.inputs[key] = s;
    }

    cx.spawn(async (cx) => {
      this.raw = await readTextFile(this.file()).catch(() => null);
      try { this.hosts = this.raw ? JSON.parse(this.raw).hosts ?? [] : []; } catch { this.hosts = []; }
      this.loaded = true;
      cx.notify();
    });
  }

  file() { return `${appHome()}/data/ssh-hosts.json`; }

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

  groups() {
    const m = new Map();
    for (const h of this.hosts) m.set(h.group || "Ungrouped", (m.get(h.group || "Ungrouped") ?? 0) + 1);
    return [...m.entries()];
  }

  filtered() {
    const q = this.query.trim().toLowerCase();
    const name = domainOf(this.query);
    const found = name && this.lookup?.name === name && this.lookup.status === "done" ? new Set(this.lookup.ips) : null;
    return this.hosts
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => {
        const inGroup = this.group === null || (h.group || "Ungrouped") === this.group;
        const text = !q || [h.label, h.host, h.user, h.group, h.alias].some((v) => (v ?? "").toLowerCase().includes(q));
        if (found && this.sharesAddress(h, found)) return true;
        return inGroup && text;
      })
      .map((row) => {
        const addr = (row.h.host || "").trim().toLowerCase();
        const byIp = Boolean(found && this.sharesAddress(row.h, found) && addr !== name);
        let via = null;
        if (byIp) {
          via = `${name} is on this server`;
          const group = row.h.group || "Ungrouped";
          if (this.group !== null && group !== this.group) via += ` (${group})`;
        }
        return { ...row, via };
      });
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

  connect(h, place, cx) {
    if (h.password) return this.autoLogin(h, place);
    if (place === "split") run("pane.split", { direction: "right", argv: sshArgv(h) });
    else run("tab.new", { name: this.sessionName(h), argv: sshArgv(h) });
  }

  // A host with a saved password: open ssh as usual, find the terminal it started
  // (the new, focused one), and type the password once when ssh asks for it.
  // The first host-key question ("yes/no") is left to the person.
  autoLogin(h, place, cx) {
    const known = new Set(terminals().map((t) => t.address));
    const before = focused()?.terminal ?? null;
    if (place === "split") run("pane.split", { direction: "right", argv: sshArgv(h) });
    else run("tab.new", { name: this.sessionName(h), argv: sshArgv(h) });
    this.pending.push({ known, before, address: null, password: h.password, started: Date.now(), busy: false, sent: false });
  }

  tick(cx) {
    if (!this.pending.length) return;
    for (const p of this.pending) {
      if (p.busy) continue;
      if (Date.now() - p.started > 120000) { p.dead = true; continue; }
      if (!p.address) {
        const f = focused()?.terminal;
        if (f && f !== p.before && !p.known.has(f)) p.address = f;
        else continue;
      }
      p.busy = true;
      cx.spawn(async (cx) => {
        try {
          const r = await hc(["read", p.address]);
          if (r.code !== 0) p.dead = true;
          else {
            const lines = r.stdout.split("\n").map((l) => l.trimEnd()).filter(Boolean);
            const last = lines[lines.length - 1] ?? "";
            if (/password[^\n]*:\s*$/i.test(last) && !/passphrase/i.test(last)) {
              await hc(["send", "--force", "--", p.address, p.password]);
              p.dead = true; // once only: a wrong password is retyped by hand
            }
          }
        } catch { p.dead = true; }
        p.busy = false;
      });
    }
    this.pending = this.pending.filter((p) => !p.dead);
  }
  edit(index, cx, preset) {
    this.transfer = false;
    this.form = true;
    this.editing = index;
    this.error = "";
    const h = preset ?? (index === null ? { group: this.group ?? "" } : this.hosts[index]);
    for (const [key] of FIELDS) {
      this.values[key] = h[key] ?? "";
      this.inputs[key].set_value(h[key] ?? "");
    }
    cx.notify();
    cx.timer.after(80, () => this.inputs[preset ? "user" : "label"].focus());
  }

  // The domain is not saved. Open the form with its name and address filled in.
  addResolved(ip, cx) {
    const name = domainOf(this.query) ?? "";
    this.edit(null, cx, { label: name, host: ip, port: "22", group: this.group ?? "" });
  }

  save(cx) {
    const v = this.values;
    const alias = this.editing !== null ? this.hosts[this.editing].alias : undefined;
    if (!v.host?.trim() && !alias) { this.error = "Address is required."; cx.notify(); return; }
    if (v.port && !/^\d{1,5}$/.test(v.port.trim())) { this.error = "Port must be a number."; cx.notify(); return; }
    // Keep what the form doesn't show (an imported password, authMethod, os).
    const entry = this.editing !== null ? { ...this.hosts[this.editing] } : {};
    for (const [key] of FIELDS) entry[key] = key === "password" ? (v[key] ?? "") : (v[key] ?? "").trim();
    if (!entry.password) delete entry.password;
    if (alias) entry.alias = alias;
    if (!entry.label) entry.label = entry.host || alias;
    if (this.editing === null) { this.hosts.push(entry); this.selected = this.hosts.length - 1; }
    else this.hosts[this.editing] = entry;
    this.form = false;
    cx.spawn(async (cx) => { await this.persist(); cx.notify(); });
    cx.notify();
  }

  remove(index, cx) {
    this.hosts.splice(index, 1);
    this.selected = null;
    if (this.group !== null && !this.groups().some(([g]) => g === this.group)) this.group = null;
    cx.spawn(async (cx) => { await this.persist(); cx.notify(); });
    cx.notify();
  }

  importConfig(cx) {
    cx.spawn(async (cx) => {
      const found = parseConfig(await readTextFile(`${home()}/.ssh/config`).catch(() => null));
      const have = new Set(this.hosts.map((h) => h.alias).filter(Boolean));
      const fresh = found.filter((f) => !have.has(f.alias));
      this.hosts.push(...fresh);
      await this.persist();
      notify({ title: "SSH hosts", body: fresh.length ? `Imported ${fresh.length} from ~/.ssh/config` : "Nothing new in ~/.ssh/config", level: "info" });
      cx.notify();
    });
  }

  key(e, cx) {
    if (e.key === "escape" && (this.form || this.transfer)) { this.form = false; this.transfer = false; this.error = ""; cx.stop_propagation(); cx.notify(); }
  }

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

  heading(t) {
    if (this.group == null) return div().text_size(18).font_semibold().child("Hosts");
    const mode = this.viewMode();
    if (mode === "blur") return this.redact(t, this.group, 18, 22);
    return div().text_size(18).font_semibold().child(mode === "dummy" ? dummyGroupName(this.hosts, this.group) : this.group);
  }

  privacyButton(t) {
    const mode = this.viewMode();
    const hidden = mode !== "normal";
    const icon = mode === "blur" ? "eye-off" : mode === "dummy" ? "ghost" : "eye";
    const tip = mode === "normal" ? "Showing real hosts. Click for blur."
      : mode === "blur" ? "Hosts are blurred. Click for dummy names."
      : "Showing dummy hosts. Click for real names.";
    return div().id("ssh-privacy").w(34).h(34).rounded(8).flex().items_center().justify_center().flex_none().cursor_pointer()
      .border_1().border_color(hidden ? t.accent : t.input).bg(hidden ? t.accent + "26" : t.raised)
      .text_color(hidden ? t.accent : t.muted)
      .tooltip(tip).accessibility_label(tip)
      .hover((s) => s.opacity(0.88))
      .on_click((_e, cx) => { this.cyclePrivacy(); cx.notify(); })
      .child(svg(ICON(icon)).size(16));
  }

  // There is no native blur, so hidden text is replaced by a soft bar the same width.
  // The real text is never drawn, so a screenshot cannot recover it.
  redact(t, text, size, height) {
    const w = Math.min(190, Math.max(40, String(text ?? "").length * size * 0.62));
    return div().h(height).flex().items_center().child(div().w(w).h(size * 0.78).rounded(size * 0.4).bg(t.muted + "38"));
  }

  button(t, id, text, primary, action, icon) {
    return h_flex().id(id).h(32).px(14).gap(6).items_center().min_w(0).rounded(8)
      .border_1().border_color(primary ? t.accent : t.input).bg(primary ? t.accent : t.raised)
      .text_color(primary ? t.accent_foreground : t.foreground).text_size(12.5).font_semibold().cursor_pointer()
      .hover((s) => s.bg(primary ? t.accent : t.hover))
      .active((s) => s.opacity(0.86)).on_click(action)
      .when(Boolean(icon), (el) => el.child(svg(ICON(icon)).size(13).flex_none()))
      .child(div().min_w(0).truncate().child(text));
  }

  iconButton(t, id, icon, action, danger, label) {
    return div().id(id).w(30).h(30).rounded(8).flex().items_center().justify_center().flex_none().cursor_pointer()
      .text_color(danger ? t.blocked : t.foreground)
      .tooltip(label).accessibility_label(label)
      .hover((s) => s.bg(danger ? t.blocked + "24" : t.raised))
      .active((s) => s.opacity(0.72))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(svg(ICON(icon)).size(15));
  }

  navItem(t, id, label, count, active, action) {
    return h_flex().id(id).h(32).px(10).gap(8).items_center().flex_none().rounded(8).cursor_pointer()
      .bg(active ? t.selected : t.chrome).text_color(active ? t.foreground : t.muted).text_size(13)
      .when(active, (el) => el.font_medium())
      .when(!active, (el) => el.hover((s) => s.bg(t.hover)))
      .active((s) => s.opacity(0.86)).on_click(action)
      .child(div().flex_1().min_w(0).truncate().child(label))
      .child(div().text_size(11).text_color(active ? t.muted : t.dim).child(String(count)));
  }

  sidebar(t) {
    return v_flex().w(210).flex_none().h_full().p(12).gap(2).bg(t.chrome).border_r(1).border_color(t.border)
      .child(h_flex().items_center().gap(8).px(4).pb(12)
        .child(div().w(26).h(26).rounded(7).flex().items_center().justify_center().bg(t.accent).text_color(t.accent_foreground).child(svg(ICON("server")).size(14)))
        .child(div().text_size(14).font_semibold().child("SSH Hosts")))
      .child(div().px(10).pt(4).pb(6).text_size(11).font_medium().text_color(t.dim).child("VAULT"))
      .child(this.navItem(t, "nav-all", "All hosts", this.hosts.length, this.group === null, (_e, cx) => { this.group = null; cx.notify(); }))
      .child(div().px(10).pt(14).pb(6).text_size(11).font_medium().text_color(t.dim).child("GROUPS"))
      .children(this.groups().map(([g, n]) => {
        const mode = this.viewMode();
        const label = mode === "blur" ? this.redact(t, g, 13, 16) : mode === "dummy" ? dummyGroupName(this.hosts, g) : g;
        return this.navItem(t, `nav-${g}`, label, n, this.group === g, (_e, cx) => { this.group = g; cx.notify(); });
      }))
      .child(div().flex_1())
      .child(v_flex().gap(8)
        .child(this.button(t, "ssh-transfer", "Import / Export", false, (_e, cx) => this.openTransfer(cx), "swap").w_full())
        .child(this.button(t, "ssh-import", "Import ~/.ssh/config", false, (_e, cx) => this.importConfig(cx)).w_full()));
  }

  card(t, { h, i, via }) {
    const sel = this.selected === i;
    const mode = this.viewMode();
    const detailText = mode === "dummy" ? (sel ? dummyTarget(i) : dummySubtitle(i)) : (sel ? target(h) : subtitle(h));
    // Actions sit on their own row. Sharing the title row squeezed the label
    // down to a few characters and painted the buttons on top of it.
    return v_flex().id(`card-${i}`).w(268).flex_none().rounded(12).cursor_pointer().overflow_hidden()
      .border_1().border_color(sel ? t.accent : t.border).bg(sel ? t.selected : t.surface)
      .when(!sel, (el) => el.hover((s) => s.bg(t.hover)))
      .on_mouse_down("left", (e, cx) => {
        if (e.click_count === 2) this.connect(h, "tab", cx);
        else { this.selected = i; cx.notify(); }
      })
      .child(h_flex().px(12).py(12).gap(12).items_center()
        .child(div().w(40).h(40).rounded(10).flex().items_center().justify_center().flex_none()
          .bg(t.accent + (sel ? "33" : "22")).text_color(t.accent).child(svg(ICON("server")).size(20)))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(mode === "blur" ? this.redact(t, h.label, 14, 18) : div().text_size(14).font_semibold().text_color(t.foreground).truncate().child(mode === "dummy" ? dummyLabel(i) : h.label))
          .child(mode === "blur" ? this.redact(t, detailText, 12, 16) : div().text_size(12).text_color(sel ? t.muted : t.dim).truncate().child(detailText))
          .when(Boolean(via), (el) => el.child(
            div().text_size(12).text_color(t.accent).truncate().child(mode === "normal" ? via : "On this server")))))
      .when(sel, (el) => el.child(
        h_flex().px(8).py(6).gap(4).items_center().border_t(1).border_color(t.border).bg(t.surface)
          .child(h_flex().id(`go-${i}`).h(30).px(10).gap(6).items_center().flex_none().rounded(8).cursor_pointer()
            .bg(t.accent).text_color(t.accent_foreground).text_size(12).font_semibold()
            .accessibility_label("Connect").tooltip("Connect")
            .active((s) => s.opacity(0.86))
            .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); this.connect(h, "tab", cx); })
            .child(svg(ICON("terminal")).size(14)).child("Connect"))
          .child(div().flex_1())
          .child(this.iconButton(t, `split-${i}`, "split", (cx) => this.connect(h, "split", cx), false, "Split"))
          .child(this.iconButton(t, `edit-${i}`, "pencil", (cx) => this.edit(i, cx), false, "Edit"))
          .child(this.iconButton(t, `del-${i}`, "trash", (cx) => this.remove(i, cx), true, "Remove"))));
  }

  offerCard(t, name, ip, n) {
    return v_flex().id(`offer-${n}`).w(268).flex_none().rounded(12).overflow_hidden()
      .border_1().border_color(t.border).bg(t.surface)
      .child(h_flex().px(12).py(12).gap(12).items_center()
        .child(div().w(40).h(40).rounded(10).flex().items_center().justify_center().flex_none()
          .bg(t.accent + "22").text_color(t.accent).child(svg(ICON("server")).size(20)))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(div().text_size(14).font_semibold().text_color(t.foreground).truncate().child(name))
          .child(div().text_size(12).text_color(t.muted).truncate().child(ip))
          .child(div().text_size(12).text_color(t.accent).truncate().child("Not in your hosts"))))
      .child(h_flex().px(8).py(6).border_t(1).border_color(t.border).bg(t.surface)
        .child(this.button(t, `offer-add-${n}`, "Add host", true, (_e, cx) => this.addResolved(ip, cx), "plus")));
  }

  main(t) {
    const rows = this.filtered();
    const name = domainOf(this.query);
    const lookup = name && this.lookup?.name === name ? this.lookup : null;
    const looking = lookup && (lookup.status === "wait" || lookup.status === "loading");
    let emptyTitle = this.hosts.length ? "No host matches" : "Add your first host";
    let emptyBody = this.hosts.length ? "Try another search or group." : "Press NEW HOST, or import your ~/.ssh/config.";
    if (looking) { emptyTitle = `Looking up ${name}...`; emptyBody = "Checking it against your saved hosts."; }
    else if (lookup?.status === "error") { emptyTitle = `Couldn't look up ${name}`; emptyBody = "Check the name, or search by the address you saved."; }
    else if (lookup?.status === "done" && !lookup.ips.length) { emptyTitle = `No address for ${name}`; emptyBody = "That name did not resolve."; }
    const offers = lookup?.status === "done" && !rows.length ? lookup.ips : [];
    const grid = rows.length
      ? h_flex().flex_wrap().gap(12).content_start().items_start().children(rows.map((r) => this.card(t, r)))
      : offers.length
        ? v_flex().gap(12)
            .child(div().text_size(14).font_medium().child(`${name} is not in your hosts`))
            .child(div().text_size(12).text_color(t.dim).child("Add the address, then enter a username and a password or a key."))
            .child(h_flex().flex_wrap().gap(12).items_start().children(offers.map((ip, n) => this.offerCard(t, name, ip, n))))
        : v_flex().pt(80).items_center().gap(8)
            .child(div().w(56).h(56).rounded(14).flex().items_center().justify_center().bg(t.raised).text_color(t.dim).child(svg(ICON("server")).size(26)))
            .child(div().text_size(14).font_medium().child(emptyTitle))
            .child(div().px(24).text_size(12).text_color(t.dim).child(emptyBody));
    return v_flex().flex_1().min_w(0).h_full()
      .child(h_flex().h(60).px(20).gap(12).items_center().flex_none().border_b(1).border_color(t.border)
        .child(div().flex_1().max_w(520).child(
          Input.new(this.search).h(34).px(12).rounded(8).border_1()
            .border_color(this.focusedField === "search" ? t.accent : t.input).bg(t.background).text_size(13).text_color(t.foreground)))
        .child(div().flex_1())
        .child(this.privacyButton(t))
        .child(this.button(t, "ssh-new", "NEW HOST", true, (_e, cx) => this.edit(null, cx), "plus")))
      .child(v_flex().id("hosts-scroll").flex_1().min_h(0).px(20).py(16).gap(12).overflow_y_scroll()
        .child(h_flex().items_baseline().gap(8)
          .child(this.heading(t))
          .child(div().text_size(12).text_color(t.dim).child(`${rows.length} host${rows.length === 1 ? "" : "s"}`)))
        .when(looking && rows.length > 0, (el) => el.child(div().text_size(12.5).text_color(t.muted).child(`Looking up ${name}...`)))
        .child(!this.loaded ? div().text_size(12.5).text_color(t.dim).child("Loading...") : grid)
        .when(Boolean(this.error) && !this.form, (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error))));
  }

  formPanel(t) {
    return v_flex().w(320).flex_none().h_full().p(18).bg(t.chrome).border_l(1).border_color(t.border)
      .child(h_flex().items_center().pb(6)
        .child(div().flex_1().text_size(15).font_semibold().child(this.editing === null ? "New host" : "Edit host"))
        .child(this.iconButton(t, "form-close", "x", (cx) => { this.form = false; this.error = ""; cx.notify(); }, false, "Close")))
      .child(v_flex().id("form-scroll").flex_1().min_h(0).overflow_y_scroll()
        .children(FIELDS.map(([key, label]) => v_flex()
          .child(div().pt(10).pb(5).text_size(11.5).text_color(t.dim).child(label))
          .child(Input.new(this.inputs[key]).h(34).px(10).rounded(8).border_1()
            .border_color(this.focusedField === key ? t.accent : t.input).bg(t.background).text_size(13).text_color(t.foreground)))))
      .when(Boolean(this.error), (el) => el.child(div().pt(8).text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().pt(16).gap(8).justify_end()
        .child(this.button(t, "ssh-cancel", "Cancel", false, (_e, cx) => { this.form = false; this.error = ""; cx.notify(); }))
        .child(this.button(t, "ssh-save", "Save", true, (_e, cx) => this.save(cx))));
  }

  transferPanel(t) {
    const close = (cx) => { this.transfer = false; cx.notify(); };
    return v_flex().w(340).flex_none().h_full().p(18).bg(t.chrome).border_l(1).border_color(t.border)
      .child(h_flex().items_center().pb(6)
        .child(div().flex_1().text_size(15).font_semibold().child("Import / Export"))
        .child(this.iconButton(t, "transfer-close", "x", close, false, "Close")))
      .child(div().pt(4).text_size(12).line_height("17px").text_color(t.muted).child("A LiteTerm hosts file (.json). You can also drop one onto this tab to import it."))
      .child(div().pt(14).pb(5).text_size(11.5).text_color(t.dim).child("File path"))
      .child(Input.new(this.pathInput).h(34).px(10).rounded(8).border_1()
        .border_color(this.focusedField === "path" ? t.accent : t.input).bg(t.background).text_size(12.5).text_color(t.foreground))
      .child(h_flex().pt(14).gap(8)
        .child(this.button(t, "ssh-do-import", "Import", true, (_e, cx) => this.importFile(this.pathInput.value(), cx), "plus"))
        .child(this.button(t, "ssh-do-export", "Export", false, (_e, cx) => this.exportFile(this.pathInput.value(), cx))))
      .when(Boolean(this.note), (el) => el.child(div().pt(14).text_size(12).line_height("17px").text_color(this.noteError ? t.blocked : t.working).child(this.note)))
      .child(div().flex_1())
      .child(div().text_size(11.5).line_height("16px").text_color(t.dim).child("Import skips hosts already saved (same name, address, user and port). Saved passwords are stored and exported as plain text, and typed for you when ssh asks."));
  }

  render() {
    const t = theme();
    return h_flex().id("ssh-hosts").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_drop((e, cx) => {
        const p = (e.paths ?? []).find((x) => /\.json$/i.test(x));
        if (!p) return;
        this.transfer = true; this.form = false;
        this.pathInput.set_value(p);
        this.importFile(p, cx);
      })
      .size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .child(this.sidebar(t))
      .child(this.main(t))
      .when(this.form, (el) => el.child(this.formPanel(t)))
      .when(this.transfer, (el) => el.child(this.transferPanel(t)));
  }
}
