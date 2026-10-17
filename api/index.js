const TTL = 300000;
let cache = { at: 0, orders: null };

const env = k => {
  if (!process.env[k]) throw Error(`Missing environment variable: ${k}`);
  return process.env[k];
};

const upstream = path => {
  const u = new URL('https://exam.sanand.workers.dev/questionData');
  u.searchParams.set('email', env('QUIZ_EMAIL'));
  u.searchParams.set('quizSign', env('QUIZ_SIGN'));
  u.searchParams.set('questionId', 'q-ledger-agent-server');
  u.searchParams.set('path', path);
  return u;
};

const num = v => {
  const n = Number(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

const money = v => Number(v).toFixed(2);
const norm = s => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// The ledger schema supplies amount directly in USD. No cents conversion is performed.
// The ledger schema supplies qty directly as the order quantity.
function businessDate(v) {
  if (!v) return '';
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(d);
}

async function load() {
  if (cache.orders && Date.now() - cache.at < TTL) return cache.orders;

  const response = await fetch(upstream('/export'), { cache: 'no-store' });
  const text = await response.text();
  if (!response.ok) throw Error(`Export HTTP ${response.status}`);

  let raw;
  try {
    const parsed = JSON.parse(text);
    raw = Array.isArray(parsed) ? parsed : (parsed.orders || parsed.data || parsed.rows || parsed.results || parsed.records || parsed.items || []);
  } catch {
    raw = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  }

  // API schema: id, customer, region, product, qty, status, amount,
  // currency, created_at, updated_at. An order id can occur more than once;
  // the row with the latest updated_at is current.
  const current = new Map();
  for (const row of raw) {
    const id = String(row.id ?? '');
    if (!id) continue;
    const previous = current.get(id);
    if (!previous || new Date(row.updated_at).getTime() >= new Date(previous.updated_at).getTime()) {
      current.set(id, row);
    }
  }

  cache = {
    orders: [...current.values()].map(row => ({
      id: String(row.id),
      customer: String(row.customer ?? ''),
      region: String(row.region ?? ''),
      product: String(row.product ?? ''),
      qty: num(row.qty),
      status: String(row.status ?? '').toLowerCase(),
      amount: num(row.amount),
      currency: String(row.currency ?? ''),
      created_at: String(row.created_at ?? ''),
      updated_at: String(row.updated_at ?? ''),
      date: businessDate(row.created_at)
    })),
    at: Date.now()
  };
  return cache.orders;
}

const MONTHS = {
  january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
  july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  jan: '01', feb: '02', mar: '03', apr: '04', jun: '06', jul: '07', aug: '08',
  sep: '09', sept: '09', oct: '10', nov: '11', dec: '12'
};

function findValue(question, values) {
  const q = norm(question);
  const unique = [...new Set(values.filter(Boolean))].sort((a, b) => norm(b).length - norm(a).length);
  return unique.find(v => {
    const n = norm(v);
    return n && (` ${q} `).includes(` ${n} `);
  }) || null;
}

function filters(question, orders) {
  const q = question;
  const fs = [];

  // These are direct JSON fields. Do not infer region from anything other than region.
  const region = findValue(q, orders.map(o => o.region));
  const product = findValue(q, orders.map(o => o.product));
  const customer = findValue(q, orders.map(o => o.customer));
  if (region) fs.push({ type: 'region', value: region });
  if (product) fs.push({ type: 'product', value: product });
  if (customer) fs.push({ type: 'customer', value: customer });

  const exact = q.match(/\b(20\d{2})[-\/]([01]\d)[-\/]([0-3]\d)\b/);
  if (exact) fs.push({ type: 'date', value: `${exact[1]}-${exact[2]}-${exact[3]}` });

  const month = q.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b\s*(20\d{2})?/i);
  if (month) fs.push({ type: 'month', month: MONTHS[month[1].toLowerCase()], year: month[2] || null });

  // A bare year is a valid date constraint too.
  if (!month && !exact) {
    const year = q.match(/\b(20\d{2})\b/);
    if (year) fs.push({ type: 'year', year: year[1] });
  }

  return fs;
}

function applyFilters(orders, fs) {
  return orders.filter(o => fs.every(f => {
    if (f.type === 'region') return norm(o.region) === norm(f.value);
    if (f.type === 'product') return norm(o.product) === norm(f.value);
    if (f.type === 'customer') return norm(o.customer) === norm(f.value);
    if (f.type === 'date') return o.date === f.value;
    if (f.type === 'month') return o.date.slice(5, 7) === f.month && (!f.year || o.date.slice(0, 4) === f.year);
    if (f.type === 'year') return o.date.slice(0, 4) === f.year;
    return true;
  }));
}

function statusFiltered(orders, question) {
  const q = norm(question);
  if (/(^| )paid( |$)/.test(q)) return orders.filter(o => o.status === 'paid');
  if (/(^| )refunded?( |$)/.test(q) || q.includes('refunds')) return orders.filter(o => o.status === 'refunded');
  if (/(^| )(void|cancelled|canceled)( |$)/.test(q)) return orders.filter(o => o.status === 'void');
  return orders;
}

function hasAny(q, words) {
  const n = norm(q);
  return words.some(w => n.includes(w));
}

function uniqueCount(rows, field) {
  return new Set(rows.map(r => r[field]).filter(Boolean)).size;
}

function sum(rows, field) {
  return rows.reduce((s, r) => s + r[field], 0);
}

function average(rows, field) {
  return rows.length ? sum(rows, field) / rows.length : 0;
}

function groupBest(rows, field, metric) {
  const groups = new Map();
  for (const row of rows) {
    const key = row[field];
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  let best = null;
  for (const [key, group] of groups) {
    let value;
    if (metric === 'count') value = group.length;
    else if (metric === 'quantity') value = sum(group, 'qty');
    else if (metric === 'average') value = average(group, 'amount');
    else value = sum(group, 'amount');
    if (!best || value > best.value) best = { key, value };
  }
  return best?.key || '';
}

function answer(question, orders) {
  const q = norm(question);
  let rows = applyFilters(orders, filters(question, orders));
  rows = statusFiltered(rows, question);

  const count = /(^| )(how many|number of|count)( |$)/.test(q);
  const distinct = hasAny(q, ['distinct', 'unique', 'different']);
  const avgQ = hasAny(q, ['average', 'avg', 'mean']);
  const top = hasAny(q, ['top', 'best', 'highest', 'largest', 'most', 'leading', 'biggest']);
  const revenue = hasAny(q, ['revenue', 'turnover', 'income', 'sales value', 'sales amount', 'earned']);
  const orderValue = hasAny(q, ['order value', 'order amount', 'worth']);
  const order = /(^| )(order|orders|transaction|transactions)( |$)/.test(q);
  const customer = /(^| )(customer|customers|buyer|buyers)( |$)/.test(q);
  const product = /(^| )(product|products|item|items)( |$)/.test(q);
  const region = /(^| )(region|regions)( |$)/.test(q);
  const quantity = hasAny(q, ['quantity', 'quantities', 'units', 'items sold', 'units sold']);
  const spend = hasAny(q, ['spend', 'spent', 'spending', 'purchase value', 'customer value', 'customer spend']);
  const refunded = rows.every(r => r.status === 'refunded') && rows.length > 0 && hasAny(q, ['refunded', 'refund', 'refunds']);

  // Ranking questions: the subject and requested metric determine the aggregation.
  if (top && product) {
    const metric = quantity ? 'quantity' : order ? 'count' : avgQ ? 'average' : 'amount';
    return groupBest(rows, 'product', metric);
  }
  if (top && customer) {
    const metric = quantity ? 'quantity' : order && !revenue && !spend && !avgQ ? 'count' : avgQ ? 'average' : 'amount';
    return groupBest(rows, 'customer', metric);
  }
  if (top && region) {
    const metric = quantity ? 'quantity' : order && !revenue && !avgQ ? 'count' : avgQ ? 'average' : 'amount';
    return groupBest(rows, 'region', metric);
  }

  // Distinct entity counts must be evaluated before ordinary order counts.
  if (count && distinct && customer) return String(uniqueCount(rows, 'customer'));
  if (count && distinct && product) return String(uniqueCount(rows, 'product'));
  if (count && distinct && region) return String(uniqueCount(rows, 'region'));
  if (count && distinct) return String(uniqueCount(rows, customer ? 'customer' : product ? 'product' : 'region'));

  // Average customer spend = paid amount divided by distinct paid customers.
  if (avgQ && customer && spend) {
    const paid = rows.filter(r => r.status === 'paid');
    const customers = uniqueCount(paid, 'customer');
    return money(customers ? sum(paid, 'amount') / customers : 0);
  }

  // Average order value uses the rows selected by the question. If the question
  // says paid/refunded/void, statusFiltered() has already applied that status.
  if (avgQ && (order || orderValue || revenue || hasAny(q, ['worth']))) {
    return money(average(rows, 'amount'));
  }

  if (quantity) return String(sum(rows, 'qty'));

  // Revenue means paid-order amount only. Status-specific questions are handled
  // above by statusFiltered(), so refunded/void questions do not become revenue.
  if (revenue) {
    const paid = rows.filter(r => r.status === 'paid');
    return money(sum(paid, 'amount'));
  }

  if (hasAny(q, ['refund', 'refunded', 'refunds'])) {
    const refunds = rows.filter(r => r.status === 'refunded');
    if (avgQ) return money(average(refunds, 'amount'));
    if (count || order) return String(refunds.length);
    return money(sum(refunds, 'amount'));
  }

  if (count || order) return String(rows.length);

  if (customer && spend) {
    return money(sum(rows.filter(r => r.status === 'paid'), 'amount'));
  }

  if (product && hasAny(q, ['sold', 'sales'])) {
    return String(sum(rows.filter(r => r.status === 'paid'), 'qty'));
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
    return res.status(200).json({ answer: answer(body.question, await load()) });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
