// Convert between this mod's hosts and a LiteTerm hosts file
// ({ app: "liteterm", version: 1, exportedAt, groups: [{ name }], hosts: [...] }).
// Pure functions, no herdr imports.
//
// A host here: { label, host, user, port, group, identity, alias?, password?, authMethod?, os? }
// A LiteTerm host: { address, username, port (number), group, label, authMethod: "password" | "key",
//                    password?, keyPath?, os? }

export function fromLiteTerm(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("That file isn't valid JSON."); }
  if (!data || data.app !== "liteterm" || !Array.isArray(data.hosts)) throw new Error("That isn't a LiteTerm hosts file.");
  return data.hosts
    .filter((h) => h && (h.address || "").toString().trim())
    .map((h) => {
      const e = {
        label: String(h.label ?? h.address).trim(),
        host: String(h.address).trim(),
        user: String(h.username ?? "").trim(),
        port: h.port == null || h.port === "" ? "" : String(h.port),
        group: String(h.group ?? "").trim(),
        identity: String(h.keyPath ?? "").trim(),
      };
      if (h.authMethod) e.authMethod = h.authMethod;
      if (h.password) e.password = h.password;
      if (h.os) e.os = h.os;
      return e;
    });
}

// Same machine and same name: used to skip what is already saved.
const sameHost = (a, b) =>
  (a.label ?? "") === (b.label ?? "") && (a.host || a.alias || "") === (b.host || b.alias || "") &&
  (a.user ?? "") === (b.user ?? "") && String(a.port || "22") === String(b.port || "22");

export function mergeHosts(existing, incoming) {
  const added = [];
  let skipped = 0;
  for (const h of incoming) {
    if (existing.some((x) => sameHost(x, h)) || added.some((x) => sameHost(x, h))) skipped++;
    else added.push(h);
  }
  return { added, skipped };
}

export function toLiteTerm(hosts, now = Date.now()) {
  const byLabel = (a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" });
  const out = hosts
    .map((h) => {
      const r = {
        address: h.host || h.alias,
        authMethod: h.authMethod || (h.identity ? "key" : "password"),
        group: h.group || "Ungrouped",
        label: h.label || h.host || h.alias,
        port: /^\d+$/.test(h.port ?? "") ? Number(h.port) : 22,
        username: h.user ?? "",
      };
      if (h.password) r.password = h.password;
      if (h.identity) r.keyPath = h.identity;
      if (h.os) r.os = h.os;
      return Object.fromEntries(Object.entries(r).sort(([a], [b]) => (a < b ? -1 : 1)));
    })
    .sort(byLabel);
  const groups = [...new Set(out.map((h) => h.group))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" })).map((name) => ({ name }));
  return JSON.stringify({ app: "liteterm", exportedAt: now, groups, hosts: out, version: 1 }, null, 2);
}
