import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agency, lateDeposit } from '../src/seed.js';
import { evaluate, generatePlans, schedule, applyEvent, toLlmInput } from '../src/engine.js';

const taskOf = (m, id) => m.schedule.tasks.find((t) => t.id === id);

test('baseline: deposit on day 5 -> cash never below the starting $2,000, Acme on time', () => {
  const m = evaluate(agency);
  assert.equal(m.lowestCash, 2000);
  assert.equal(m.daysBelowZero, 0);
  assert.equal(m.projects.acme.finish, 19);
  assert.equal(m.projects.acme.slip, 0);
  assert.equal(m.projects.brightly.finish, 18);
  assert.deepEqual([taskOf(m, 'A2').start, taskOf(m, 'A2').end], [6, 15]);
});

test('a gated task cannot start before its payment lands', () => {
  const late = applyEvent(agency, lateDeposit);
  const s = schedule(late);
  assert.equal(s.tasks.find((t) => t.id === 'A2').start, 16);
  assert.equal(s.paymentDays.get('acme-deposit'), 15);
});

test('T4 table, Plan A (wait)', () => {
  const A = generatePlans(agency, lateDeposit).A;
  assert.equal(A.projects.acme.finish, 29);
  assert.equal(A.projects.acme.slip, 9);
  assert.equal(A.projects.brightly.finish, 18);
  assert.equal(A.idlePersonDays, 10);
  assert.equal(A.lowestCash, -1000);
  assert.equal(A.lowestCashDay, 14);
  assert.equal(A.daysBelowZero, 1);
  assert.equal(A.risk, 'none');
});

test('T4 table, Plan B (move Asha to Brightly)', () => {
  const B = generatePlans(agency, lateDeposit).B;
  assert.equal(B.name, 'Move Asha to Brightly app');
  assert.equal(B.projects.acme.finish, 29);
  assert.equal(B.projects.brightly.finish, 14);
  assert.equal(B.idlePersonDays, 6);
  assert.equal(B.lowestCash, 2000);
  assert.equal(B.daysBelowZero, 0);
  assert.equal(B.risk, 'none');
  // Brightly milestone 2 must land on day 12, before the day-14 payroll
  assert.equal(B.schedule.paymentDays.get('brightly-2'), 12);
});

test('T4 table, Plan C (start now, at risk)', () => {
  const C = generatePlans(agency, lateDeposit).C;
  assert.equal(C.projects.acme.finish, 19);
  assert.equal(C.projects.acme.slip, 0);
  assert.equal(C.projects.brightly.finish, 18);
  assert.equal(C.idlePersonDays, 0);
  assert.equal(C.lowestCash, -1000);
  assert.equal(C.daysBelowZero, 1);
  assert.equal(C.risk, '10 days of unpaid work if the client never pays');
});

test('Plan A is dominated by Plan B; B and C are a real trade-off', () => {
  const p = generatePlans(agency, lateDeposit);
  assert.equal(p.A.dominatedBy, 'B');
  assert.equal(p.B.dominatedBy, null);
  assert.equal(p.C.dominatedBy, null);
});

test('splitting keeps total work: parts add up and no person is double-booked', () => {
  const B = generatePlans(agency, lateDeposit).B;
  const tasks = B.schedule.tasks;
  const parts = tasks.filter((t) => t.id.startsWith('B2'));
  assert.equal(parts.length, 2);
  assert.equal(parts.reduce((s, t) => s + (t.end - t.start + 1), 0), 8);
  const days = new Map();
  for (const t of tasks) for (let d = t.start; d <= t.end; d++) {
    const key = t.person + ':' + d;
    assert.ok(!days.has(key), 'double-booked ' + key);
    days.set(key, true);
  }
});

test('what-if: a later payment never makes things better than an earlier one', () => {
  const a = evaluate(applyEvent(agency, { paymentId: 'acme-deposit', newDay: 15 }));
  const b = evaluate(applyEvent(agency, { paymentId: 'acme-deposit', newDay: 35 }));
  assert.ok(b.projects.acme.finish >= a.projects.acme.finish);
  assert.ok(b.projects.acme.slip > a.projects.acme.slip);
});

test('LLM input contains only numbers that come from the engine', () => {
  const plans = generatePlans(agency, lateDeposit);
  const input = toLlmInput(agency, lateDeposit, plans);
  assert.equal(input.facts.late_payment.amount, 6000);
  assert.equal(input.plans.B.lowest_cash, 2000);
  assert.equal(input.plans.A.dominated_by_plan, 'B');
});

test('circular dependency between a task and its own gate is reported, not looped forever', () => {
  const bad = structuredClone(agency);
  bad.payments.find((p) => p.id === 'acme-deposit').day = undefined;
  bad.payments.find((p) => p.id === 'acme-deposit').afterTasks = ['A3'];
  bad.payments.find((p) => p.id === 'acme-deposit').lag = 1;
  assert.throws(() => schedule(bad), /deadlock/i);
});

/* ---------- risk simulation ---------- */
import { simulateRisk } from '../src/engine.js';

test('reliability profiles are valid probability distributions', () => {
  for (const p of agency.projects) {
    const r = p.reliability;
    assert.ok(Math.abs(r.onTime + r.short + r.long + r.never - 1) < 1e-9, p.id);
  }
});

test('risk simulation is reproducible for the same seed', () => {
  const plans = generatePlans(agency, lateDeposit);
  const a = simulateRisk(plans, agency, { runs: 300, seed: 1 });
  const b = simulateRisk(plans, agency, { runs: 300, seed: 1 });
  assert.deepEqual(a, b);
});

test('risk: the deposit cannot arrive before day 15, so A and C always miss day-14 payroll; B usually does not', () => {
  const plans = generatePlans(agency, lateDeposit);
  const r = simulateRisk(plans, agency, { runs: 2000, seed: 7 });
  assert.equal(r.A.pMissPayroll, 1);
  assert.equal(r.C.pMissPayroll, 1);
  assert.ok(r.B.pMissPayroll < 0.4, 'B miss rate ' + r.B.pMissPayroll);
  assert.ok(r.B.pMissPayroll > 0, 'B is not risk-free');
});

test('risk: Plan C protects the Acme deadline, A and B cannot', () => {
  const plans = generatePlans(agency, lateDeposit);
  const r = simulateRisk(plans, agency, { runs: 500, seed: 3 });
  assert.equal(r.C.pOnTime.acme, 1);
  assert.equal(r.A.pOnTime.acme, 0);
  assert.equal(r.B.pOnTime.acme, 0);
});

test('risk: only Plan C carries unpaid-work risk, close to the client never-pay rate (8%)', () => {
  const plans = generatePlans(agency, lateDeposit);
  const r = simulateRisk(plans, agency, { runs: 2000, seed: 7 });
  assert.equal(r.A.pUnpaidWork, 0);
  assert.equal(r.B.pUnpaidWork, 0);
  assert.ok(r.C.pUnpaidWork > 0.05 && r.C.pUnpaidWork < 0.11, 'C unpaid ' + r.C.pUnpaidWork);
  assert.ok(Math.abs(r.C.expectedUnpaidDays - 10 * r.C.pUnpaidWork) < 1e-9);
});

test('LLM input includes whole-number percentages from the simulation', () => {
  const plans = generatePlans(agency, lateDeposit);
  const risk = simulateRisk(plans, agency, { runs: 500, seed: 7 });
  const input = toLlmInput(agency, lateDeposit, plans, risk);
  assert.equal(input.plans.A.chance_of_missing_payroll_pct, 100);
  assert.equal(input.plans.C.chance_of_finishing_on_time_pct['Acme website'], 100);
  assert.equal(input.plans.B.simulated_futures, 500);
});

import { agency as _agency, lateDeposit as _late } from '../src/seed.js';
import { generatePlans as _gen, simulateRisk as _sim } from '../src/engine.js';
test('Plan D: early-payment offer is a fourth plan and never dominates others', () => {
  const plans = _gen(_agency, _late);
  assert.deepEqual(Object.keys(plans), ['A', 'B', 'C', 'D']);
  assert.equal(plans.D.offer.discount, 180);
  assert.equal(plans.D.data.payments.find((p) => p.id === 'acme-deposit').amount, 5820);
  assert.equal(plans.B.dominatedBy, null);
  assert.equal(plans.A.dominatedBy, 'B');
});
test('Plan D: adding it does not change the risk numbers of A, B and C', () => {
  const plans = _gen(_agency, _late);
  const { D, ...abc } = plans;
  const withD = _sim(plans, _agency, { runs: 500, seed: 7 });
  const without = _sim(abc, _agency, { runs: 500, seed: 7 });
  for (const k of ['A', 'B', 'C']) assert.deepEqual(withD[k], without[k]);
  assert.ok(withD.D.pMissPayroll > withD.B.pMissPayroll * 0.5 && withD.D.pMissPayroll < 1);
});
