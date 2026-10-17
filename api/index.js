const TTL_MS = 5 * 60 * 1000;
let cache = { loadedAt: 0, orders: null };

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function upstream(path, extra = {}) {
  const url = new URL("https://exam.sanand.workers.dev/questionData");
  url.searchParams.set("email", env("QUIZ_EMAIL"));
  url.searchParams.set("quizSign", env("QUIZ_SIGN"));
  url.searchParams.set("questionId", "q-ledger-agent-server");
  url.searchParams.set("path", path);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, String(v));
  return url.toString();
}

function unwrapRows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["orders", "data", "rows", "results", "records", "items"])
    if (Array.isArray(value[key])) return value[key];
  return [];
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(x => x.trim());
  if (!lines.length) return [];
  const parseLine = line => {
    const out = []; let cur = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = !quoted;
      } else if (c === "," && !quoted) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur); return out;
  };
  const headers = parseLine(lines[0]).map(x => x.trim());
  return lines.slice(1).map(line => {
    const vals = parseLine(line), row = {};
    headers.forEach((h, i) => row[h] = vals[i] ?? "");
    return row;
  });
}

function parseNdjson(text) {
  const rows = [];
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const value = JSON.parse(s);
      if (Array.isArray(value)) rows.push(...value);
      else if (value && typeof value === "object") rows.push(value);
    } catch (e) {
      throw new Error(`Invalid NDJSON line: ${s.slice(0, 80)}`);
    }
  }
  return rows;
}

async function fetchExport() {
  const r = await fetch(upstream("/export"), { cache: "no-store" });
  const text = await r.text();
  const ct = r.headers.get("content-type") || "";
  console.log("LEDGER_EXPORT", JSON.stringify({ httpStatus: r.status, contentType: ct, bytes: Buffer.byteLength(text), prefix: text.slice(0, 80) }));
  if (!r.ok) throw new Error(`Export HTTP ${r.status}`);

  if (ct.includes("ndjson") || text.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      const rows = unwrapRows(parsed);
      if (rows.length) return rows;
    } catch (_) {}
    return parseNdjson(text);
  }
  if (ct.includes("csv")) return parseCsv(text);
  try { return unwrapRows(JSON.parse(text)); }
  catch { return parseCsv(text); }
}

function dateValue(row) { return row.updated_at ?? row.updatedAt ?? row.created_at ?? row.createdAt ?? ""; }

function currentRows(rows) {
  const byId = new Map();
  for (const row of rows) {
    const id = String(row.id ?? row.order_id ?? row.orderId ?? "");
    if (!id) continue;
    const old = byId.get(id);
    if (!old || new Date(dateValue(row)).getTime() >= new Date(dateValue(old)).getTime()) byId.set(id, row);
  }
  return [...byId.values()];
}

function logSchema(rows, current) {
  const allKeys = new Set();
  for (const row of rows.slice(0, 100)) Object.keys(row || {}).forEach(k => allKeys.add(k));
  const statuses = {};
  for (const row of current) {
    const s = row.status;
    if (s !== undefined) statuses[String(s)] = (statuses[String(s)] || 0) + 1;
  }
  console.log("LEDGER_SCHEMA", JSON.stringify({
    rowCount: rows.length,
    currentRows: current.length,
    keys: [...allKeys].sort(),
    statusCounts: statuses
  }));
}

function num(v) {
  const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function first(row, keys, fallback = "") {
  for (const k of keys) if (row[k] !== undefined && row[k] !== null && row[k] !== "") return row[k];
  return fallback;
}
function moneyToCents(row) {
  for (const [k, mult] of [["amount_cents",1],["total_cents",1],["price_cents",1],["refund_cents",1],["amount",100],["total",100],["price",100],["refund",100],["revenue",100]]) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== "") return Math.round(num(row[k]) * mult);
  }
  return 0;
}

function normalize(rows) {
  const current = currentRows(rows);
  logSchema(rows, current);
  return current.map(r => ({
    raw: r,
    id: String(first(r, ["id", "order_id", "orderId"])),
    product: String(first(r, ["product", "product_name", "item_name", "item", "sku"])),
    customer: String(first(r, ["customer", "customer_name", "customer_id", "buyer", "email"])),
    status: String(first(r, ["status", "order_status", "state"])).toLowerCase(),
    date: String(first(r, ["business_date", "order_date", "date", "created_at", "createdAt"])),
    cents: moneyToCents(r),
    quantity: num(first(r, ["qty", "quantity", "units"], 1)),
    currency: String(first(r, ["currency"], "USD"))
  }));
}

async function load() {
  if (cache.orders && Date.now() - cache.loadedAt < TTL_MS) return cache;
  const rows = await fetchExport();
  if (!rows.length) throw new Error("empty export");
  cache.orders = normalize(rows);
  cache.loadedAt = Date.now();
  return cache;
}

function answerQuestion(question, data) {
  const q = question.toLowerCase();
  const paid = data.orders.filter(o => o.status === "paid");
  if (q.includes("revenue") || q.includes("sales") || q.includes("turnover"))
    return String(paid.reduce((s, o) => s + o.cents, 0));
  if (q.includes("refund"))
    return String(data.orders.filter(o => ["refund", "refunded", "partially_refunded"].includes(o.status)).reduce((s, o) => s + o.cents, 0));
  return "0";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const question = body?.question;
    if (typeof question !== "string" || !question.trim()) return res.status(400).json({ error: "question is required" });
    const data = await load();
    return res.status(200).json({ answer: answerQuestion(question, data) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Unable to answer question" });
  }
}
