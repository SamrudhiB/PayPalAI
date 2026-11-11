// Minimal server for Render: health check, PayPal webhook receiver, and the engine's plans as JSON.
// No dependencies (Node 20+). Secrets come from environment variables, never from the repo.
import http from 'node:http';
import { agency, lateDeposit } from './seed.js';
import { generatePlans, simulateRisk, toLlmInput } from './engine.js';

const PORT = process.env.PORT || 3000;
const PAYPAL_BASE = process.env.PAYPAL_BASE || 'https://api-m.sandbox.paypal.com';
const { PAYPAL_CLIENT_ID: clientId, PAYPAL_SECRET: secret, WEBHOOK_ID: webhookId } = process.env;

const events = []; // newest first, in memory (swap for SQLite later)
const seen = new Set(); // PayPal retries webhooks, so every event id is processed once

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

function send(res, status, body) {
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(text);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, time: new Date().toISOString() });

  if (req.method === 'GET' && url.pathname === '/api/plans') {
    const plans = generatePlans(agency, lateDeposit);
    const risk = simulateRisk(plans, agency, { runs: 2000, seed: 7 });
    const light = Object.fromEntries(Object.entries(plans).map(([k, p]) => [k, { ...p, data: undefined }]));
    return send(res, 200, { event: lateDeposit, plans: light, risk, llmInput: toLlmInput(agency, lateDeposit, plans, risk) });
  }

  if (req.method === 'GET' && url.pathname === '/api/events') return send(res, 200, events);

  if (req.method === 'POST' && url.pathname === '/webhook') {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', async () => {
      let event;
      try { event = JSON.parse(raw); } catch { return send(res, 400, 'bad json'); }
      if (event.id && seen.has(event.id)) return send(res, 200, 'duplicate ignored');
      if (event.id) seen.add(event.id);
      const signature = await verifySignature(req.headers, event);
      const record = {
        receivedAt: new Date().toISOString(),
        id: event.id,
        type: event.event_type,
        custom_id: event.resource?.custom_id ?? null,
        amount: event.resource?.amount?.value ?? null,
        signature,
      };
      events.unshift(record);
      if (events.length > 100) events.pop();
      console.log('webhook', JSON.stringify(record));
      send(res, 200, 'ok');
    });
    return;
  }

  send(res, 404, 'not found');
});

server.listen(PORT, () => console.log('listening on port ' + PORT));
