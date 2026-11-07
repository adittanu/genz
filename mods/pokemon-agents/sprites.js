// Fetches and prepares the art. Nothing Pokémon ships with this mod: on first use it
// downloads sprite sheets from PMDCollab's SpriteCollab and menu icons from PokeAPI into
// ~/.config/herdr-app/data/pokemon-agents/, and cuts them into GIFs with ImageMagick.
// Besides walking, standing and sleeping, each Pokémon gets the extras its sheet has: a hop
// (needs you), a little celebration (done), waking up, and a few moves and idle bits.
import { exec, appHome } from "herdr";
import * as fs from "fs/promises";

export const DATA_REL = "data/pokemon-agents";
const DATA = `${appHome()}/${DATA_REL}`;
const PMD = "https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master/sprite";
const ICONS = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-vii/icons";
// Bump when the GIF recipe changes, so old caches are rebuilt. 2: the extras below.
const VERSION = 2;

// PMD sheets have one row per facing: 0 down, 1 down-right, 2 right, 3 up-right,
// 4 up, 5 up-left, 6 left, 7 down-left. Walk sideways, stand facing the viewer.
// [cut, the animations to try in order, facing row, hold on the last frame (1/100 s)]
const CUTS = [
  ["walkR", ["Walk"], 2],
  ["walkL", ["Walk"], 6],
  ["idleR", ["Idle", "Walk"], 1],
  ["idleL", ["Idle", "Walk"], 7],
  ["sleep", ["Sleep", "Idle", "Walk"], 0],
  // The extras, facing you. A Pokémon without one stands (idles) instead.
  ["hop", ["Hop"], 0, 40], // needs you: hops for attention, a beat between hops
  ["cheer", ["Pose", "Nod", "Rotate"], 0, 160], // done: a little celebration, then a pause
  // One-offs, played once: the hold covers the moment the caller takes to switch back.
  ["wake", ["Wake"], 0, 45], // waking up from a nap
  ["charge", ["Charge"], 0, 45], // moves, now and then while its agent works
  ["attack", ["Attack"], 0, 45],
  ["sit", ["Sit"], 0, 45], // idle bits, now and then while its agent idles
  ["lookup", ["LookUp"], 0, 45],
  ["eat", ["Eat"], 0, 45],
];
// Walking, standing and sleeping must work; the extras may be missing.
const BASE = new Set(["walkR", "walkL", "idleR", "idleL", "sleep"]);

const pad = (id) => String(id).padStart(4, "0");

// ImageMagick 7 is `magick`; 6 is `convert` + `identify`. Null when neither runs.
let tools = null;
export async function imageMagick() {
  if (tools) return tools;
  const ok = async (cmd, args) => (await exec(cmd, args).catch(() => null))?.code === 0;
  if (await ok("magick", ["-version"])) tools = { convert: ["magick"], identify: ["magick", "identify"], mogrify: ["magick", "mogrify"] };
  else if (await ok("convert", ["-version"])) tools = { convert: ["convert"], identify: ["identify"], mogrify: ["mogrify"] };
  else tools = false;
  return tools;
}

async function im(kind, args) {
  const t = await imageMagick();
  if (!t) throw new Error("ImageMagick not found");
  const [cmd, ...pre] = t[kind];
  const r = await exec(cmd, [...pre, ...args]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `${cmd} failed`);
  return r.stdout.trim();
}

async function curl(pairs) {
  const args = ["-sfL", "--retry", "2", "--connect-timeout", "10"];
  for (const [file, url] of pairs) args.push("-o", file, url);
  const r = await exec("curl", args);
  if (r.code !== 0) throw new Error(`download failed (curl ${r.code})`);
}

// Several at once; some may fail (an extra the server lacks): the caller checks what arrived.
async function curlAll(pairs) {
  const args = ["-sfL", "--retry", "2", "--connect-timeout", "10", "--parallel", "--parallel-max", "8"];
  for (const [file, url] of pairs) args.push("-o", file, url);
  await exec("curl", args);
}

function parseAnims(xml) {
  const anims = {};
  for (const m of xml.matchAll(/<Anim>([\s\S]*?)<\/Anim>/g)) {
    const body = m[1];
    const get = (tag) => body.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];
    const name = get("Name");
    if (!name) continue;
    anims[name] = {
      name,
      copyOf: get("CopyOf") ?? null,
      fw: Number(get("FrameWidth")),
      fh: Number(get("FrameHeight")),
      durations: [...body.matchAll(/<Duration>(\d+)<\/Duration>/g)].map((d) => Number(d[1])),
    };
  }
  return anims;
}

// Follows CopyOf ("Idle is the same as Walk") to the animation that owns a sheet.
function resolve(anims, name) {
  let a = anims[name];
  for (let hops = 0; a?.copyOf && hops < 4; hops++) a = anims[a.copyOf];
  return a && a.fw > 0 && a.fh > 0 ? a : null;
}

// One facing of one animation as a looping GIF, pixel-doubled with nearest neighbour; `hold`
// (1/100 s) is added to the last frame. One ImageMagick run writes the GIF and measures it.
// Returns its size, the box its visible pixels fill (feet = box bottom), one loop's length
// (ms) and how long it plays before the hold (play, ms).
async function cut(sheet, dims, anim, row, scale, out, hold = 0) {
  const [w, h] = dims;
  const rows = Math.max(1, Math.floor(h / anim.fh));
  const cols = Math.max(1, Math.floor(w / anim.fw));
  const y = Math.min(row, rows - 1) * anim.fh;
  const n = Math.min(cols, anim.durations.length || cols);
  // Durations are game frames (1/60 s); GIF delays are 1/100 s.
  const cs = Array.from({ length: n }, (_, i) => Math.max(2, Math.round(((anim.durations[i] ?? 10) * 100) / 60)));
  const play = cs.reduce((t, c) => t + c, 0) * 10;
  cs[cs.length - 1] += hold;
  const delay = cs.slice(0, -1).map((c, i) => `t==${i}?${c}:`).join("") + cs[cs.length - 1];
  const box = await im("convert", [
    sheet, "-crop", `${n * anim.fw}x${anim.fh}+0+${y}`, "+repage",
    "-crop", `${anim.fw}x${anim.fh}`, "+repage",
    "-scale", `${scale * 100}%`,
    "-set", "delay", `%[fx:${delay}]`, "-set", "dispose", "Background", "-loop", "0", "-write", out,
    "-coalesce", "-background", "none", "-flatten", "-format", "%@", "info:",
  ]);
  const m = box.match(/(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/);
  const fw = anim.fw * scale;
  const fh = anim.fh * scale;
  const bb = m ? { x: +m[3], y: +m[4], w: +m[1], h: +m[2] } : { x: 0, y: 0, w: fw, h: fh };
  return { w: fw, h: fh, box: bb, ms: play + hold * 10, play };
}

const have = (file) => fs.exists(file).catch(() => false);

// The strip and the pet can ask for the same Pokémon at once: build it only once.
const building = new Map();
export function loadSprite(id) {
  if (!building.has(id)) building.set(id, buildSprite(id).finally(() => building.delete(id)));
  return building.get(id);
}

// Builds (once) and returns the sprite set for a Pokémon: { walkR, walkL, idleR, idleL, sleep }
// and whichever extras it has (hop, cheer, wake, charge, attack, sit, lookup, eat), each
// { path, w, h, box, ms, play }. Cached on disk; meta.json is written last and marks it done.
async function buildSprite(id) {
  const dir = `${DATA}/sprites/${pad(id)}`;
  const metaFile = `${dir}/meta.json`;
  if (await fs.exists(metaFile).catch(() => false)) {
    try {
      const meta = JSON.parse(await fs.readFile(metaFile, "utf8"));
      if (meta.version === VERSION) return meta;
    } catch {}
  }
  await fs.mkdir(dir, { recursive: true });
  const base = `${PMD}/${pad(id)}`;
  // A rebuild after a recipe change reuses what was downloaded before.
  if (!(await have(`${dir}/AnimData.xml`))) await curl([[`${dir}/AnimData.xml`, `${base}/AnimData.xml`]]);
  const anims = parseAnims(await fs.readFile(`${dir}/AnimData.xml`, "utf8"));
  const walk = resolve(anims, "Walk");
  if (!walk) {
    await fs.unlink(`${dir}/AnimData.xml`).catch(() => {}); // maybe a bad download: fetch it again next time
    throw new Error("no walking animation");
  }
  // Each cut takes the first of its animations this Pokémon has.
  const plan = [];
  for (const [key, tries, row, hold = 0] of CUTS) {
    const anim = tries.map((name) => resolve(anims, name)).find(Boolean);
    if (anim) plan.push({ key, anim, row, hold });
  }
  const sheet = (p) => `${dir}/${p.anim.name}.png`;
  const names = [...new Set(plan.map((p) => p.anim.name))];
  const missing = [];
  for (const n of names) if (!(await have(`${dir}/${n}.png`))) missing.push(n);
  if (missing.length) await curlAll(missing.map((n) => [`${dir}/${n}.png`, `${base}/${n}-Anim.png`]));
  // Measure each sheet once. One that won't read is deleted (fetched again next time); an
  // extra can do without it, walking and standing can't.
  const dims = {};
  await Promise.all(names.map(async (n) => {
    const file = `${dir}/${n}.png`;
    if (!(await have(file))) return;
    try {
      dims[n] = (await im("identify", ["-format", "%w %h", file])).split(" ").map(Number);
    } catch {
      await fs.unlink(file).catch(() => {});
    }
  }));
  for (const p of plan) if (BASE.has(p.key) && !dims[p.anim.name]) throw new Error(`could not get the ${p.anim.name} sheet`);
  // Big Pokémon (Onix, Gyarados...) have big frames: draw those at 1x.
  const scale = walk.fh > 64 ? 1 : 2;
  const meta = { version: VERSION, id, scale };
  await Promise.all(plan.filter((p) => dims[p.anim.name]).map(async (p) => {
    const file = `${p.key}.gif`;
    try {
      const size = await cut(sheet(p), dims[p.anim.name], p.anim, p.row, scale, `${dir}/${file}`, p.hold);
      meta[p.key] = { path: `${DATA_REL}/sprites/${pad(id)}/${file}`, ...size };
    } catch (e) {
      if (BASE.has(p.key)) throw e; // an extra that won't cut is simply left out
    }
  }));
  await fs.writeFile(metaFile, JSON.stringify(meta));
  return meta;
}

// The picker's menu icons (40x30, doubled when ImageMagick is there). One download for all 151.
export const iconPath = (id) => `${DATA_REL}/icons/${id}.png`;

export async function ensureIcons(count) {
  const dir = `${DATA}/icons`;
  const marker = `${dir}/ready`;
  if (await fs.exists(marker).catch(() => false)) return;
  await fs.mkdir(dir, { recursive: true });
  const pairs = [];
  for (let id = 1; id <= count; id++) pairs.push([`${dir}/${id}.png`, `${ICONS}/${id}.png`]);
  const args = ["-sfL", "--retry", "2", "--connect-timeout", "10", "--parallel", "--parallel-max", "16"];
  for (const [file, url] of pairs) args.push("-o", file, url);
  const r = await exec("curl", args);
  if (r.code !== 0) throw new Error(`icon download failed (curl ${r.code})`);
  if (await imageMagick()) {
    await im("mogrify", ["-scale", "200%", ...pairs.map(([file]) => file)]).catch(() => null);
  }
  await fs.writeFile(marker, String(Date.now()));
}
