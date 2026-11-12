// Server for Render: serves the web app, receives PayPal webhooks, and exposes the engine + AI layer.
// No dependencies beyond Node 20+. Secrets come from environment variables, never from the repo.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { agency, lateDeposit } from './seed.js';
import { generatePlans, simulateRisk, toLlmInput } from './engine.js';
import { createLedger } from './ledger.js';
import { buildPrompt, validateExplanation, templateExplanation } from './explain.js';

const PORT = process.env.PORT || 3000;
const PAYPAL_BASE = process.env.PAYPAL_BASE || 'https://api-m.sandbox.paypal.com';
const { PAYPAL_CLIENT_ID: clientId, PAYPAL_SECRET: secret, WEBHOOK_ID: webhookId, GEMINI_API_KEY: geminiKey } = process.env;
const GEMINI_BASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com';
// Models are tried in order; free-tier models are sometimes overloaded (503) or rate limited (429).
const GEMINI_MODELS = (process.env.GEMINI_MODELS || 'gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-3.8-flash').split(',').map((s) => s.trim());

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', 'dist');

const events = []; // newest first, in memory (swap for SQLite later)
const newLedger = () => createLedger(agency.payments.map((p) => p.id), { expected: Object.fromEntries(agency.payments.map((p) => [p.id, p.amount])) });
let ledger = newLedger(); // payment states, dedupe and audit trail

/* ---------- PayPal webhook ---------- */

async function verifySignature(headers, event) {
  if (!clientId || !secret || !webhookId) return 'SKIPPED (set PAYPAL_CLIENT_ID, PAYPAL_SECRET, WEBHOOK_ID)';
  try {
    const tokRes = await fetch(PAYPAL_BASE + '/v1/oauth2/token', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    const { access_token } = await tokRes.json();
    const res = await fetch(PAYPAL_BASE + '/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        auth_algo: headers['paypal-auth-algo'],
        cert_url: headers['paypal-cert-url'],
        transmission_id: headers['paypal-transmission-id'],
        transmission_sig: headers['paypal-transmission-sig'],
        transmission_time: headers['paypal-transmission-time'],
        webhook_id: webhookId,
        webhook_event: event,
      }),
    });
    return (await res.json()).verification_status ?? 'UNKNOWN';
  } catch (e) {
    return 'ERROR ' + e.message;
  }
}

/* ---------- PayPal Orders: payment request for the late deposit ---------- */

async function paypalToken() {
  const res = await fetch(PAYPAL_BASE + '/v1/oauth2/token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('PayPal auth failed: HTTP ' + res.status);
  return (await res.json()).access_token;
}

function publicOrigin(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

// The amount and the payment id come from the server's own data, never from the browser.
export async function createPaymentRequest(origin, paymentId = lateDeposit.paymentId) {
  const payment = agency.payments.find((p) => p.id === paymentId);
  if (!payment) throw new Error('unknown payment');
  if (!clientId || !secret) throw new Error('PayPal keys are not set');
  const token = await paypalToken();
  const res = await fetch(PAYPAL_BASE + '/v2/checkout/orders', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'PayPal-Request-Id': `req-${paymentId}-${Date.now()}` },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{ custom_id: paymentId, description: payment.label ?? paymentId, amount: { currency_code: 'USD', value: payment.amount.toFixed(2) } }],
      payment_source: { paypal: { experience_context: { shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW', return_url: origin + '/paypal/return', cancel_url: origin + '/?cancelled=1' } } },
    }),
  });
  const order = await res.json();
  if (!res.ok) throw new Error('PayPal order failed: ' + JSON.stringify(order).slice(0, 300));
  const link = order.links.find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  return { orderId: order.id, approveUrl: link.href };
}

async function captureOrder(orderId) {
  const token = await paypalToken();
  const res = await fetch(`${PAYPAL_BASE}/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  return { ok: res.ok, status: res.status };
}

/* ---------- AI explanation: Gemini with fallback, validated against the engine's numbers ---------- */

const explainCache = new Map();

async function askGemini(prompt, { timeoutMs = 12000 } = {}) {
  const failures = [];
  for (const model of GEMINI_MODELS) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${GEMINI_BASE}/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.3 },
        }),
      });
      if (!res.ok) { failures.push(`${model}: HTTP ${res.status}`); continue; } // overloaded or limited: next model
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      return { model, out: JSON.parse(text), failures };
    } catch (e) {
      failures.push(`${model}: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  const err = new Error('all models failed');
  err.failures = failures;
  throw err;
}

export async function explain(input) {
  const key = JSON.stringify(input);
  if (explainCache.has(key)) return { ...explainCache.get(key), cached: true };
  let result;
  if (!geminiKey) {
    result = { ...templateExplanation(input), reason: 'GEMINI_API_KEY is not set' };
  } else {
    const prompt = buildPrompt(input);
    const log = [];
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      try {
        const { model, out, failures } = await askGemini(prompt);
        log.push(...failures);
        const problems = validateExplanation(out, input);
        if (problems.length === 0) result = { ...out, source: 'gemini', model };
        else log.push(`${model}: rejected (${problems.join('; ')})`); // the model invented a number: ask again
      } catch (e) {
        log.push(...(e.failures ?? [e.message]));
      }
    }
    if (!result) result = { ...templateExplanation(input), reason: log.join(' | ') };
  }
  if (explainCache.size > 200) explainCache.clear();
  explainCache.set(key, result);
  return result;
}

/* ---------- HTTP ---------- */

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json' };

function send(res, status, body, headers = {}) {
  const isText = typeof body === 'string';
  res.writeHead(status, { 'Content-Type': isText ? 'text/plain' : 'application/json', 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(isText ? body : JSON.stringify(body, null, 2));
}

function readBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > limit) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

async function serveStatic(res, pathname) {
  const clean = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(DIST, clean === '/' || clean === '\\' ? 'index.html' : clean);
  if (!file.startsWith(DIST)) return send(res, 403, 'forbidden');
  if (!existsSync(file)) return send(res, 404, 'not found');
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=3600' });
    res.end(buf);
  } catch {
    send(res, 404, 'not found');
  }
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, time: new Date().toISOString(), ai: geminiKey ? 'gemini' : 'template-only' });

  if (req.method === 'GET' && url.pathname === '/api/plans') {
    const plans = generatePlans(agency, lateDeposit);
    const risk = simulateRisk(plans, agency, { runs: 2000, seed: 7 });
    const light = Object.fromEntries(Object.entries(plans).map(([k, p]) => [k, { ...p, data: undefined }]));
    return send(res, 200, { event: lateDeposit, plans: light, risk, llmInput: toLlmInput(agency, lateDeposit, plans, risk) });
  }

  if (req.method === 'POST' && url.pathname === '/api/explain') {
    try {
      const input = JSON.parse(await readBody(req, 200000));
      if (!input?.plans || !input?.facts) return send(res, 400, 'expected {facts, plans}');
      return send(res, 200, await explain(input));
    } catch (e) {
      return send(res, 400, 'bad request: ' + e.message);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/payment-request') {
    try { const r = await createPaymentRequest(publicOrigin(req)); ledger.requested(lateDeposit.paymentId, r.orderId); return send(res, 200, r); }
    catch (e) { return send(res, 502, e.message); }
  }

  // PayPal sends the buyer back here after approval; capturing the order is what actually moves the money.
  // The browser is only told "paid" later, by the signed webhook.
  if (req.method === 'GET' && url.pathname === '/paypal/return') {
    const orderId = url.searchParams.get('token');
    let ok = false;
    try { if (orderId) ok = (await captureOrder(orderId)).ok; } catch { /* shown as failure below */ }
    res.writeHead(302, { Location: ok ? '/?paid=pending' : '/?paid=failed' });
    return res.end();
  }

  if (req.method === 'POST' && url.pathname === '/api/reset') { // demo only: start the story again
    ledger = newLedger();
    events.length = 0;
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/state') return send(res, 200, { payments: ledger.state(), audit: ledger.audit() });

  if (req.method === 'POST' && url.pathname === '/api/decision') {
    try {
      const { kind, detail } = JSON.parse(await readBody(req, 5000));
      if (!['plan_approved', 'plan_rejected', 'message_copied'].includes(kind)) return send(res, 400, 'unknown decision');
      ledger.decision(kind, String(detail ?? '').slice(0, 200));
      return send(res, 200, { ok: true });
    } catch { return send(res, 400, 'bad request'); }
  }

  if (req.method === 'GET' && url.pathname === '/api/events') return send(res, 200, events);

  if (req.method === 'POST' && url.pathname === '/webhook') {
    let event;
    try { event = JSON.parse(await readBody(req)); } catch { return send(res, 400, 'bad json'); }
    if (ledger.audit().some((a) => a.eventId && a.eventId === event.id)) return send(res, 200, 'duplicate ignored');
    const signature = await verifySignature(req.headers, event);
    const result = ledger.receive(event, signature);
    if (result.outcome !== 'duplicate') {
      const record = {
        receivedAt: new Date().toISOString(),
        id: event.id,
        type: event.event_type,
        custom_id: event.resource?.custom_id ?? null,
        amount: event.resource?.amount?.value ?? null,
        signature,
        outcome: result.outcome,
      };
      events.unshift(record);
      if (events.length > 100) events.pop();
      console.log('webhook', JSON.stringify(record));
    }
    return send(res, result.status, result.outcome);
  }

  if (req.method === 'GET') return serveStatic(res, url.pathname);
  send(res, 404, 'not found');
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log('listening on port ' + PORT));
}
