// 9Router quota: signs in to a 9Router server (URL + dashboard password) and
// lists what every connected account has left. Setup is those two fields; the
// pair is saved in <appHome>/data/9router-quota.json.
//
// The dashboard API answers with a cookie, and the shell's fetch() cannot read
// response headers, so the calls go through curl: it keeps the cookie jar.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { appHome, exec, readTextFile, writeTextFile, theme, notify } from "herdr";

const CONFIG = () => `${appHome()}/data/9router-quota.json`;
const JAR = () => `${appHome()}/data/9router-quota.cookies`;
const PREFS = () => `${appHome()}/data/9router-quota-ui.json`;
const POLL_MS = 5 * 60 * 1000; // quota moves slowly, and upstream calls are slow
const RETRY_MS = 30 * 60 * 1000; // a connection with no usage API is asked again later

// Antigravity reports one row per model and four rolled-up buckets; the
// dashboard shows the buckets plus the rows they don't cover (image models).
const BUCKET = /^(gemini|claude_gpt)_(session|weekly)$/;
const OWN_BUCKET = /image|video|audio|speech|tts|embed/i;

const trimUrl = (value) => (value ?? "").trim().replace(/\/+$/, "");

// curl writes the body, then the status on its own last line.
async function request(url, args) {
  const result = await exec("curl", ["-sS", "-m", "20", ...args, "-w", "\n%{http_code}", url]);
  const out = result.stdout ?? "";
  const cut = out.lastIndexOf("\n");
  const status = cut < 0 ? 0 : Number(out.slice(cut + 1).trim()) || 0;
  let body = null;
  try {
    body = cut < 0 ? null : JSON.parse(out.slice(0, cut));
  } catch {
    body = null;
  }
  return { status, body, code: result.code };
}

function remaining(quota) {
  if (quota?.unlimited) return 100;
  if (typeof quota?.remainingPercentage === "number") return Math.max(0, Math.min(100, quota.remainingPercentage));
  const total = Number(quota?.total) || 0;
  const left = typeof quota?.remaining === "number" ? quota.remaining : total - (Number(quota?.used) || 0);
  return total > 0 ? Math.max(0, Math.min(100, (left / total) * 100)) : 100;
}

function resetIn(at) {
  if (!at) return 0;
  const ms = new Date(at).getTime() - Date.now();
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function shortReset(ms) {
  if (!ms) return "";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

function amount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  if (Number.isInteger(n)) return n >= 1000 ? n.toLocaleString("en-US") : String(n);
  return n.toFixed(1);
}

// Every provider invents its own quota keys and totals (0/100, 0/1,000,
// 86.35/250, $0/$2.5), so each one gets its own line.
function quotaLine(key, quota) {
  const total = Number(quota?.total) || 0;
  const used = typeof quota?.used === "number" ? quota.used : Math.max(0, total - (Number(quota?.remaining) || 0));
  const money = quota?.unit === "USD" ? "$" : "";
  return {
    label: quota?.displayName || key,
    amount: quota?.unlimited ? "∞" : `${money}${amount(used)} / ${money}${amount(total)}`,
    pct: Math.round(remaining(quota)),
    unlimited: Boolean(quota?.unlimited),
    left: resetIn(quota?.resetAt),
  };
}

function group(connection, data) {
  const entries = Object.entries(data?.quotas ?? {});
  const rolled = entries.some(([key]) => BUCKET.test(key));
  const lines = (rolled ? entries.filter(([key, quota]) => BUCKET.test(key) || OWN_BUCKET.test(quota?.displayName || key)) : entries)
    .map(([key, quota]) => quotaLine(key, quota))
    .sort((a, b) => (a.left || Infinity) - (b.left || Infinity) || a.label.localeCompare(b.label));
  const worst = lines.reduce((low, q) => (low === null || q.pct < low ? q.pct : low), null);
  return {
    id: connection.id,
    provider: connection.provider || "",
    name: connection.name || connection.email || connection.provider,
    plan: data?.plan || connection.provider,
    active: connection.isActive !== false,
    quotas: lines,
    worst,
    error: data?.error || "",
    message: data?.message || "",
  };
}

// "Usage not available" is noise: the panel shows what there is to see.
const shows = (g) => g.quotas.length > 0 || Boolean(g.error) || (Boolean(g.message) && !/not available/i.test(g.message));

const ago = (at) => {
  const minutes = Math.round((Date.now() - at) / 60000);
  return minutes < 1 ? "now" : `${minutes}m`;
};

// Remaining quota, in three bands: above 80% is comfortable (green), 31-80%
// is being used (orange), 30% and below is running out (red). Fixed colours
// rather than theme ones: the theme's own "blocked" is not guaranteed to
// read as orange, and the bands must mean the same thing in every theme.
const GREEN = "#22c55e";
const ORANGE = "#f59e0b";
const RED = "#ef4444";
const LOW = 30;
const hue = (t, pct) => (pct === null ? t.dim : pct > 80 ? GREEN : pct > LOW ? ORANGE : RED);
const fill = (t, pct) => hue(t, pct);

// Anonymous mode: keep the first character so accounts stay tellable apart,
// hide the rest (and a fixed length, so the real one is not given away).
const mask = (text) => {
  const s = String(text ?? "");
  return s ? `${s[0]}${"•".repeat(7)}` : s;
};

const PROVIDER_NAMES = { github: "GitHub", openai: "OpenAI", iflow: "iFlow", qwen: "Qwen" };
const providerName = (id) => PROVIDER_NAMES[id] ?? (id ? id[0].toUpperCase() + id.slice(1) : "Other");

// Accounts with quota come first, worst first; the ones with only an error or
// a message follow.
const rank = (g) => (g.quotas.length ? g.worst : 1000 + (g.error ? 0 : 1));
const soonest = (g) => g.quotas.reduce((min, q) => (q.left > 0 && q.left < min ? q.left : min), Infinity);
const SORTS = [
  { key: "low", label: "Lowest first", cmp: (a, b) => rank(a) - rank(b) },
  { key: "reset", label: "Resets soon", cmp: (a, b) => soonest(a) - soonest(b) || rank(a) - rank(b) },
  { key: "name", label: "Name", cmp: (a, b) => a.name.localeCompare(b.name) },
];

async function mapLimit(items, limit, run) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        out[index] = await run(items[index], index);
      }
    }),
  );
  return out;
}

export default class Quota extends View {
  init(_props, cx) {
    this.groups = [];
    this.error = "";
    this.loading = false;
    this.updated = 0;
    this.setup = false;
    this.config = null;
    this.raw = null;
    this.signedIn = false;
    this.attempt = 0;
    this.retryAt = 0;
    this.skip = {}; // connection id -> when it last reported no usage API
    this.open = {}; // connection id -> card opened (true) or closed (false) by hand
    this.anon = false; // hide account names (screen sharing)
    this.filter = "all"; // "all" or a provider id
    this.prefsRaw = null;
    this.query = ""; // search text
    this.sort = "low"; // a key of SORTS
    this.hideOff = false; // hide disabled accounts
    this.alerts = true; // notify when a quota turns red or resets
    this.levels = {}; // "id|quota" -> was it low at the last refresh
    this.baseline = false; // the first refresh only records levels
    this.focusedField = null;

    this.searchInput = InputState.new({ placeholder: "Search accounts" });
    this.searchInput.on("change", (_e, cx) => { this.query = this.searchInput.value(); cx.notify(); });

    this.urlInput = InputState.new({ placeholder: "https://9r.example.com" });
    this.passInput = InputState.new({ placeholder: "Dashboard password" });
    this.passInput.set_masked(true);
    for (const [key, state] of [["url", this.urlInput], ["pass", this.passInput], ["search", this.searchInput]]) {
      state.on("focus", (_e, cx) => { this.focusedField = key; cx.notify(); });
      state.on("blur", (_e, cx) => { if (this.focusedField === key) this.focusedField = null; cx.notify(); });
      if (key !== "search") state.on("submit", (_e, cx) => this.save(cx));
    }

    cx.timer.every(POLL_MS, (cx) => this.refresh(cx, false));
    // The "updated … ago" tooltip and the reset countdowns only move on a redraw.
    cx.timer.every(30000, (cx) => { if (this.updated > 0 && !this.setup) cx.notify(); });
    cx.spawn(async (cx) => {
      this.prefsRaw = await readTextFile(PREFS()).catch(() => null);
      try {
        const prefs = this.prefsRaw ? JSON.parse(this.prefsRaw) : {};
        this.anon = Boolean(prefs.anon);
        this.filter = typeof prefs.filter === "string" ? prefs.filter : "all";
        if (SORTS.some((s) => s.key === prefs.sort)) this.sort = prefs.sort;
        this.hideOff = Boolean(prefs.hideOff);
        this.alerts = prefs.alerts !== false;
      } catch {
        this.prefsRaw = null;
      }
      this.raw = await readTextFile(CONFIG()).catch(() => null);
      try {
        this.config = this.raw ? JSON.parse(this.raw) : null;
      } catch {
        this.config = null;
      }
      if (this.config?.url) this.urlInput.set_value(this.config.url);
      this.setup = !this.config?.url || !this.config?.password;
      if (!this.setup) await this.refresh(cx, true);
      cx.notify();
    });
  }

  async login() {
    this.signedIn = false;
    const res = await request(`${trimUrl(this.config.url)}/api/auth/login`, [
      "-c", JAR(),
      "-X", "POST",
      "-H", "Content-Type: application/json",
      "--data-raw", JSON.stringify({ password: this.config.password }),
    ]);
    const wait = Number(res.body?.retryAfter) || 0;
    if (wait > 0) this.retryAt = Date.now() + wait * 1000;
    if (res.status !== 200) throw new Error(res.body?.error || `Login failed (${res.status || res.code})`);
    this.retryAt = 0;
    this.signedIn = true;
  }

  async get(path, retry = true) {
    const res = await request(`${trimUrl(this.config.url)}${path}`, ["-b", JAR()]);
    if (res.status === 401 && retry) {
      await this.login();
      return this.get(path, false);
    }
    if (res.status !== 200) throw new Error(res.body?.error || `${path} failed (${res.status || res.code})`);
    return res.body ?? {};
  }

  refresh(cx, login) {
    if (!this.config?.url || !this.config?.password || this.loading) return;
    // Nobody asked and there is no session: a wrong password must not be
    // retried on every tick, or the server locks the account out.
    if (!login && !this.signedIn) return;
    if (this.retryAt && Date.now() < this.retryAt) {
      this.error = `Locked out by the server. Try again in ${Math.ceil((this.retryAt - Date.now()) / 1000)}s.`;
      cx.notify();
      return;
    }
    this.loading = true;
    const attempt = ++this.attempt;
    cx.notify();
    // A request that never comes back must not leave the button spinning.
    cx.timer.after(45000, (cx) => {
      if (this.attempt !== attempt || !this.loading) return;
      this.loading = false;
      this.error = "The server did not answer. Check the URL, then press refresh.";
      cx.notify();
    });
    cx.spawn(async (cx) => {
      try {
        if (login) await this.login();
        const { connections = [] } = await this.get("/api/providers");
        const now = Date.now();
        // Disabled connections still report quota, so they are asked too.
        const wanted = connections.filter((c) => !(this.skip[c.id] && now - this.skip[c.id] < RETRY_MS));
        const groups = await mapLimit(wanted, 3, async (connection) => {
          try {
            const data = await this.get(`/api/usage/${encodeURIComponent(connection.id)}`);
            const next = group(connection, data);
            if (shows(next)) delete this.skip[connection.id];
            else this.skip[connection.id] = now;
            return next;
          } catch (e) {
            this.skip[connection.id] = now;
            return { ...group(connection, {}), error: String(e?.message ?? e) };
          }
        });
        const kept = this.groups.filter((g) => !wanted.some((c) => c.id === g.id));
        const all = [...kept, ...groups].filter(shows);
        this.alert(all);
        this.groups = all.sort((a, b) => rank(a) - rank(b));
        this.updated = Date.now();
        this.error = "";
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.signedIn = false;
      } finally {
        if (this.attempt === attempt) {
          this.loading = false;
          cx.notify();
        }
      }
    });
  }

  // The write is awaited, so the click's cx is gone by then: everything after
  // it runs inside the task, whose own cx stays valid.
  save(cx) {
    const url = trimUrl(this.urlInput.value());
    const password = this.passInput.value();
    if (!url || !password) {
      this.error = "URL and password are both required";
      cx.notify();
      return;
    }
    this.error = "";
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const text = JSON.stringify({ url, password }, null, 2);
      try {
        await writeTextFile(CONFIG(), text, this.raw);
        this.raw = text;
        this.config = { url, password };
        this.signedIn = false;
        this.retryAt = 0;
        this.skip = {};
        this.groups = [];
        this.updated = 0;
        this.setup = false;
        this.loading = false;
        this.refresh(cx, true);
      } catch (e) {
        this.error = `Couldn't save: ${e}`;
        this.loading = false;
        cx.notify();
      }
    });
  }

  iconButton(t, id, path, tip, color, action) {
    return div().id(id).w(24).h(24).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(color).hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer().tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(svg(path).size(14));
  }

  // Accounts that are running low open by themselves; healthy ones stay closed
  // so the panel shows what needs attention first. A click overrides either.
  isOpen(g) {
    if (g.id in this.open) return this.open[g.id];
    if (!g.quotas.length) return true;
    return g.worst !== null && g.worst <= 30;
  }

  // The filter that is really in effect: a saved provider that no longer has
  // any account falls back to "all" instead of leaving the panel empty.
  current() {
    return this.filter !== "all" && this.groups.some((g) => g.provider === this.filter) ? this.filter : "all";
  }

  // Tells the person when a quota drops into the red or climbs back out of it,
  // one notification per kind per refresh. The first refresh only records the
  // levels, so opening the panel never fires, and disabled accounts stay quiet.
  alert(groups) {
    const lowered = [];
    const restored = [];
    const next = {};
    for (const g of groups) {
      if (!g.active) continue;
      for (const q of g.quotas) {
        if (q.unlimited) continue;
        const key = `${g.id}|${q.label}`;
        const low = q.pct <= LOW;
        next[key] = low;
        if (!this.baseline || !(key in this.levels) || this.levels[key] === low) continue;
        const who = `${this.anon ? mask(g.name) : g.name} · ${q.label}`;
        (low ? lowered : restored).push(low ? `${who}: ${q.pct}% left` : `${who}: back to ${q.pct}%`);
      }
    }
    this.levels = next;
    this.baseline = true;
    if (!this.alerts) return;
    const post = (list, one, many, level) => {
      if (!list.length) return;
      const more = list.length > 3 ? `\n+${list.length - 3} more` : "";
      notify({ title: list.length === 1 ? one : `${list.length} ${many}`, body: list.slice(0, 3).join("\n") + more, level });
    };
    post(lowered, "Quota running low", "quotas running low", "warning");
    post(restored, "Quota reset", "quotas reset", "success");
  }

  // Anonymous mode also covers text the server wrote: an error can quote the
  // account's name or email.
  safe(text, name) {
    if (!this.anon) return text;
    let out = String(text ?? "");
    if (name) out = out.split(name).join(mask(name));
    return out.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, (match) => mask(match));
  }

  visible() {
    const key = this.current();
    const query = this.query.trim().toLowerCase();
    const sort = SORTS.find((s) => s.key === this.sort) ?? SORTS[0];
    return this.groups
      .filter((g) => (key === "all" || g.provider === key)
        && (!this.hideOff || g.active)
        && (!query || `${g.name} ${g.plan} ${providerName(g.provider)}`.toLowerCase().includes(query)))
      .sort(sort.cmp);
  }

  savePrefs() {
    const text = JSON.stringify({
      anon: this.anon, filter: this.filter, sort: this.sort, hideOff: this.hideOff, alerts: this.alerts,
    }, null, 2);
    writeTextFile(PREFS(), text, this.prefsRaw).then(() => { this.prefsRaw = text; }).catch(() => {});
  }

  pill(t, id, label, active, tip, action) {
    return h_flex().id(id).h(22).px(9).flex_none().items_center().rounded(11).border_1()
      .border_color(active ? t.accent : t.border).bg(active ? t.selected : t.surface)
      .cursor_pointer().hover((s) => s.bg(active ? t.selected : t.hover)).tooltip(tip)
      .on_click((_e, cx) => action(cx))
      .child(div().whitespace_nowrap().text_size(10.5).text_color(active ? t.foreground : t.muted).child(label));
  }

  searchRow(t) {
    const sort = SORTS.find((s) => s.key === this.sort) ?? SORTS[0];
    return h_flex().w_full().gap(6).pt(6).items_center()
      .child(Input.new(this.searchInput).w("56%").h(26).px(9).rounded(7).border_1()
        .border_color(this.focusedField === "search" ? t.accent : t.input).bg(t.background)
        .text_size(11.5).text_color(t.foreground))
      .child(h_flex().flex_1().min_w(0).justify_end()
        .child(this.pill(t, "quota-sort", `↕ ${sort.label}`, false, "Change the order", (cx) => {
          this.sort = SORTS[(SORTS.indexOf(sort) + 1) % SORTS.length].key;
          this.savePrefs();
          cx.notify();
        })));
  }

  chip(t, key, label, count) {
    const active = this.current() === key;
    return h_flex().id(`quota-chip-${key}`).h(22).px(9).gap(5).flex_none().items_center().rounded(11)
      .border_1().border_color(active ? t.accent : t.border).bg(active ? t.selected : t.surface)
      .cursor_pointer().hover((s) => s.bg(active ? t.selected : t.hover))
      .on_click((_e, cx) => { this.filter = key; this.savePrefs(); cx.notify(); })
      .child(div().whitespace_nowrap().text_size(10.5).text_color(active ? t.foreground : t.muted).child(label))
      .child(div().whitespace_nowrap().text_size(10).text_color(t.dim).child(String(count)));
  }

  chips(t) {
    const counts = new Map();
    for (const g of this.groups) counts.set(g.provider, (counts.get(g.provider) ?? 0) + 1);
    const off = this.groups.filter((g) => !g.active).length;
    if (counts.size < 2 && off === 0) return null;
    const order = [...counts.entries()].sort((a, b) => b[1] - a[1] || providerName(a[0]).localeCompare(providerName(b[0])));
    return h_flex().w_full().flex_none().flex_wrap().gap(4).pt(6)
      .when(counts.size >= 2, (el) => el
        .child(this.chip(t, "all", "All", this.groups.length))
        .children(order.map(([id, n]) => this.chip(t, id, providerName(id), n))))
      .when(off > 0, (el) => el
        .child(this.pill(t, "quota-hide-off", `${this.hideOff ? "Disabled hidden" : "Hide disabled"} · ${off}`, this.hideOff,
          this.hideOff ? "Show disabled accounts again" : "Hide accounts turned off in 9Router",
          (cx) => { this.hideOff = !this.hideOff; this.savePrefs(); cx.notify(); })));
  }

  summary(t) {
    const shown = this.visible();
    const total = shown.length;
    const low = shown.filter((g) => g.worst !== null && g.worst <= LOW).length;
    const allOpen = shown.every((g) => this.isOpen(g));
    return h_flex().w_full().h(20).gap(6).items_center()
      .child(div().text_size(10.5).text_color(t.dim).child(`${total} ${total === 1 ? "account" : "accounts"}`))
      .when(low > 0, (el) => el
        .child(div().text_size(10.5).text_color(t.dim).child("·"))
        .child(div().text_size(10.5).font_semibold().text_color(t.blocked).child(`${low} running low`)))
      .child(div().flex_1().min_w(0))
      .child(div().id("quota-toggle-all").h(20).px(6).flex_none().flex().items_center().rounded(5)
        .text_size(10.5).text_color(t.dim).hover((s) => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .on_click((_e, cx) => {
          for (const g of shown) this.open[g.id] = !allOpen;
          cx.notify();
        })
        .child(allOpen ? "Collapse all" : "Expand all"));
  }

  header(t) {
    const ready = !this.setup;
    const chips = ready && this.groups.length > 0 ? this.chips(t) : null;
    return v_flex().w_full().flex_none().px(14).pt(10).pb(8).gap(2).border_b_1().border_color(t.border)
      .child(h_flex().w_full().h(26).gap(6).items_center()
        .child(svg("mods/quota/gauge.svg").size(14).flex_none().text_color(t.dim))
        .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Quota"))
        .child(div().flex_1().min_w(0))
        .when(ready, (el) => el
          .child(this.iconButton(t, "quota-alerts", this.alerts ? "mods/quota/bell.svg" : "mods/quota/bell-off.svg",
            this.alerts ? "Alerts on: notify when a quota runs low or resets" : "Alerts off",
            this.alerts ? t.dim : t.accent,
            (cx) => { this.alerts = !this.alerts; this.savePrefs(); cx.notify(); }))
          .child(this.iconButton(t, "quota-anon", this.anon ? "mods/quota/eye-off.svg" : "mods/quota/eye.svg",
            this.anon ? "Anonymous mode on: names hidden" : "Hide account names", this.anon ? t.accent : t.dim,
            (cx) => { this.anon = !this.anon; this.savePrefs(); cx.notify(); }))
          .child(this.iconButton(t, "quota-refresh", "mods/quota/refresh-cw.svg",
            this.loading ? "Refreshing…" : this.updated > 0 ? `Refresh · updated ${ago(this.updated) === "now" ? "just now" : `${ago(this.updated)} ago`}` : "Refresh",
            this.loading ? t.accent : t.dim, (cx) => this.refresh(cx, true)))
          .child(this.iconButton(t, "quota-settings", "mods/quota/settings.svg", "Server settings", t.dim,
            (cx) => { this.setup = true; this.error = ""; cx.notify(); }))))
      .when(ready && this.groups.length > 0, (el) => el.child(this.searchRow(t)))
      .when(ready && this.groups.length > 0, (el) => el.child(this.summary(t)))
      .when(Boolean(chips), (el) => el.child(chips));
  }

  form(t) {
    const field = (state, key) => Input.new(state).h(32).px(10).rounded(8).border_1()
      .border_color(this.focusedField === key ? t.accent : t.input).bg(t.background).text_size(12).text_color(t.foreground);
    return v_flex().id("quota-form").flex_1().min_h(0).px(14).py(12).gap(8)
      .child(div().text_size(11).line_height("16px").text_color(t.dim)
        .child("Sign in to your 9Router server. The password is kept in data/9router-quota.json as plain text."))
      .child(field(this.urlInput, "url"))
      .child(field(this.passInput, "pass"))
      .when(Boolean(this.error), (el) => el.child(div().text_size(10.5).line_height("15px").text_color(t.blocked).child(this.error)))
      .child(h_flex().gap(8).pt(2)
        .child(h_flex().id("quota-connect").h(28).px(12).items_center().rounded(7)
          .bg(t.solid).text_color(t.solid_foreground).text_size(11.5).font_semibold().cursor_pointer()
          .hover((s) => s.opacity(0.9)).on_click((_e, cx) => this.save(cx))
          .child(this.loading ? "Connecting…" : "Connect"))
        .when(Boolean(this.config?.url && this.config?.password), (el) => el
          .child(h_flex().id("quota-cancel").h(28).px(12).items_center().rounded(7)
            .bg(t.raised).text_color(t.muted).text_size(11.5).cursor_pointer().hover((s) => s.opacity(0.9))
            .on_click((_e, cx) => { this.setup = false; this.error = ""; cx.notify(); })
            .child("Cancel"))))
      .child(div().flex_1());
  }

  bar(t, pct, color, height) {
    const value = Math.max(0, Math.min(100, pct));
    return h_flex().w_full().h(height).flex_none().rounded(height / 2).bg(t.hover).overflow_hidden()
      .child(div().h_full().flex_none().rounded(height / 2).bg(color).w(`${value}%`));
  }

  // Columns are shares of the card ("65%"), not pixel widths worked out from a
  // measured panel: the measurement came back smaller than the real panel, which
  // left the numbers floating short of the right edge. The right-hand cell takes
  // whatever remains (flex_1) and pushes its text to the edge.
  row(t, quota) {
    const pct = quota.unlimited ? null : quota.pct;
    return v_flex().w_full().gap(5)
      .child(h_flex().w_full().items_center()
        .child(div().flex_none().w("65%").overflow_hidden().truncate().text_size(11.5).text_color(t.foreground).child(quota.label))
        .child(h_flex().flex_1().min_w(0).gap(4).items_baseline().justify_end()
          .child(div().whitespace_nowrap().text_size(11.5).font_semibold().text_color(hue(t, pct))
            .child(quota.unlimited ? "∞" : `${quota.pct}%`))
          .when(!quota.unlimited, (el) => el.child(div().whitespace_nowrap().text_size(10).text_color(t.dim).child("left")))))
      .child(this.bar(t, quota.unlimited ? 100 : quota.pct, fill(t, quota.unlimited ? 100 : quota.pct), 4))
      .child(h_flex().w_full().items_center()
        .child(div().flex_none().w("45%").overflow_hidden().truncate().text_size(10).text_color(t.dim).child(quota.amount))
        .child(div().flex_1().min_w(0).text_right().whitespace_nowrap().text_size(10).text_color(t.dim)
          .child(quota.left ? `resets ${shortReset(quota.left)}` : "")));
  }

  account(t, g) {
    const open = this.isOpen(g);
    const expandable = g.quotas.length > 0;
    const sub = [g.plan, g.active ? null : "disabled"].filter(Boolean).join(" · ");
    const head = h_flex().id(`quota-head-${g.id}`).w_full().px(12).py(10).gap(8).items_center().bg(t.raised)
      .when(expandable, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.open[g.id] = !open; cx.notify(); }))
      .child(expandable
        ? svg(open ? "mods/quota/chevron-down.svg" : "mods/quota/chevron-right.svg").size(13).flex_none().text_color(t.dim)
        : div().w(13).h(13).flex_none())
      .child(div().w(8).h(8).flex_none().rounded_full().bg(hue(t, g.worst)))
      .child(v_flex().flex_none().w("64%").gap(2)
        .child(div().w_full().overflow_hidden().truncate().text_size(12).font_semibold()
          .text_color(g.active ? t.foreground : t.dim).child(this.anon ? mask(g.name) : g.name))
        .child(div().w_full().overflow_hidden().truncate().text_size(10).text_color(t.dim).child(sub)))
      .child(div().flex_1().min_w(0).text_right().whitespace_nowrap().text_size(12.5).font_semibold()
        .text_color(hue(t, g.worst)).child(g.worst === null ? "" : `${g.worst}%`));
    return v_flex().id(`quota-${g.id}`).w_full().flex_none().rounded(10).border_1().border_color(t.input)
      .bg(t.surface).overflow_hidden()
      .child(head)
      .when(expandable && !open && g.worst !== null, (el) => el
        .child(v_flex().w_full().px(12).pt(2).pb(11).child(this.bar(t, g.worst, fill(t, g.worst), 3))))
      .when(expandable && open, (el) => el
        .child(div().w_full().h(1).flex_none().bg(t.border))
        .child(v_flex().w_full().px(12).py(12).gap(14)
          .children(g.quotas.map((quota) => this.row(t, quota)))))
      .when(Boolean(g.error), (el) => el
        .child(h_flex().w_full().px(12).py(10).gap(6).items_start()
          .child(svg("mods/quota/circle-alert.svg").size(13).flex_none().text_color(RED))
          .child(div().flex_none().w("88%").text_size(10.5).line_height("15px").text_color(RED).child(this.safe(g.error, g.name)))))
      .when(Boolean(g.message) && !g.error, (el) => el
        .child(div().w_full().px(12).py(10).text_size(10.5).line_height("15px").text_color(t.dim).child(this.safe(g.message, g.name))));
  }

  body(t) {
    const shown = this.visible();
    return v_flex().id("quota-body").w_full().flex_1().min_h(0).px(14).py(14).gap(14).overflow_y_scrollbar()
      .when(Boolean(this.error), (el) => el
        .child(h_flex().w_full().flex_none().px(12).py(10).gap(8).items_start().rounded(10).border_1().border_color(t.input).bg(t.surface)
          .child(svg("mods/quota/circle-alert.svg").size(13).flex_none().text_color(RED))
          .child(div().flex_none().w("88%").text_size(11).line_height("16px").text_color(RED).child(this.safe(this.error)))))
      .when(!this.error && this.loading && !this.groups.length, (el) => el
        .child(div().text_size(11).text_color(t.dim).child("Loading…")))
      .when(!this.error && !this.loading && !this.groups.length, (el) => el
        .child(div().w_full().text_size(11).line_height("16px").text_color(t.dim)
          .child("No connected account reports quota. Kiro, Antigravity and Codex usually do.")))
      .when(this.groups.length > 0 && shown.length === 0, (el) => el
        .child(div().w_full().text_size(11).line_height("16px").text_color(t.dim)
          .child("No account matches the search or filter.")))
      .children(shown.map((g) => this.account(t, g)));
  }

  render() {
    const t = theme();
    return v_flex().id("quota").size_full().min_h(0).bg(t.background).text_color(t.foreground)
      .child(this.header(t))
      .child(this.setup ? this.form(t) : this.body(t));
  }
}
