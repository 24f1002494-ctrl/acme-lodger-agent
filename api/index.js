const TTL_MS = 5 * 60 * 1000;
let cache = { loadedAt: 0, orders: null };

function env(name) {
  if (!process.env[name]) throw new Error(`Missing environment variable: ${name}`);
  return process.env[name];
}

function upstream(path) {
  const u = new URL('https://exam.sanand.workers.dev/questionData');
  u.searchParams.set('email', env('QUIZ_EMAIL'));
  u.searchParams.set('quizSign', env('QUIZ_SIGN'));
  u.searchParams.set('questionId', 'q-ledger-agent-server');
  u.searchParams.set('path', path);
  return u.toString();
}

function unwrap(value) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of ['orders', 'data', 'rows', 'results', 'records', 'items']) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function parseNdjson(text) {
  const out = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const value = JSON.parse(s);
    if (Array.isArray(value)) out.push(...value);
    else if (value && typeof value === 'object') out.push(value);
  }
  return out;
}

async function fetchExport() {
  const response = await fetch(upstream('/export'), { cache: 'no-store' });
  const text = await response.text();
  if (!response.ok) throw new Error(`Export HTTP ${response.status}`);

  try {
    const json = JSON.parse(text);
    const rows = unwrap(json);
    if (rows.length) return rows;
  } catch (_) {}

  return parseNdjson(text);
}

function latestPerOrder(rows) {
  const map = new Map();
  for (const row of rows) {
    const id = String(row.id ?? row.order_id ?? row.orderId ?? '');
    if (!id) continue;
    const updated = row.updated_at ?? row.updatedAt ?? row.created_at ?? row.createdAt ?? '';
    const previous = map.get(id);
    if (!previous || new Date(updated).getTime() >= new Date(previous._updated).getTime()) {
      map.set(id, { ...row, _updated: updated });
    }
  }
  return [...map.values()];
}

function numberValue(value) {
  const n = Number(String(value ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function first(row, keys, fallback = '') {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return row[key];
  }
  return fallback;
}

// The ledger's monetary numeric fields are represented in USD cents.
// Explicit *_cents fields are also accepted as-is.
function moneyCents(row) {
  for (const key of ['amount_cents', 'total_cents', 'price_cents', 'refund_cents', 'revenue_cents']) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return Math.round(numberValue(row[key]));
  }
  for (const key of ['amount', 'total', 'price', 'refund', 'revenue', 'unit_price']) {
    if (row[key] !== undefined && row[key] !== null && row[key] !== '') return Math.round(numberValue(row[key]));
  }
  return 0;
}

function businessDate(value) {
  const raw = String(value ?? '');
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (match && !raw.includes('T')) return match[1];
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(time));
}

function normalize(rows) {
  return latestPerOrder(rows).map(row => ({
    id: String(first(row, ['id', 'order_id', 'orderId'])),
    product: String(first(row, ['product', 'product_name', 'item_name', 'item', 'sku'])),
    customer: String(first(row, ['customer', 'customer_name', 'customer_id', 'buyer', 'email'])),
    region: String(first(row, ['region'])),
    status: String(first(row, ['status', 'order_status', 'state'])).toLowerCase(),
    date: businessDate(first(row, ['business_date', 'order_date', 'date', 'created_at', 'createdAt'])),
    cents: moneyCents(row),
    quantity: numberValue(first(row, ['qty', 'quantity', 'units'], 1)),
    currency: String(first(row, ['currency'], 'USD')).toUpperCase()
  }));
}

async function load() {
  if (cache.orders && Date.now() - cache.loadedAt < TTL_MS) return cache;
  const rows = await fetchExport();
  if (!rows.length) throw new Error('empty export');
  cache = { orders: normalize(rows), loadedAt: Date.now() };
  return cache;
}

const MONTHS = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04', jun: '06', jul: '07', aug: '08',
  sep: '09', sept: '09', oct: '10', nov: '11', dec: '12'
};

function norm(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function parseFilters(question, orders) {
  const nq = norm(question);
  const filters = [];

  for (const [type, values] of [
    ['product', [...new Set(orders.map(o => o.product).filter(Boolean))]],
    ['customer', [...new Set(orders.map(o => o.customer).filter(Boolean))]],
    ['region', [...new Set(orders.map(o => o.region).filter(Boolean))]]
  ]) {
    values.sort((a, b) => b.length - a.length);
    const found = values.find(value => nq.includes(norm(value)));
    if (found) filters.push({ type, value: found });
  }

  const exactDate = question.match(/\b(20\d{2})[-\/]([01]\d)[-\/]([0-3]\d)\b/);
  if (exactDate) filters.push({ type: 'date', value: `${exactDate[1]}-${exactDate[2]}-${exactDate[3]}` });

  const month = question.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b\s*(20\d{2})?/i);
  if (month) filters.push({
    type: 'month',
    month: MONTHS[month[1].toLowerCase()],
    year: month[2] || null
  });

  return filters;
}

function applyFilters(orders, filters) {
  return orders.filter(order => filters.every(filter => {
    if (filter.type === 'product') return norm(order.product) === norm(filter.value);
    if (filter.type === 'customer') return norm(order.customer) === norm(filter.value);
    if (filter.type === 'region') return norm(order.region) === norm(filter.value);
    if (filter.type === 'date') return order.date === filter.value;
    if (filter.type === 'month') {
      if (!order.date) return false;
      const monthMatches = order.date.slice(5, 7) === filter.month;
      return filter.year ? monthMatches && order.date.slice(0, 4) === filter.year : monthMatches;
    }
    return true;
  }));
}

function uniqueCount(rows, field) {
  return new Set(rows.map(row => row[field]).filter(Boolean)).size;
}

function sum(rows, selector) {
  return rows.reduce((total, row) => total + selector(row), 0);
}

function average(rows, selector) {
  return rows.length ? Math.round(sum(rows, selector) / rows.length) : 0;
}

function rank(rows, key, metric) {
  const totals = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!value) continue;
    totals.set(value, (totals.get(value) || 0) + metric(row));
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]);
}

function answer(question, data) {
  const q = question.toLowerCase();
  const orders = data.orders;
  let rows = applyFilters(orders, parseFilters(question, orders));

  const mentionsPaid = /\bpaid\b/.test(q);
  const mentionsRefund = /\brefund(?:ed|s)?\b/.test(q);
  const mentionsVoid = /\b(?:void|cancelled|canceled)\b/.test(q);

  if (mentionsPaid) rows = rows.filter(o => o.status === 'paid');
  else if (mentionsRefund) rows = rows.filter(o => o.status === 'refunded');
  else if (mentionsVoid) rows = rows.filter(o => o.status === 'void');

  const count = /\b(?:how many|number of|count(?: of)?)\b/.test(q);
  const distinct = /\b(?:distinct|unique|different)\b/.test(q);
  const avg = /\b(?:average|avg|mean)\b/.test(q);
  const top = /\b(?:top|best|highest|largest|most|leading|biggest)\b/.test(q);
  const revenue = /\b(?:revenue|sales|turnover|income|sales value|order value|order amount|sales amount)\b/.test(q);
  const refund = mentionsRefund || /\brefund amount|refund value|refund total\b/.test(q);
  const ordersQ = /\b(?:order|orders|transaction|transactions)\b/.test(q);
  const customer = /\b(?:customer|customers|buyer|buyers)\b/.test(q);
  const product = /\b(?:product|products|item|items)\b/.test(q);
  const region = /\b(?:region|regions)\b/.test(q);
  const quantity = /\b(?:quantity|quantities|units|items sold|units sold)\b/.test(q);
  const spend = /\b(?:spend|spent|spending|purchase value|customer value|customer spend)\b/.test(q);

  // Customer counts mean distinct customers unless the question explicitly asks for orders.
  if (count && customer && !ordersQ) return String(uniqueCount(rows, 'customer'));
  if (count && distinct && product) return String(uniqueCount(rows, 'product'));
  if (count && distinct && region) return String(uniqueCount(rows, 'region'));

  // Explicit order counts always count current rows after status/date/entity filters.
  if (count && ordersQ) return String(rows.length);

  // Average order value defaults to paid orders unless a different status was explicitly requested.
  if (avg && (revenue || /\b(?:order|orders)\b/.test(q) || /\bvalue\b/.test(q))) {
    const paidRows = mentionsPaid || (!mentionsRefund && !mentionsVoid)
      ? rows.filter(o => o.status === 'paid')
      : rows;
    return String(average(paidRows, o => o.cents));
  }

  // Average customer spend = total paid value divided by distinct customers, not average order value.
  if (avg && customer && spend) {
    const paidRows = rows.filter(o => o.status === 'paid');
    const customers = uniqueCount(paidRows, 'customer');
    return String(customers ? Math.round(sum(paidRows, o => o.cents) / customers) : 0);
  }

  // Refund questions operate on refunded current orders.
  if (refund) {
    const refunded = rows.filter(o => o.status === 'refunded');
    if (avg) return String(average(refunded, o => o.cents));
    if (count || ordersQ) return String(refunded.length);
    return String(sum(refunded, o => o.cents));
  }

  // Revenue/sales are paid-only by definition from the API notes.
  if (revenue) {
    const paidRows = rows.filter(o => o.status === 'paid');
    if (avg) return String(average(paidRows, o => o.cents));
    if (count || ordersQ) return String(paidRows.length);
    return String(sum(paidRows, o => o.cents));
  }

  if (top && product) {
    const base = rows.filter(o => o.status === 'paid');
    const byQuantity = quantity || /\b(?:units|items)\b/.test(q);
    const ranked = rank(base, 'product', byQuantity ? o => o.quantity : o => o.cents);
    return ranked.length ? String(ranked[0][0]) : '';
  }

  if (top && customer) {
    const base = rows.filter(o => o.status === 'paid');
    const bySpend = spend || revenue || /\b(?:highest spending|largest spender|most valuable)\b/.test(q);
    const ranked = rank(base, 'customer', bySpend ? o => o.cents : () => 1);
    return ranked.length ? String(ranked[0][0]) : '';
  }

  if (top && region) {
    const base = rows.filter(o => o.status === 'paid');
    const ranked = rank(base, 'region', quantity ? o => o.quantity : o => o.cents);
    return ranked.length ? String(ranked[0][0]) : '';
  }

  if (quantity || /\bhow many (?:units|items)\b/.test(q)) {
    return String(sum(rows, o => o.quantity));
  }

  if (count) return String(rows.length);

  // Customer spend/value questions return paid revenue for the matched customer.
  if (customer && spend) {
    return String(sum(rows.filter(o => o.status === 'paid'), o => o.cents));
  }

  // Product sales without a numeric qualifier mean units sold.
  if (product && /\b(?:sold|sales)\b/.test(q)) {
    return String(sum(rows.filter(o => o.status === 'paid'), o => o.quantity));
  }

  return '0';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (typeof body?.question !== 'string' || !body.question.trim()) {
      return res.status(400).json({ error: 'question is required' });
    }
    const data = await load();
    return res.status(200).json({ answer: answer(body.question, data) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Unable to answer question' });
  }
}
