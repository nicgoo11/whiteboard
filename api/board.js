// Shared board storage in Upstash Redis (no npm deps, no login).
//
//   POST /api/board
//     { b: boardId, since: seq, ops: [[id, json | null], ...], me: { id, name, color, x, y } }
//   → { seq, changes: [[id, object | null], ...], users: [{ id, name, color, x, y }, ...] }
//
// One atomic Lua script per request: write ops, update presence, read every change after `since`.
// Every object write bumps a per-board sequence number; the sorted set `chg` maps object id → seq of its
// last write, so a client only downloads objects that changed since its last poll. Deletions are stored
// as the value "null" (tombstone) so other clients learn about them.

const URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const TTL = 60 * 60 * 24 * 365; // boards expire one year after their last edit
const BOARD = /^[\w-]{1,40}$/;
const ID = /^[\w-]{1,64}$/;
const COLOR = /^#[0-9a-fA-F]{3,8}$/;
const MAX_OPS = 500;
const MAX_VALUE = 300000;

// KEYS: objs (hash), chg (zset), seq (string), pres (hash)
// ARGV: since, now, meId, meJson, nOps, ttl, id1, val1, id2, val2, ...
const SCRIPT = `
local since = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local n = tonumber(ARGV[5])
local ttl = tonumber(ARGV[6])
for i = 0, n - 1 do
  local id = ARGV[7 + i * 2]
  local s = redis.call('INCR', KEYS[3])
  redis.call('HSET', KEYS[1], id, ARGV[8 + i * 2])
  redis.call('ZADD', KEYS[2], s, id)
end
if n > 0 then
  redis.call('EXPIRE', KEYS[1], ttl)
  redis.call('EXPIRE', KEYS[2], ttl)
  redis.call('EXPIRE', KEYS[3], ttl)
end
if ARGV[3] ~= '' then
  redis.call('HSET', KEYS[4], ARGV[3], ARGV[2] .. '|' .. ARGV[4])
  redis.call('EXPIRE', KEYS[4], 120)
end
local seq = tonumber(redis.call('GET', KEYS[3]) or '0')
local ids, vals = {}, {}
if since < seq then
  ids = redis.call('ZRANGEBYSCORE', KEYS[2], '(' .. ARGV[1], '+inf')
  local i = 1
  while i <= #ids do
    local chunk = {}
    for j = i, math.min(i + 199, #ids) do chunk[#chunk + 1] = ids[j] end
    local v = redis.call('HMGET', KEYS[1], unpack(chunk))
    for j = 1, #chunk do vals[#vals + 1] = v[j] end
    i = i + 200
  end
end
local users = {}
local pres = redis.call('HGETALL', KEYS[4])
for k = 1, #pres, 2 do
  local val = pres[k + 1]
  local sep = string.find(val, '|', 1, true)
  local t = sep and tonumber(string.sub(val, 1, sep - 1))
  if t and now - t < 20000 then
    users[#users + 1] = string.sub(val, sep + 1)
  else
    redis.call('HDEL', KEYS[4], pres[k])
  end
end
return {seq, ids, vals, users}
`;

async function redis(commands) {
  const res = await fetch(`${URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error(`Redis ${res.status}: ${await res.text()}`);
  const out = await res.json();
  const failed = out.find((r) => r.error);
  if (failed) throw new Error(`Redis: ${failed.error}`);
  return out.map((r) => r.result);
}

function cleanOps(list) {
  const flat = [];
  for (const op of Array.isArray(list) ? list.slice(0, MAX_OPS) : []) {
    if (!Array.isArray(op) || typeof op[0] !== "string" || !ID.test(op[0])) continue;
    let val = "null";
    if (op[1] != null) {
      if (typeof op[1] !== "string" || op[1].length > MAX_VALUE) continue;
      try {
        const o = JSON.parse(op[1]);
        if (!o || typeof o !== "object" || o.id !== op[0] || typeof o.type !== "string") continue;
      } catch {
        continue;
      }
      val = op[1];
    }
    flat.push(op[0], val);
  }
  return flat;
}

function cleanMe(me) {
  if (!me || typeof me.id !== "string" || !ID.test(me.id)) return ["", ""];
  const num = (v) => (Number.isFinite(v) ? Math.round(v) : null);
  return [
    me.id,
    JSON.stringify({
      id: me.id,
      name: String(me.name || "Guest").slice(0, 40),
      color: COLOR.test(me.color) ? me.color : "#888888",
      x: num(me.x),
      y: num(me.y),
    }),
  ];
}

const parse = (s) => {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
};

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }
  if (!URL || !TOKEN) return res.status(503).json({ error: "No database connected" });

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }
  const b = String(body.b || "");
  if (!BOARD.test(b)) return res.status(400).json({ error: "Invalid board id" });
  const since = Math.max(0, Math.floor(Number(body.since) || 0));
  const ops = cleanOps(body.ops);
  const [meId, meVal] = cleanMe(body.me);
  const p = `wb:${b}:`;

  try {
    const [r] = await redis([
      ["EVAL", SCRIPT, "4", p + "objs", p + "chg", p + "seq", p + "pres",
        String(since), String(Date.now()), meId, meVal, String(ops.length / 2), String(TTL), ...ops],
    ]);
    const [seq, ids, vals, users] = r;
    return res.status(200).json({
      seq: Number(seq) || 0,
      changes: (ids || []).map((id, i) => [id, parse(vals[i])]),
      users: (users || []).map(parse).filter(Boolean),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
