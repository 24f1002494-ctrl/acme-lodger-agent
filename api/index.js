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
    const value = JSON.parse(s);
    if (Array.isArray(value)) rows.push(...value);
    else if (value && typeof value === "object") rows.push(value);
  }
  return rows;
}

async function fetchExport() {
  const r = await fetch(upstream("/export"), { cache: "no-store" });
  const text = await r.text();
  const ct = r.headers.get("content-type") || "";
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
  return currentRows(rows).map(r => ({
    raw: r,
    id: String(first(r, ["id", "order_id", "orderId"])),
    product: String(first(r, ["product", "product_name", "item_name", "item", "sku"])),
    customer: String(first(r, ["customer", "customer_name", "customer_id", "buyer", "email"])),
    region: String(first(r, ["region"])),
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

const MONTHS = {
  january: "01", february: "02", march: "03", april: "04", may: "05", june: "06",
  july: "07", august: "08", september: "09", october: "10", november: "11", december: "12",
  jan: "01", feb: "02", mar: "03", apr: "04", jun: "06", jul: "07", aug: "08", sep: "09", sept: "09", oct: "10", nov: "11", dec: "12"
};

function normText(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function formatDateKey(value) {
  const s = String(value || "");
  const m = s.match(/(20\d{2})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

function filtersFromQuestion(q, orders) {
  const nq = normText(q);
  const filters = [];
  const products = [...new Set(orders.map(o => o.product).filter(Boolean))].sort((a,b) => b.length-a.length);
  const customers = [...new Set(orders.map(o => o.customer).filter(Boolean))].sort((a,b) => b.length-a.length);
  const regions = [...new Set(orders.map(o => o.region).filter(Boolean))].sort((a,b) => b.length-a.length);

  const findValue = (values, type) => {
    for (const v of values) {
      const nv = normText(v);
      if (nv && (nq.includes(nv) || nq.includes(` ${nv} `))) return { type, value: v };
    }
    return null;
  };
  const pv = findValue(products, "product"); if (pv) filters.push(pv);
  const cv = findValue(customers, "customer"); if (cv) filters.push(cv);
  const rv = findValue(regions, "region"); if (rv) filters.push(rv);

  const exact = q.match(/\b(20\d{2})[-\/]([01]\d)[-\/]([0-3]\d)\b/);
  if (exact) filters.push({ type: "date", value: `${exact[1]}-${exact[2]}-${exact[3]}` });
  const month = q.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b\s*(20\d{2})?/i);
  if (month) filters.push({ type: "month", value: `${month[2] || new Date().getFullYear()}-${MONTHS[month[1].toLowerCase()]}` });
  return filters;
}

function applyFilters(orders, filters) {
  return orders.filter(o => filters.every(f => {
    if (f.type === "product") return normText(o.product) === normText(f.value);
    if (f.type === "customer") return normText(o.customer) === normText(f.value);
    if (f.type === "region") return normText(o.region) === normText(f.value);
    if (f.type === "date") return formatDateKey(o.date) === f.value;
    if (f.type === "month") return formatDateKey(o.date).startsWith(f.value);
    return true;
  }));
}

function groupSum(rows, key, amount = false) {
  const m = new Map();
  for (const r of rows) m.set(r[key], (m.get(r[key]) || 0) + (amount ? r.cents : r.quantity));
  return [...m.entries()].filter(([k]) => k).sort((a,b) => b[1] - a[1]);
}

function answerQuestion(question, data) {
  const q = question.toLowerCase();
  const orders = data.orders;
  const filters = filtersFromQuestion(question, orders);
  let scoped = applyFilters(orders, filters);

  const statusWord = q.match(/\b(paid|refunded|refund|void|cancelled|canceled)\b/);
  if (statusWord) {
    const s = statusWord[1];
    const wanted = s === "refund" ? "refunded" : s === "cancelled" || s === "canceled" ? "void" : s;
    scoped = scoped.filter(o => o.status === wanted);
  }

  const isCount = /\b(how many|number of|count of|count)\b/.test(q);
  const isQty = /\b(quantity|quantities|units|items|how much .*sold)\b/.test(q) && !/\bhow much (money|revenue|sales)\b/.test(q);
  const isAverage = /\b(average|avg|mean)\b/.test(q);
  const isTop = /\b(top|best|highest|largest|most|leading|biggest)\b/.test(q);
  const wantsProduct = /\b(product|products|item|items)\b/.test(q);
  const wantsCustomer = /\b(customer|customers|buyer|buyers)\b/.test(q);
  const wantsRegion = /\b(region|regions)\b/.test(q);
  const wantsRefund = /\brefund/.test(q);
  const wantsRevenue = /\b(revenue|sales|turnover|income)\b/.test(q);
  const wantsOrders = /\b(order|orders|order count|transactions|transactions)\b/.test(q);

  if (isTop && wantsProduct) {
    const base = scoped.filter(o => !statusWord || o.status === "paid");
    const by = /\b(quantity|units|sold)\b/.test(q) ? groupSum(base, "product", false) : groupSum(base, "product", true);
    return by.length ? String(by[0][0]) : "";
  }
  if (isTop && wantsCustomer) {
    const base = scoped.filter(o => !statusWord || o.status === "paid");
    const by = /\b(order|orders|count|number)\b/.test(q) && !wantsRevenue ? groupSum(base, "customer", false).map(([k]) => [k, base.filter(o => o.customer === k).length]) : groupSum(base, "customer", true);
    return by.length ? String(by[0][0]) : "";
  }
  if (isTop && wantsRegion) {
    const base = scoped.filter(o => !statusWord || o.status === "paid");
    const by = wantsRevenue ? groupSum(base, "region", true) : groupSum(base, "region", false);
    return by.length ? String(by[0][0]) : "";
  }

  if (wantsRefund) {
    const refunded = scoped.filter(o => o.status === "refunded");
    if (isCount || wantsOrders) return String(refunded.length);
    if (isAverage) return String(refunded.length ? Math.round(refunded.reduce((s,o) => s + o.cents, 0) / refunded.length) : 0);
    return String(refunded.reduce((s,o) => s + o.cents, 0));
  }

  if (wantsRevenue) {
    const paid = scoped.filter(o => o.status === "paid");
    if (isCount || wantsOrders) return String(paid.length);
    if (isAverage) return String(paid.length ? Math.round(paid.reduce((s,o) => s + o.cents, 0) / paid.length) : 0);
    return String(paid.reduce((s,o) => s + o.cents, 0));
  }

  if (isCount || wantsOrders) {
    if (wantsProduct || wantsCustomer || wantsRegion || statusWord || filters.length) return String(scoped.length);
    return String(scoped.length);
  }

  if (isQty || /\bhow many (units|items)\b/.test(q)) return String(scoped.reduce((s,o) => s + o.quantity, 0));

  if (wantsProduct) {
    if (wantsRevenue) return String(scoped.filter(o => o.status === "paid").reduce((s,o) => s + o.cents, 0));
    return String(scoped.reduce((s,o) => s + o.quantity, 0));
  }
  if (wantsCustomer && (isAverage || /\bspend|spent|spending|purchase value\b/.test(q))) {
    const paid = scoped.filter(o => o.status === "paid");
    return String(isAverage ? (paid.length ? Math.round(paid.reduce((s,o) => s + o.cents, 0) / paid.length) : 0) : paid.reduce((s,o) => s + o.cents, 0));
  }

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
