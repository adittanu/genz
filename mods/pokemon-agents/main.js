// Pokémon agents: every agent is a pixel-art Pokémon roaming a strip at the bottom of the window.
// Working ones walk around and show off a move now and then, idle ones stroll, sit about and
// nap, blocked ones hop and call for you, done ones celebrate, and a napper stretches on waking.
// Click one to go to its agent; right-click to choose which of the first 151 it is.
import { View, div, image, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { agents, spaces, theme, settings, run, props, shared, setShared, openOverlay, closeOverlay, nextCommand, layout } from "herdr";
import { NAMES, COUNT, nameOf, dexNo } from "./names.js";
import { loadSprite, ensureIcons, iconPath, imageMagick } from "./sprites.js";

const KEY = "pokemon-agents"; // shared state: { panes: { <pane id>: <dex number> } }
const SLOT = 128; // width of one Pokémon's column (sprite + name tag)
const LABEL_H = 18; // name tag under the feet
const FEET = 24; // ground line, px above the strip's bottom
const SPEED = { working: 70, idle: 32 }; // px per second
const SLEEP_AFTER = 30 * 1000; // idle this long: fall asleep
// Now and then a Pokémon does a one-off: a move while its agent works, a little idle bit while
// it idles (sprites.js cuts; one a Pokémon lacks is skipped).
const ACTS = { working: ["charge", "attack"], idle: ["sit", "lookup", "eat"] };
const ACT_CHANCE = { working: 0.5, idle: 0.35 }; // per stop on the strip
const BAR_H = 26; // the strip folded down to one slim row
const FOLDED = "folded"; // localStorage: "1" while folded
const OPEN_H = "open-height"; // localStorage: the strip's height before it folded
const PET = "pokemon-agents.pet"; // shared: true while the floating pet should be out
const PET_W = 168;
const PET_H = 172;
const PET_FEET = 128; // the pet's ground line, from its window's top

// The agent the pet follows: whoever needs you, then what just finished, then work going on
// (the focused agent first), then the focused one.
function petAgent(list) {
  return list.find((a) => a.status === "blocked") ?? list.find((a) => a.status === "done")
    ?? list.find((a) => a.status === "working" && a.focused) ?? list.find((a) => a.status === "working")
    ?? list.find((a) => a.focused) ?? list[0] ?? null;
}

// Lets the pet out (a frameless window above the terminals that remembers where it was
// dropped and comes back on the next start), or calls it back.
function setPet(out) {
  setShared(PET, out);
  if (out) openOverlay({ mod: "pokemon-agents", kind: "window", frame: "none", key: "pokemon-pet", keep: true, width: PET_W, height: PET_H, props: { pet: true } });
}
const petOut = () => shared(PET) === true;

// ---- who is which Pokémon -------------------------------------------------------

const slotOf = (a) => a.pane || a.address;

function findNode(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return null;
}

function savedPicks() {
  const s = shared(KEY);
  return s && typeof s === "object" && s.panes && typeof s.panes === "object" ? s.panes : {};
}

function savePicks(update) {
  const next = { ...savedPicks(), ...update };
  const keys = Object.keys(next);
  for (let i = 0; i < keys.length - 300; i++) delete next[keys[i]]; // forget the oldest panes
  setShared(KEY, { panes: next });
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// Saved picks first; a new agent gets a Pokémon nobody on screen has yet (stable per pane).
function assign(list) {
  const saved = savedPicks();
  const ids = {};
  const fresh = {};
  const used = new Set();
  for (const a of list) {
    const id = saved[slotOf(a)];
    if (id >= 1 && id <= COUNT) { ids[a.address] = id; used.add(id); }
  }
  for (const a of list) {
    if (ids[a.address]) continue;
    let id = (hash(slotOf(a)) % COUNT) + 1;
    for (let i = 0; i < COUNT && used.has(id); i++) id = (id % COUNT) + 1;
    ids[a.address] = id;
    if (a.pane) fresh[a.pane] = id; // only remember agents that have a pane (sub-agents don't)
    used.add(id);
  }
  return { ids, fresh };
}

function tabsById() {
  const out = {};
  for (const s of spaces()) for (const t of s.tabs) out[t.id] = { ...t, space_name: s.name };
  return out;
}

function tagOf(a, tabs) {
  const t = tabs[a.tab];
  if (t?.named) return t.name;
  return a.space_name || a.tab_name || a.address;
}

// What the Pokémon is doing: walks while working, strolls while idle, sleeps when idle long.
function moodOf(a, tabs, now) {
  if (a.status === "blocked") return "blocked";
  if (a.status === "done") return "done";
  if (a.status === "working") return "working";
  // changed_at is null when nothing in the tab changed since the app started: idle all along.
  const changed = tabs[a.tab]?.changed_at;
  return changed == null || now - changed > SLEEP_AFTER ? "sleep" : "idle";
}

// A one-off this Pokémon has for the mood, or null.
function pickAct(meta, mood) {
  const keys = (ACTS[mood] ?? []).filter((k) => meta?.[k]?.play > 0);
  return keys.length ? keys[Math.floor(Math.random() * keys.length)] : null;
}

// The sprite to show: a one-off while it plays, else the mood's pose. Needs you: hops. Done:
// celebrates. Asleep: sleeps. Otherwise it walks or stands, facing `dir`.
function poseOf(meta, mood, moving, dir, act) {
  const stand = dir === "l" ? meta.idleL : meta.idleR;
  if (act && meta[act]) return meta[act];
  if (mood === "sleep") return meta.sleep;
  if (mood === "blocked") return meta.hop ?? stand;
  if (mood === "done") return meta.cheer ?? stand;
  if (moving) return dir === "l" ? meta.walkL : meta.walkR;
  return stand;
}

// Dex numbers whose name contains the search, or whose number starts with it ("25", "#025").
function matches(query) {
  const f = query.trim().toLowerCase().replace(/^#/, "");
  const out = [];
  for (let id = 1; id <= COUNT; id++) {
    const name = NAMES[id - 1].toLowerCase();
    if (!f || name.includes(f) || String(id) === f.replace(/^0+/, "") || String(id).padStart(3, "0").startsWith(f)) out.push(id);
  }
  return out;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const zoom = () => (Number(settings()?.zoom) > 0 ? Number(settings().zoom) : 1);

// ---- the view -------------------------------------------------------------------

export default class PokemonAgents extends View {
  init(_p, cx) {
    this.picker = !!props()?.picker;
    if (this.picker) return this.initPicker(cx);
    if (props()?.pet) return this.initPet(cx);
    this.width = 900;
    this.height = 112;
    this.folded = localStorage.getItem(FOLDED) === "1";
    // A pet that was out comes back with the strip (start, or a switch back to this layout).
    if (petOut()) setPet(true);
    this.mons = {}; // address -> { x, from, target, dir, moving, start, dur, pauseUntil, mood }
    this.sprites = {}; // dex number -> meta | "loading" | { error }
    this.hover = null;
    this.magick = null; // null: not checked yet
    cx.spawn(async (cx) => {
      this.magick = !!(await imageMagick());
      cx.notify();
    });
    cx.timer.every(250, (cx) => this.tick(cx));
    // keys.json: "alt-shift-p": "pokemon-agents.pick" chooses the focused agent's Pokémon.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "pet") { setPet(!petOut()); cx.notify(); continue; }
        if (c !== "pick") continue;
        const list = agents();
        const a = list.find((x) => x.focused) ?? list[0];
        if (a) this.openPicker(a, assign(list).ids[a.address], tagOf(a, tabsById()));
      }
    });
  }

  // Loads one Pokémon's sprites in the background; a failed one retries after a minute.
  want(id, cx) {
    const cur = this.sprites[id];
    if (cur === "loading" || (cur && !cur.error)) return;
    if (cur?.error && Date.now() - cur.at < 60000) return;
    this.sprites[id] = "loading";
    cx.spawn(async (cx) => {
      try {
        this.sprites[id] = await loadSprite(id);
      } catch (e) {
        this.sprites[id] = { error: String(e?.message ?? e), at: Date.now() };
      }
      cx.notify();
    });
  }

  tick(cx) {
    if (this.folded || findNode(layout(), "pokemon-agents")?.hidden) return; // folded or hidden: no walking, no sprite loads
    const now = Date.now();
    const list = agents();
    const tabs = tabsById();
    const { ids, fresh } = assign(list);
    if (Object.keys(fresh).length) savePicks(fresh); // keeps new agents' Pokémon stable
    if (this.magick) for (const id of new Set(Object.values(ids))) this.want(id, cx);

    const lo = SLOT / 2;
    const hi = Math.max(lo, this.width - SLOT / 2);
    let changed = false;
    const live = new Set();
    list.forEach((a, i) => {
      live.add(a.address);
      let m = this.mons[a.address];
      if (!m) {
        const x = clamp(((i + 0.5) / list.length) * this.width + rand(-20, 20), lo, hi);
        m = this.mons[a.address] = { x, from: x, target: x, dir: Math.random() < 0.5 ? "l" : "r", moving: false, start: 0, dur: 0, pauseUntil: now + rand(300, 2500), mood: null };
        changed = true;
      }
      const mood = moodOf(a, tabs, now);
      const meta = this.sprites[ids[a.address]];
      if (mood !== m.mood) {
        // Woken from a nap: it stretches (Wake) before anything else, if it can.
        const woke = m.mood === "sleep";
        m.mood = mood;
        m.act = null;
        if (woke) this.startAct(m, "wake", meta, now);
        changed = true;
      }
      if (m.act && now >= m.act.until) { m.act = null; changed = true; }
      if (m.moving) {
        const f = clamp((now - m.start) / m.dur, 0, 1);
        if (m.target < lo || m.target > hi) {
          // The strip got narrower mid-walk: stop inside it instead of walking off the edge.
          m.x = m.target = clamp(m.from + (m.target - m.from) * f, lo, hi);
          m.moving = false;
          m.dur = 150;
          m.pauseUntil = now + rand(1000, 3000);
          changed = true;
        } else if (f >= 1) {
          m.moving = false;
          m.x = m.target;
          m.pauseUntil = now + (mood === "working" ? rand(300, 1800) : rand(4000, 12000));
          // Now and then it does something before walking on: a move, or a little idle bit.
          if (Math.random() < (ACT_CHANCE[mood] ?? 0)) this.startAct(m, pickAct(meta, mood), meta, now);
          changed = true;
        } else if (mood !== "working" && mood !== "idle") {
          // Stop where it is: something needs the person, or it fell asleep.
          m.x = m.target = m.from + (m.target - m.from) * f;
          m.moving = false;
          m.dur = 150;
          changed = true;
        }
      } else if ((mood === "working" || mood === "idle") && now >= m.pauseUntil && hi > lo) {
        let target = rand(lo, hi);
        if (Math.abs(target - m.x) < 60) target = m.x + (target >= m.x ? 60 : -60);
        target = clamp(target, lo, hi);
        if (Math.abs(target - m.x) >= 8) {
          m.from = m.x;
          m.target = target;
          m.dir = target > m.x ? "r" : "l";
          m.start = now;
          m.dur = (Math.abs(target - m.x) / SPEED[mood]) * 1000;
          m.moving = true;
          changed = true;
        } else {
          m.pauseUntil = now + rand(1000, 3000);
        }
      }
      if (!m.moving && (m.x < lo || m.x > hi)) { m.x = m.target = clamp(m.x, lo, hi); m.dur = 150; changed = true; }
    });
    for (const k of Object.keys(this.mons)) if (!live.has(k)) { delete this.mons[k]; changed = true; }
    if (changed) cx.notify();
  }

  // A strip Pokémon's one-off: it stands still until the one-off has played.
  startAct(m, key, meta, now) {
    const s = key && meta?.[key];
    if (!s?.play) return;
    m.act = { key, at: now, until: now + s.play + 100 };
    m.pauseUntil = Math.max(m.pauseUntil ?? 0, m.act.until);
  }

  openPicker(a, id, tag) {
    openOverlay({
      mod: "pokemon-agents",
      kind: "dialog",
      width: 640,
      height: 560,
      props: { picker: true, slot: slotOf(a), current: id, tag },
    });
  }

  render(cx) {
    if (this.picker) return this.renderPicker(cx);
    if (this.pet) return this.renderPet(cx);
    return this.folded ? this.renderBar(cx) : this.renderStrip(cx);
  }

  // Folds the strip to a slim bar (its button stays in reach) or opens it at its old height.
  setFolded(folded, cx) {
    if (folded === this.folded) return;
    if (folded) {
      const px = findNode(layout(), "pokemon-agents")?.size?.px;
      if (px > BAR_H + 10) localStorage.setItem(OPEN_H, String(Math.round(px)));
    }
    this.folded = folded;
    localStorage.setItem(FOLDED, folded ? "1" : "0");
    const open = Number(localStorage.getItem(OPEN_H)) || 112;
    run("layout.resize", { id: "pokemon-agents", px: folded ? BAR_H : open });
    cx.notify();
  }

  foldButton(folded, t) {
    return h_flex().id("pokemon-fold").h(20).px(6).gap(4).flex_none().items_center().rounded(5)
      .text_size(11).text_color(t.muted).bg(t.chrome).border(1).border_color(t.border)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); this.setFolded(!folded, cx); })
      .child(svg(`mods/pokemon-agents/${folded ? "chevron-up" : "chevron-down"}.svg`).size(12))
      .child(folded ? "Show" : "Hide");
  }

  petButton(t) {
    const on = petOut();
    return h_flex().id("pokemon-pet-toggle").h(20).px(6).gap(4).flex_none().items_center().rounded(5)
      .text_size(11).text_color(on ? t.foreground : t.muted).bg(on ? t.selected : t.chrome).border(1).border_color(t.border)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); setPet(!on); cx.notify(); })
      .child(svg("mods/pokemon-agents/pokeball.svg").size(12))
      .child(on ? "Pet: on" : "Pet");
  }

  // ---- the pet: one Pokémon floating above the terminals --------------------------

  initPet(cx) {
    this.pet = true;
    // The pet is the window opened under the "pokemon-pet" key (props { pet: true }); any other
    // copy, such as one left by an older version, closes itself.
    if (props().pet !== true) {
      this.gone = true;
      closeOverlay(props().overlay);
      return;
    }
    this.sprites = {};
    this.hover = false;
    this.magick = null;
    cx.spawn(async (cx) => {
      this.magick = !!(await imageMagick());
      cx.notify();
    });
    this.act = null;
    this.prevMood = null;
    this.nextAct = Date.now() + rand(4000, 9000);
    cx.timer.every(1000, (cx) => {
      // Called back from the strip (or the shortcut): go away.
      if (!petOut()) { closeOverlay(props().overlay); return; }
      const now = Date.now();
      const list = agents();
      const a = petAgent(list);
      const id = a ? assign(list).ids[a.address] : 25;
      if (this.magick) this.want(id, cx);
      const meta = this.sprites[id];
      const mood = a ? moodOf(a, tabsById(), now) : "sleep";
      if (mood !== this.prevMood) {
        // Woken from a nap: it stretches (Wake) first, if it can.
        const woke = this.prevMood === "sleep";
        this.prevMood = mood;
        this.act = null;
        if (woke) this.playAct("wake", meta, cx);
        this.nextAct = now + rand(4000, 9000);
      } else if (!this.act && !this.hover && now >= this.nextAct) {
        // Now and then: a move while its agent works, a little idle bit while it idles.
        this.playAct(pickAct(meta, mood), meta, cx);
        this.nextAct = now + (mood === "working" ? rand(6000, 12000) : rand(8000, 16000));
      }
      // Agents changing redraws the pet by itself (every redraw repaints the whole window, so
      // no polling). Dozing off is the one change only time makes: redraw just for that.
      if (mood !== this.mood) cx.notify();
    });
  }

  // Plays one of the pet's one-offs once; then it goes back to its mood's pose.
  playAct(key, meta, cx) {
    const s = key && meta?.[key];
    if (!s?.play) return;
    const act = { key, at: Date.now() };
    this.act = act;
    cx.notify();
    cx.timer.after(s.play + 100, (cx) => {
      if (this.act === act) { this.act = null; cx.notify(); }
    });
  }

  renderPet(cx) {
    if (this.gone) return div();
    const t = theme();
    const list = agents();
    const a = petAgent(list);
    const tabs = tabsById();
    const id = a ? assign(list).ids[a.address] : 25; // no agents: Pikachu keeps you company
    const mood = a ? moodOf(a, tabs, Date.now()) : "sleep";
    this.mood = mood;
    const meta = this.sprites[id];
    const calling = list.filter((x) => x.status === "blocked").length;
    const go = () => a && (a.pane ? run("pane.focus", { pane: a.pane }) : run("agent.focus", { terminal: a.address }));

    let body;
    let headY = PET_FEET - 40;
    if (meta && meta.walkR) {
      // Working: walks on the spot. Needs you: hops. Done: celebrates. Idle a while: naps.
      const s = poseOf(meta, mood, mood === "working", "r", this.act?.key);
      const left = PET_W / 2 - (s.box.x + s.box.w / 2);
      const top = PET_FEET - (s.box.y + s.box.h);
      headY = PET_FEET - s.box.h;
      const shadowW = Math.max(14, Math.round(s.box.w * 0.7));
      // A new id for each pose (and each one-off) starts its GIF from the first frame.
      body = div().id(`pose-${s.path}-${this.act?.at ?? 0}`)
        .child(div().absolute().left(PET_W / 2 - shadowW / 2).top(PET_FEET - 2).w(shadowW).h(6).rounded_full().bg("#00000040"))
        .child(image(s.path).absolute().left(left).top(top).w(s.w).h(s.h));
    } else {
      const r = 12;
      headY = PET_FEET - 2 * r;
      body = div().absolute().left(PET_W / 2 - r).top(PET_FEET - 2 * r).size(2 * r)
        .rounded_full().overflow_hidden().border_1().border_color(t.foreground)
        .loop("opacity", { from: 0.4, to: 1, period: 1200 })
        .child(div().absolute().left(0).top(0).w(2 * r).h(r).bg("#e3350d"))
        .child(div().absolute().left(0).top(r).w(2 * r).h(r).bg("#f4f4f4"))
        .child(div().absolute().left(r - 4).top(r - 4).size(8).rounded_full().bg("#f4f4f4").border_1().border_color(t.foreground));
    }

    const bubble =
      mood === "blocked" ? div().px(7).rounded(8).bg(t.blocked).text_color("#ffffff").font_bold().child(calling > 1 ? `! ${calling}` : "!")
          .loop("opacity", { from: 0.7, to: 1, period: 900 })
      : mood === "done" ? div().px(7).rounded(8).bg(t.done).text_color("#ffffff").font_bold().child("✓")
      : mood === "sleep" ? div().text_color(t.muted).frames(["z", "zZ", "zZz", "zZ"], 700)
      : null;

    const label = a ? (this.hover ? `${nameOf(id)} · ${tagOf(a, tabs)}` : tagOf(a, tabs)) : "No agents yet";
    return div().id("pokemon-pet").relative().w(PET_W).h(PET_H).cursor_pointer()
      .on_hover((h, cx) => { if (h !== this.hover) { this.hover = h; cx.notify(); } })
      // Press and drag moves the pet; a double-click goes to its agent.
      .on_mouse_down("left", (e) => { if (e.click_count === 2) go(); })
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); if (a) this.openPicker(a, id, tagOf(a, tabs)); })
      .child(body)
      .when(!!bubble, (el) => el.child(h_flex().absolute().left(0).w(PET_W).top(Math.max(2, headY - 24)).justify_center().text_size(13).child(bubble)))
      .child(h_flex().absolute().left(8).w(PET_W - 16).top(PET_FEET + 8).h(20).px(8).gap(5).justify_center().items_center()
        .rounded(10).bg(t.popover).border(1).border_color(t.border)
        .when(!!a, (el) => el.child(div().flex_none().size(6).rounded_full().bg(t[a.status] ?? t.idle)))
        .child(div().min_w(0).truncate().text_size(10.5).text_color(t.foreground).child(label)))
      .when(this.hover, (el) => el.child(
        div().id("pokemon-pet-close").absolute().top(2).right(2).size(20).flex().items_center().justify_center()
          .rounded_full().bg(t.popover).border(1).border_color(t.border).text_color(t.muted)
          .hover((s) => s.text_color(t.foreground))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); setShared(PET, false); closeOverlay(props().overlay); })
          .child("×")));
  }

  // The folded strip: one row with a Poké Ball, how many agents are out, and Show.
  renderBar(cx) {
    const t = theme();
    const list = agents();
    const calling = list.filter((a) => a.status === "blocked").length;
    return h_flex().id("pokemon-bar").size_full().px(10).gap(8).items_center().bg(t.chrome)
      .border_t(1).border_color(t.border)
      .child(svg("mods/pokemon-agents/pokeball.svg").size(13).text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted)
        .child(list.length ? `Pokémon · ${list.length} agent${list.length === 1 ? "" : "s"}` : "Pokémon"))
      .when(calling > 0, (el) => el.child(div().px(6).rounded(7).bg(t.blocked).text_color("#ffffff").text_size(11).font_bold().child(`! ${calling}`)))
      .child(this.petButton(t))
      .child(this.foldButton(true, t));
  }

  renderStrip(cx) {
    const t = theme();
    const now = Date.now();
    const list = agents();
    const tabs = tabsById();
    const { ids } = assign(list);
    const ground = this.height - FEET;

    const root = div()
      .id("pokemon-strip")
      .relative()
      .size_full()
      .overflow_hidden()
      .bg(t.chrome)
      .on_size_change((size, cx) => {
        // The size comes in zoomed px, but everything here is drawn in unzoomed units.
        const width = size.width / zoom();
        const height = size.height / zoom();
        if (Math.abs(width - this.width) > 1 || Math.abs(height - this.height) > 1) {
          this.width = width;
          this.height = height;
          cx.notify();
        }
      })
      // the ground: a faint line the Pokémon stand on
      .child(div().absolute().left(0).right(0).top(ground + 4).h(1).bg(t.border));
    // Drawn last (below) so it sits above the Pokémon.
    const fold = h_flex().absolute().top(6).right(8).gap(6).child(this.petButton(t)).child(this.foldButton(false, t));

    if (list.length === 0) {
      return root.child(
        div().absolute().inset_0().flex().items_center().justify_center()
          .text_size(12).text_color(t.dim)
          .child("No agents yet. Each agent you start shows up here as a Pokémon."),
      ).child(fold);
    }
    if (this.magick === false) {
      root.child(
        div().absolute().top(8).right(130).text_size(11).text_color(t.muted)
          .child("Install ImageMagick (magick) to see the Pokémon"),
      );
    }

    const order = [...list].sort((a, b) => (this.mons[a.address]?.x ?? 0) - (this.mons[b.address]?.x ?? 0));
    // Name tags never overlap: the ones that matter most (hovered, needs you, focused) win.
    const rank = (a) => (this.hover === a.address ? 0 : a.status === "blocked" ? 1 : a.status === "done" ? 2 : a.focused ? 3 : 4);
    const placed = [];
    const showTag = new Set();
    for (const a of [...list].sort((x, y) => rank(x) - rank(y))) {
      const m = this.mons[a.address];
      const f = m?.moving ? clamp((now - m.start) / m.dur, 0, 1) : 1;
      const cx0 = m ? m.from + ((m.moving ? m.target : m.x) - m.from) * f : this.width / 2;
      const text = this.hover === a.address ? `${nameOf(ids[a.address])} · ${tagOf(a, tabs)}` : tagOf(a, tabs);
      const half = Math.min(SLOT - 8, text.length * 6 + 18) / 2;
      if (placed.every(([l, r]) => cx0 + half + 6 < l || cx0 - half - 6 > r)) {
        placed.push([cx0 - half, cx0 + half]);
        showTag.add(a.address);
      }
    }
    for (const a of order) {
      const id = ids[a.address];
      const m = this.mons[a.address] ?? { x: this.width / 2, target: this.width / 2, dir: "r", moving: false, dur: 0 };
      const mood = m.mood ?? moodOf(a, tabs, now);
      const meta = this.sprites[id];
      const tag = tagOf(a, tabs);
      const hovered = this.hover === a.address;
      const x = m.moving ? m.target : m.x;

      let body;
      let headY = ground - 40;
      if (meta && meta.walkR) {
        const s = poseOf(meta, mood, m.moving, m.dir, m.act?.key);
        // Stand the sprite's visible feet on the ground line, centered on its visible body.
        const left = SLOT / 2 - (s.box.x + s.box.w / 2);
        const top = ground - (s.box.y + s.box.h);
        headY = ground - s.box.h;
        const shadowW = Math.max(14, Math.round(s.box.w * 0.7));
        // A new id for each pose (and each one-off) starts its GIF from the first frame.
        body = div().id(`pose-${s.path}-${m.act?.at ?? 0}`)
          .child(div().absolute().left(SLOT / 2 - shadowW / 2).top(ground - 2).w(shadowW).h(6).rounded_full().bg("#00000030"))
          .child(image(s.path).absolute().left(left).top(top).w(s.w).h(s.h));
      } else {
        // Loading (or no ImageMagick): a little Poké Ball waits in its place.
        const r = 9;
        headY = ground - 2 * r;
        body = div()
          .absolute().left(SLOT / 2 - r).top(ground - 2 * r).size(2 * r)
          .rounded_full().overflow_hidden().border_1().border_color(t.foreground)
          .when(meta === "loading" || meta === undefined, (el) => el.loop("opacity", { from: 0.35, to: 1, period: 1200 }))
          .child(div().absolute().left(0).top(0).w(2 * r).h(r).bg("#e3350d"))
          .child(div().absolute().left(0).top(r).w(2 * r).h(r).bg("#f4f4f4"))
          .child(div().absolute().left(r - 3).top(r - 3).size(6).rounded_full().bg("#f4f4f4").border_1().border_color(t.foreground));
      }

      const bubble =
        mood === "blocked" ? div().px(6).rounded(7).bg(t.blocked).text_color("#ffffff").font_bold().child("!")
            .loop("opacity", { from: 0.7, to: 1, period: 900 })
        : mood === "done" ? div().px(6).rounded(7).bg(t.done).text_color("#ffffff").font_bold().child("✓")
        : mood === "sleep" ? div().text_color(t.muted).frames(["z", "zZ", "zZz", "zZ"], 700)
        : null;

      const name = hovered ? `${nameOf(id)} · ${tag}` : tag;
      root.child(
        div()
          .id(`mon-${a.address}`)
          .absolute()
          .top(0)
          .h_full()
          .w(SLOT)
          .left(x - SLOT / 2)
          .transition("left", { duration: Math.max(1, Math.round(m.moving ? m.dur : m.dur || 150)), easing: "linear" })
          .cursor_pointer()
          .on_hover((h, cx) => {
            const next = h ? a.address : this.hover === a.address ? null : this.hover;
            if (next !== this.hover) { this.hover = next; cx.notify(); }
          })
          .on_click(() => (a.pane ? run("pane.focus", { pane: a.pane }) : run("agent.focus", { terminal: a.address })))
          .on_mouse_down("right", (_e, cx) => {
            cx.stop_propagation();
            this.openPicker(a, id, tag);
          })
          .child(body)
          .when(!!bubble, (el) =>
            el.child(h_flex().absolute().left(0).w(SLOT).top(Math.max(2, headY - 22)).justify_center().text_size(12.5).child(bubble)))
          .when(showTag.has(a.address), (el) => el.child(
            h_flex()
              .absolute().left(4).w(SLOT - 8).top(ground + 6).h(LABEL_H)
              .justify_center().items_center().gap(4)
              .child(div().flex_none().size(6).rounded_full().bg(t[a.status] ?? t.idle))
              .child(
                div().min_w(0).truncate().text_size(10.5)
                  .text_color(hovered || a.focused ? t.foreground : t.muted)
                  .child(name),
              ),
          )),
      );
    }
    return root.child(fold);
  }

  // ---- the picker (opened as a dialog with props { picker, slot, current, tag }) ----

  initPicker(cx) {
    this.filter = "";
    this.icons = "loading";
    this.input = InputState.new({ placeholder: "Search by name or number…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); cx.notify(); });
    this.input.on("submit", () => {
      const shown = matches(this.input.value());
      if (shown.length === 1) this.choose(shown[0]);
    });
    this.input.focus();
    cx.timer.after(300, () => this.input.focus());
    cx.spawn(async (cx) => {
      try {
        await ensureIcons(COUNT);
        this.icons = "ready";
      } catch {
        this.icons = "failed";
      }
      cx.notify();
    });
  }

  choose(id) {
    const p = props();
    savePicks({ [p.slot]: id });
    closeOverlay(p.overlay);
  }

  renderPicker(cx) {
    const t = theme();
    const p = props() ?? {};
    const shown = matches(this.filter);
    return v_flex()
      .id("pokemon-picker")
      .size_full()
      .min_h(0)
      .p(18)
      .gap(12)
      .bg(t.popover)
      .child(
        h_flex().items_center().justify_between()
          .child(
            v_flex().min_w(0).gap(2)
              .child(div().text_size(15).font_semibold().text_color(t.foreground).child("Choose a Pokémon"))
              .child(div().text_size(11.5).text_color(t.muted).truncate().child(`for ${p.tag ?? "this agent"} · now ${nameOf(p.current)}`)),
          )
          .child(div().text_size(11).text_color(t.dim).child("Esc")),
      )
      .child(
        Input.new(this.input).h(34).flex_none().px(10).rounded(8).border_1().border_color(t.accent)
          .bg(t.background).text_size(12.5).text_color(t.foreground),
      )
      .when(this.icons === "failed", (el) =>
        el.child(div().text_size(11).text_color(t.muted).child("Couldn't download the icons; names only.")))
      .child(
        div().flex_1().min_h(0).overflow_y_scrollbar().child(
          h_flex().flex_wrap().gap(6).children(
            shown.map((id) => {
              const current = id === p.current;
              return v_flex()
                .id(`pick-${id}`)
                .w(92).h(96).flex_none()
                .items_center().justify_center().gap(2)
                .rounded(8).border_1()
                .border_color(current ? t.accent : "#00000000")
                .bg(current ? t.selected : "#00000000")
                .hover((s) => s.bg(t.hover))
                .cursor_pointer()
                .on_click(() => this.choose(id))
                .child(
                  this.icons === "ready"
                    ? image(iconPath(id)).w(80).h(60).flex_none()
                    : div().w(80).h(60).flex_none(),
                )
                .child(div().text_size(9.5).text_color(t.dim).child(dexNo(id)))
                .child(div().w_full().px(2).text_center().truncate().text_size(11).text_color(t.foreground).child(NAMES[id - 1]));
            }),
          ),
        ),
      );
  }
}
