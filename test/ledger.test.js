import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedger } from '../src/ledger.js';

const ev = (id, type, custom_id = 'acme-deposit') => ({ id, event_type: type, resource: { custom_id } });
const fresh = () => createLedger(['acme-deposit', 'acme-final']);

test('verified capture marks the payment paid and unblocks the schedule', () => {
  const l = fresh();
  const r = l.receive(ev('1', 'PAYMENT.CAPTURE.COMPLETED'), 'SUCCESS');
  assert.equal(r.changed, true);
  assert.equal(l.state()['acme-deposit'], 'paid');
  assert.ok(l.audit().some((a) => a.kind === 'schedule_recalculated'));
});

test('duplicate webhook is processed once', () => {
  const l = fresh();
  l.receive(ev('1', 'PAYMENT.CAPTURE.COMPLETED'), 'SUCCESS');
  const before = l.audit().length;
  const r = l.receive(ev('1', 'PAYMENT.CAPTURE.COMPLETED'), 'SUCCESS');
  assert.equal(r.outcome, 'duplicate');
  assert.equal(l.audit().length, before);
});

test('invalid signature is rejected and changes nothing', () => {
  const l = fresh();
  const r = l.receive(ev('1', 'PAYMENT.CAPTURE.COMPLETED'), 'FAILURE');
  assert.equal(r.status, 400);
  assert.equal(l.state()['acme-deposit'], 'pending');
  assert.equal(l.audit()[0].kind, 'event_rejected');
});

test('skipped verification (no keys) never marks a payment paid', () => {
  const l = fresh();
  l.receive(ev('1', 'PAYMENT.CAPTURE.COMPLETED'), 'SKIPPED (set keys)');
  assert.equal(l.state()['acme-deposit'], 'pending');
});

test('out-of-order: an approval arriving after capture does not downgrade', () => {
  const l = fresh();
  l.receive(ev('1', 'PAYMENT.CAPTURE.COMPLETED'), 'SUCCESS');
  const r = l.receive(ev('2', 'CHECKOUT.ORDER.APPROVED'), 'SUCCESS');
  assert.equal(r.outcome, 'stale');
  assert.equal(l.state()['acme-deposit'], 'paid');
});

test('approval before capture moves forward, capture then completes', () => {
  const l = fresh();
  l.receive(ev('1', 'CHECKOUT.ORDER.APPROVED'), 'SUCCESS');
  assert.equal(l.state()['acme-deposit'], 'approved');
  l.receive(ev('2', 'PAYMENT.CAPTURE.COMPLETED'), 'SUCCESS');
  assert.equal(l.state()['acme-deposit'], 'paid');
});

test('failed payment leaves the milestone unpaid', () => {
  const l = fresh();
  l.receive(ev('1', 'PAYMENT.CAPTURE.DENIED'), 'SUCCESS');
  assert.equal(l.state()['acme-deposit'], 'failed');
});

test('a retry can succeed after a failure', () => {
  const l = fresh();
  l.receive(ev('1', 'PAYMENT.CAPTURE.DENIED'), 'SUCCESS');
  l.receive(ev('2', 'PAYMENT.CAPTURE.COMPLETED'), 'SUCCESS');
  assert.equal(l.state()['acme-deposit'], 'paid');
});

test('unrelated payment does not change any milestone', () => {
  const l = fresh();
  const r = l.receive(ev('1', 'PAYMENT.CAPTURE.COMPLETED', 'some-other-shop'), 'SUCCESS');
  assert.equal(r.outcome, 'ignored');
  assert.deepEqual(l.state(), { 'acme-deposit': 'pending', 'acme-final': 'pending' });
});

test('paying one milestone leaves the others untouched', () => {
  const l = fresh();
  l.receive(ev('1', 'PAYMENT.CAPTURE.COMPLETED'), 'SUCCESS');
  assert.equal(l.state()['acme-final'], 'pending');
});

test('event types that do not move money are ignored', () => {
  const l = fresh();
  const r = l.receive(ev('1', 'BILLING.SUBSCRIPTION.CREATED'), 'SUCCESS');
  assert.equal(r.outcome, 'ignored');
});

test('audit trail records requests and manager decisions, newest first', () => {
  const l = fresh();
  l.requested('acme-deposit', 'ORDER1');
  l.decision('plan_approved', 'Manager approved Plan B');
  assert.deepEqual(l.audit().map((a) => a.kind), ['plan_approved', 'payment_requested']);
});

const capture = (id, value, currency = 'USD', custom_id = 'acme-deposit') => ({ id, event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { custom_id, amount: { value, currency_code: currency } } });
const strict = () => createLedger(['acme-deposit', 'acme-final'], { expected: { 'acme-deposit': 6000 } });

test('a verified capture with the wrong amount does not mark the payment paid', () => {
  const l = strict();
  const r = l.receive(capture('1', '1.00'), 'SUCCESS');
  assert.equal(r.outcome, 'amount_mismatch');
  assert.equal(r.changed, false);
  assert.equal(l.state()['acme-deposit'], 'pending');
  assert.ok(l.audit().some((a) => a.kind === 'event_rejected' && /wrong amount/.test(a.detail)));
});

test('a capture in the wrong currency does not mark the payment paid', () => {
  const l = strict();
  assert.equal(l.receive(capture('1', '6000.00', 'EUR'), 'SUCCESS').outcome, 'amount_mismatch');
  assert.equal(l.state()['acme-deposit'], 'pending');
});

test('a capture with no amount does not mark the payment paid', () => {
  const l = strict();
  assert.equal(l.receive({ id: '1', event_type: 'PAYMENT.CAPTURE.COMPLETED', resource: { custom_id: 'acme-deposit' } }, 'SUCCESS').outcome, 'amount_mismatch');
});

test('the exact amount in USD is accepted, and a later correct event still works after a wrong one', () => {
  const l = strict();
  l.receive(capture('1', '5999.99'), 'SUCCESS');
  const r = l.receive(capture('2', '6000.00'), 'SUCCESS');
  assert.equal(r.changed, true);
  assert.equal(l.state()['acme-deposit'], 'paid');
});

test('a correct amount on the wrong milestone does not pay another milestone', () => {
  const l = strict();
  l.receive(capture('1', '6000.00', 'USD', 'not-a-milestone'), 'SUCCESS');
  assert.equal(l.state()['acme-deposit'], 'pending');
  assert.equal(l.state()['acme-final'], 'pending');
});
