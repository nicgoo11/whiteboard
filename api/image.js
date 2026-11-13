// Image storage for the whiteboard (Upstash Redis, no npm deps).
//
//   POST /api/image  { id, data: "data:image/webp;base64,..." }  → { ok: true }
//   GET  /api/image?id=<id>                                     → the image bytes (cached for a year)
//
// Images are resized in the browser before upload. Keys are global (wb:img:<id>) so copy/paste between
// boards keeps working. An id can only be written once, so nobody can overwrite someone else's picture.

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const TTL = 60 * 60 * 24 * 365;
const ID = /^[\w-]{1,64}$/;
const DATA = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+=*)$/;
const MAX = 1500000;

async function redis(commands) {
  const res = await fetch(`${REDIS_URL}/pipeline`, {
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

export default async function handler(req, res) {
  if (!REDIS_URL || !TOKEN) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ error: "No database connected" });
  }
  try {
    if (req.method === "GET") {
      const id = String((req.query && req.query.id) || "");
      if (!ID.test(id)) return res.status(400).json({ error: "Invalid id" });
      const [data] = await redis([["GET", "wb:img:" + id], ["EXPIRE", "wb:img:" + id, String(TTL)]]);
      const m = typeof data === "string" && DATA.exec(data);
      if (!m) {
        res.setHeader("Cache-Control", "no-store");
        return res.status(404).json({ error: "Not found" });
      }
      res.setHeader("Content-Type", m[1]);
      res.setHeader("Cache-Control", "public, max-age=31536000, s-maxage=31536000, immutable");
      res.setHeader("X-Content-Type-Options", "nosniff");
      return res.status(200).send(Buffer.from(m[2], "base64"));
    }
    if (req.method === "POST") {
      res.setHeader("Cache-Control", "no-store");
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const id = String(body.id || ""), data = body.data;
      if (!ID.test(id)) return res.status(400).json({ error: "Invalid id" });
      if (typeof data !== "string" || data.length > MAX) return res.status(413).json({ error: "Image too large" });
      if (!DATA.test(data)) return res.status(400).json({ error: "Only PNG, JPEG, WebP or GIF images" });
      const [ok] = await redis([["SET", "wb:img:" + id, data, "EX", String(TTL), "NX"]]);
      if (!ok) return res.status(409).json({ error: "Id already used" });
      return res.status(200).json({ ok: true });
    }
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "GET or POST only" });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
