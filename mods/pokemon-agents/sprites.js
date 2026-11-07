// Fetches and prepares the art. Nothing Pokémon ships with this mod: on first use it
// downloads sprite sheets from PMDCollab's SpriteCollab and menu icons from PokeAPI into
// ~/.config/herdr-app/data/pokemon-agents/, and cuts them into GIFs with ImageMagick.
import { exec, appHome } from "herdr";
import * as fs from "fs/promises";

export const DATA_REL = "data/pokemon-agents";
const DATA = `${appHome()}/${DATA_REL}`;
const PMD = "https://raw.githubusercontent.com/PMDCollab/SpriteCollab/master/sprite";
const ICONS = "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/versions/generation-vii/icons";
// Bump when the GIF recipe changes, so old caches are rebuilt.
const VERSION = 1;

// PMD sheets have one row per facing: 0 down, 1 down-right, 2 right, 3 up-right,
// 4 up, 5 up-left, 6 left, 7 down-left. Walk sideways, stand facing the viewer.
const CUTS = [
  ["walkR", "Walk", 2],
  ["walkL", "Walk", 6],
  ["idleR", "Idle", 1],
  ["idleL", "Idle", 7],
  ["sleep", "Sleep", 0],
];

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

// One facing of one animation as a looping GIF, pixel-doubled with nearest neighbour.
// Returns its size and the box its visible pixels fill (feet = box bottom).
async function cut(sheet, anim, row, scale, out) {
  const [w, h] = (await im("identify", ["-format", "%w %h", sheet])).split(" ").map(Number);
  const rows = Math.max(1, Math.floor(h / anim.fh));
  const cols = Math.max(1, Math.floor(w / anim.fw));
  const y = Math.min(row, rows - 1) * anim.fh;
  const n = Math.min(cols, anim.durations.length || cols);
  // Durations are game frames (1/60 s); GIF delays are 1/100 s.
  const cs = (anim.durations.length ? anim.durations : [10]).slice(0, n).map((d) => Math.max(2, Math.round((d * 100) / 60)));
  const delay = cs.slice(0, -1).map((c, i) => `t==${i}?${c}:`).join("") + cs[cs.length - 1];
  await im("convert", [
    sheet, "-crop", `${n * anim.fw}x${anim.fh}+0+${y}`, "+repage",
    "-crop", `${anim.fw}x${anim.fh}`, "+repage",
    "-scale", `${scale * 100}%`,
    "-set", "delay", `%[fx:${delay}]`, "-set", "dispose", "Background", "-loop", "0", out,
  ]);
  const box = await im("convert", [out, "-coalesce", "-background", "none", "-flatten", "-format", "%@", "info:"]);
  const m = box.match(/(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/);
  const fw = anim.fw * scale;
  const fh = anim.fh * scale;
  const bb = m ? { x: +m[3], y: +m[4], w: +m[1], h: +m[2] } : { x: 0, y: 0, w: fw, h: fh };
  return { w: fw, h: fh, box: bb };
}

// Builds (once) and returns the sprite set for a Pokémon: { walkR, walkL, idleR, idleL, sleep },
// each { path, w, h, box }. Cached on disk; meta.json is written last and marks it done.
export async function loadSprite(id) {
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
  await curl([[`${dir}/AnimData.xml`, `${base}/AnimData.xml`]]);
  const anims = parseAnims(await fs.readFile(`${dir}/AnimData.xml`, "utf8"));
  const walk = resolve(anims, "Walk");
  if (!walk) throw new Error("no walking animation");
  const pick = { Walk: walk, Idle: resolve(anims, "Idle") ?? walk };
  pick.Sleep = resolve(anims, "Sleep") ?? pick.Idle;
  const sheets = [...new Set(Object.values(pick).map((a) => a.name))];
  await curl(sheets.map((n) => [`${dir}/${n}.png`, `${base}/${n}-Anim.png`]));
  // Big Pokémon (Onix, Gyarados...) have big frames: draw those at 1x.
  const scale = walk.fh > 64 ? 1 : 2;
  const meta = { version: VERSION, id, scale };
  for (const [key, which, row] of CUTS) {
    const anim = pick[which];
    const file = `${key}.gif`;
    const size = await cut(`${dir}/${anim.name}.png`, anim, row, scale, `${dir}/${file}`);
    meta[key] = { path: `${DATA_REL}/sprites/${pad(id)}/${file}`, ...size };
  }
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
