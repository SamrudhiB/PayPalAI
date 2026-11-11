import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { agency, lateDeposit } from '../src/seed.js';
import { generatePlans, simulateRisk, toLlmInput } from '../src/engine.js';
import { validateExplanation, templateExplanation, buildPrompt } from '../src/explain.js';

const plans = generatePlans(agency, lateDeposit);
const risk = simulateRisk(plans, agency, { runs: 500, seed: 7 });
const input = toLlmInput(agency, lateDeposit, plans, risk);

const good = {
  recommended_plan: 'B',
  headline: 'Go with Plan B.',
  reasons: [`Plan B has the lowest chance of missing payroll at ${input.plans.B.chance_of_missing_payroll_pct}%.`, 'Plan A is worse on every measure.'],
  when_to_pick_another: 'Pick Plan C if the Acme deadline matters more than cash.',
  client_message: 'Hi Acme team, the $6,000 payment due on day 5 is now expected on day 15. Could you confirm the date? Thanks.',
};

test('validator accepts an answer that only uses engine numbers', () => {
  assert.deepEqual(validateExplanation(good, input), []);
});

test('validator rejects an invented number, a bad plan and missing keys', () => {
  assert.match(validateExplanation({ ...good, headline: 'Save $9,999 with Plan B.' }, input).join(), /number not in data: 9999/);
  assert.match(validateExplanation({ ...good, recommended_plan: 'Z' }, input).join(), /not one of the plans/);
  assert.match(validateExplanation({ headline: 'x' }, input).join(), /missing key/);
});

test('template answer always passes its own validator and picks Plan B', () => {
  const t = templateExplanation(input);
  assert.equal(t.recommended_plan, 'B');
  assert.deepEqual(validateExplanation(t, input), []);
});

test('prompt contains the data and the no-invented-numbers rule', () => {
  const p = buildPrompt(input);
  assert.match(p, /ONLY numbers that appear in the data/);
  assert.match(p, /chance_of_missing_payroll_pct/);
});

/* ---------- server: Gemini fallback chain against a mock Gemini ---------- */

let mock, calls, behave, explain;

before(async () => {
  calls = [];
  mock = http.createServer((req, res) => {
    const model = req.url.split('/models/')[1].split(':')[0];
    calls.push(model);
    const b = behave(model, calls.filter((m) => m === model).length);
    res.writeHead(b.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(b.status && b.status !== 200 ? { error: {} } : { candidates: [{ content: { parts: [{ text: JSON.stringify(b.body) }] } }] }));
  });
  await new Promise((r) => mock.listen(0, r));
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.GEMINI_BASE = `http://127.0.0.1:${mock.address().port}`;
  process.env.GEMINI_MODELS = 'm1,m2';
  ({ explain } = await import('../src/server.js'));
});
after(() => mock.close());

const fresh = (tag) => ({ ...input, facts: { ...input.facts, tag } }); // distinct cache key per test

test('server: first model answers', async () => {
  calls.length = 0; behave = () => ({ body: good });
  const r = await explain(fresh('t1'));
  assert.equal(r.source, 'gemini'); assert.equal(r.model, 'm1'); assert.deepEqual(calls, ['m1']);
});

test('server: overloaded first model (503) falls through to the second', async () => {
  calls.length = 0; behave = (m) => (m === 'm1' ? { status: 503 } : { body: good });
  const r = await explain(fresh('t2'));
  assert.equal(r.source, 'gemini'); assert.equal(r.model, 'm2'); assert.deepEqual(calls, ['m1', 'm2']);
});

test('server: an answer with an invented number is rejected and asked again', async () => {
  calls.length = 0;
  behave = (m, n) => ({ body: n === 1 ? { ...good, headline: 'Save $9,999 with Plan B.' } : good });
  const r = await explain(fresh('t3'));
  assert.equal(r.source, 'gemini'); assert.equal(calls.length, 2);
});

test('server: if every model fails, a template answer is returned with the reason', async () => {
  calls.length = 0; behave = () => ({ status: 503 });
  const r = await explain(fresh('t4'));
  assert.equal(r.source, 'template'); assert.match(r.reason, /m1: HTTP 503/); assert.equal(r.recommended_plan, 'B');
});

test('server: identical requests are served from cache without calling Gemini again', async () => {
  calls.length = 0; behave = () => ({ body: good });
  const x = fresh('t5');
  await explain(x); const before = calls.length;
  const r = await explain(x);
  assert.equal(r.cached, true); assert.equal(calls.length, before);
});
