const TZ = "Asia/Kolkata";

let cache = {
  loadedAt: 0,
  orders: null,
  rates: null,
};

const TTL_MS = 5 * 60 * 1000;

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function upstream(path, extra = "") {
  const base = "https://exam.sanand.workers.dev/questionData";
  const qs = new URLSearchParams({
    email: env("QUIZ_EMAIL"),
    quizSign: env("QUIZ_SIGN"),
    questionId: "q-ledger-agent-server",
    path,
  });
  if (extra) {
    const more = new URLSearchParams(extra);
    for (const [k, v] of more) qs.set(k, v);
  }
  return `${base}?${qs.toString()}`;
}

async function fetchJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Upstream HTTP ${r.status}`);
  return r.json();
}

function unwrapRows(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  for (const key of ["orders", "data", "rows", "results", "records", "items"]) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function parseCsv(text) {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter(x => x.trim());
  if (!lines.length) return [];
  const parseLine = (line) => {
    const out = [];
    let cur = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = !quoted;
      } else if (c === "," && !quoted) {
        out.push(cur); cur = "";
      } else cur += c;
    }
    out.push(cur);
    return out;
  };
  const headers = parseLine(lines[0]).map(x => x.trim());
  return lines.slice(1).map(line => {
    const vals = parseLine(line);
    const row = {};
    headers.forEach((h, i) => row[h] = vals[i] ?? "");
    return row;
  });
}

async function fetchExport() {
  const url = upstream("/export");
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`Export HTTP ${r.status}`);
  const ct = r.headers.get("content-type") || "";
  const text = await r.text();

  if (ct.includes("csv") || (!ct.includes("json") && text.trim().startsWith("order"))) {
    return parseCsv(text);
  }
  try {
    return unwrapRows(JSON.parse(text));
  } catch {
    return parseCsv(text);
  }
}

async function fetchOrdersPaged() {
  const all = [];
  for (let page = 1; page <= 200; page++) {
    const value = await fetchJson(upstream("/orders", `page=${page}`));
    const rows = unwrapRows(value);
    if (!rows.length) break;
    all.push(...rows);
    if (rows.length < 100) break;
  }
  return all;
}

function dateValue(row) {
  return row.updated_at ?? row.updatedAt ?? row.created_at ?? row.createdAt ?? "";
}

function currentRows(rows) {
  const byId = new Map();
  for (const row of rows) {
    const id = String(row.order_id ?? row.orderId ?? row.id ?? "");
    if (!id) continue;
    const old = byId.get(id);
    if (!old || new Date(dateValue(row)).getTime() >= new Date(dateValue(old)).getTime()) {
      byId.set(id, row);
    }
  }
  return [...byId.values()];
}

function num(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function moneyToCents(row) {
  const candidates = [
    ["amount_cents", 1],
    ["total_cents", 1],
    ["price_cents", 1],
    ["refund_cents", 1],
    ["amount", 100],
    ["total", 100],
    ["price", 100],
    ["refund", 100],
    ["revenue", 100],
  ];
  for (const [k, mult] of candidates) {
    if (row[k] !== undefined && row[k] !== null && row[k] !== "") {
      return Math.round(num(row[k]) * mult);
    }
  }
  return 0;
}

function first(row, keys, fallback = "") {
  for (const k of keys) if (row[k] !== undefined && row[k] !== null && row[k] !== "") return row[k];
  return fallback;
}

function product(row) {
  return String(first(row, ["product_name","product","item_name","item","sku"], ""));
}

function customer(row) {
  return String(first(row, ["customer_name","customer","customer_id","buyer","email"], ""));
}

function status(row) {
  return String(first(row, ["status","order_status"], "")).toLowerCase();
}

function orderDate(row) {
  return first(row, ["business_date","order_date","date","created_at","createdAt"], "");
}

function normalize(rows) {
  return currentRows(rows).map(r => ({
    raw: r,
    id: String(first(r, ["order_id","orderId","id"], "")),
    product: product(r),
    customer: customer(r),
    status: status(r),
    date: orderDate(r),
    cents: moneyToCents(r),
    quantity: num(first(r, ["quantity","qty","units"], 1)),
  }));
}

async function load() {
  if (cache.orders && Date.now() - cache.loadedAt < TTL_MS) return cache;
  let rows;
  try {
    rows = await fetchExport();
    if (!rows.length) throw new Error("empty export");
  } catch {
    rows = await fetchOrdersPaged();
  }
  cache.orders = normalize(rows);
  cache.loadedAt = Date.now();
  return cache;
}

function centsString(cents) {
  return String(Math.round(cents));
}

function isPaid(o) {
  return o.status === "paid";
}

function isRefund(o) {
  return o.status === "refunded" || o.status === "refund" || o.status === "partially_refunded";
}

function words(q) {
  return q.toLowerCase().replace(/[?.,!;:()]/g, " ").split(/\s+/).filter(Boolean);
}

function includesAny(q, arr) {
  return arr.some(x => q.includes(x));
}

function parseDatePhrase(q) {
  const m = q.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  return m ? m[1] : null;
}

function filterByDate(rows, q) {
  const d = parseDatePhrase(q);
  if (!d) return rows;
  return rows.filter(o => String(o.date).slice(0, 10) === d);
}

function answerQuestion(question, data) {
  const q = question.trim().toLowerCase();
  const rows = filterByDate(data.orders, q);

  const paid = rows.filter(isPaid);
  const refunds = rows.filter(isRefund);

  // Product/customer names are matched against the actual API spelling.
  const namedProduct = data.orders
    .map(o => o.product)
    .filter(Boolean)
    .sort((a,b) => b.length - a.length)
    .find(p => q.includes(String(p).toLowerCase()));

  const namedCustomer = data.orders
    .map(o => o.customer)
    .filter(Boolean)
    .sort((a,b) => b.length - a.length)
    .find(c => q.includes(String(c).toLowerCase()));

  if (includesAny(q, ["refund", "refunded", "refunded amount"])) {
    const target = namedProduct
      ? refunds.filter(o => o.product.toLowerCase() === namedProduct.toLowerCase())
      : namedCustomer
        ? refunds.filter(o => o.customer.toLowerCase() === namedCustomer.toLowerCase())
        : refunds;
    const total = target.reduce((s,o) => s + o.cents, 0);
    if (includesAny(q, ["how many", "count", "number of"])) return String(target.length);
    return centsString(total);
  }

  if (includesAny(q, ["revenue", "sales", "turnover", "earned"])) {
    let target = paid;
    if (namedProduct) target = target.filter(o => o.product.toLowerCase() === namedProduct.toLowerCase());
    if (namedCustomer) target = target.filter(o => o.customer.toLowerCase() === namedCustomer.toLowerCase());
    return centsString(target.reduce((s,o) => s + o.cents, 0));
  }

  if (includesAny(q, ["how many orders", "number of orders", "order count", "orders"])) {
    let target = rows;
    if (namedProduct) target = target.filter(o => o.product.toLowerCase() === namedProduct.toLowerCase());
    if (namedCustomer) target = target.filter(o => o.customer.toLowerCase() === namedCustomer.toLowerCase());
    if (includesAny(q, ["paid", "revenue"])) target = target.filter(isPaid);
    if (includesAny(q, ["refund"])) target = target.filter(isRefund);
    return String(target.length);
  }

  if (includesAny(q, ["customer", "customers", "buyer", "bought by"])) {
    if (namedProduct) {
      const names = [...new Set(paid.filter(o => o.product.toLowerCase() === namedProduct.toLowerCase()).map(o => o.customer).filter(Boolean))];
      return names.join(", ");
    }
  }

  if (includesAny(q, ["product", "products", "item", "items"])) {
    if (namedCustomer) {
      const names = [...new Set(paid.filter(o => o.customer.toLowerCase() === namedCustomer.toLowerCase()).map(o => o.product).filter(Boolean))];
      return names.join(", ");
    }
  }

  if (includesAny(q, ["average", "avg", "mean"])) {
    if (includesAny(q, ["order", "revenue", "sales", "amount"])) {
      const target = paid;
      if (!target.length) return "0";
      return centsString(target.reduce((s,o) => s + o.cents, 0) / target.length);
    }
  }

  // Useful fallbacks for common ranking questions.
  if (includesAny(q, ["top", "highest", "most", "best"])) {
    const byProduct = new Map();
    for (const o of paid) byProduct.set(o.product, (byProduct.get(o.product) || 0) + o.cents);
    const ranked = [...byProduct.entries()].filter(([k]) => k).sort((a,b) => b[1] - a[1]);
    if (ranked.length) {
      if (q.includes("revenue") || q.includes("sales")) return `${ranked[0][0]}: ${centsString(ranked[0][1])}`;
      return ranked[0][0];
    }
  }

  return "Unable to determine the answer from the order ledger.";
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
    if (typeof question !== "string" || !question.trim()) {
      return res.status(400).json({ error: "question is required" });
    }

    const data = await load();
    const answer = answerQuestion(question, data);
    return res.status(200).json({ answer });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Unable to answer question" });
  }
}
