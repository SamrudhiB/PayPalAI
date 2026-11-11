// FlowState scheduler engine.
// Pure functions: no I/O, no AI, no dependencies. Runs in Node and in the browser.
// The LLM never computes anything; it only explains what this file outputs.

const clone = (x) => structuredClone(x);

/* ---------- 1. Scheduler ---------- */

// Forward-schedules tasks. Rules:
//  - a task starts after all its predecessors finish,
//  - a gated task starts the day after its payment lands,
//  - one task per person at a time,
//  - nothing starts on or before `today`.
// Payments land on a fixed day, or `lag` days after their tasks finish.
export function schedule(data) {
  const { today, tasks, payments } = data;
  const placed = new Map(); // taskId -> {start, end}
  const busy = new Map(); // personId -> Set(days)
  const payDay = new Map(); // paymentId -> day
  const order = new Map(tasks.map((t, i) => [t.id, i]));

  const occupy = (person, start, end) => {
    if (!busy.has(person)) busy.set(person, new Set());
    for (let d = start; d <= end; d++) busy.get(person).add(d);
  };
  const earliestFree = (person, lowerBound, days) => {
    const set = busy.get(person) ?? new Set();
    for (let s = lowerBound; ; s++) {
      let ok = true;
      for (let d = s; d < s + days; d++) if (set.has(d)) { ok = false; break; }
      if (ok) return s;
    }
  };
  const resolvePayments = () => {
    for (const p of payments) {
      if (payDay.has(p.id)) continue;
      if (p.day !== undefined) payDay.set(p.id, p.day);
      else if (p.afterTasks.every((id) => placed.has(id))) {
        payDay.set(p.id, Math.max(...p.afterTasks.map((id) => placed.get(id).end)) + p.lag);
      }
    }
  };

  for (const t of tasks) {
    if (t.fixed) {
      placed.set(t.id, { ...t.fixed });
      occupy(t.person, t.fixed.start, t.fixed.end);
    }
  }

  let remaining = tasks.filter((t) => !t.fixed);
  while (remaining.length) {
    resolvePayments();
    const ready = [];
    for (const t of remaining) {
      if (!t.after.every((id) => placed.has(id))) continue;
      if (t.gate && !payDay.has(t.gate)) continue;
      let lb = today + 1;
      for (const id of t.after) lb = Math.max(lb, placed.get(id).end + 1);
      if (t.gate) lb = Math.max(lb, payDay.get(t.gate) + 1);
      ready.push({ t, start: earliestFree(t.person, lb, t.days) });
    }
    if (!ready.length) {
      throw new Error('Scheduling deadlock (circular dependency between tasks and payments): ' + remaining.map((t) => t.id).join(', '));
    }
    ready.sort((a, b) => a.start - b.start || order.get(a.t.id) - order.get(b.t.id));
    const { t, start } = ready[0];
    const end = start + t.days - 1;
    placed.set(t.id, { start, end });
    occupy(t.person, start, end);
    remaining = remaining.filter((x) => x !== t);
  }
  resolvePayments();

  return {
    tasks: tasks.map((t) => ({ id: t.id, project: t.project, name: t.name, person: t.person, ...placed.get(t.id) })),
    paymentDays: payDay,
  };
}

/* ---------- 2. Cash timeline ---------- */

// Cash at the end of each day: starting cash (day 0) + payments in - expenses out.
export function cashTimeline(data, sched, horizon = 45) {
  const delta = new Array(horizon + 1).fill(0);
  for (const p of data.payments) {
    const d = sched.paymentDays.get(p.id);
    if (d !== undefined && d <= horizon) delta[d] += p.amount;
  }
  for (const e of data.expenses) if (e.day <= horizon) delta[e.day] -= e.amount;
  const series = [{ day: 0, cash: data.startingCash }];
  let cash = data.startingCash;
  for (let d = 1; d <= horizon; d++) {
    cash += delta[d];
    series.push({ day: d, cash });
  }
  return series;
}

/* ---------- 3. Metrics for one version of the plan ---------- */

export function evaluate(data, horizon = 45) {
  const sched = schedule(data);
  const cash = cashTimeline(data, sched, horizon);

  const projects = {};
  for (const pr of data.projects) {
    const ends = sched.tasks.filter((t) => t.project === pr.id).map((t) => t.end);
    const finish = Math.max(...ends);
    projects[pr.id] = { name: pr.name, finish, deadline: pr.deadline, slip: Math.max(0, finish - pr.deadline) };
  }

  // Idle person-days caused by a payment gate: for each gated task (or one whose gate was waived),
  // count the days between tomorrow and its start on which its assignee has no work at all.
  const occupied = new Map();
  for (const t of sched.tasks) {
    if (!occupied.has(t.person)) occupied.set(t.person, new Set());
    for (let d = t.start; d <= t.end; d++) occupied.get(t.person).add(d);
  }
  let idle = 0;
  for (const t of data.tasks) {
    if (!t.gate && !t.gateWas) continue;
    const s = sched.tasks.find((x) => x.id === t.id);
    for (let d = data.today + 1; d < s.start; d++) if (!occupied.get(t.person).has(d)) idle++;
  }

  // Work started on trust: total days of tasks whose payment gate was waived.
  const exposure = data.tasks.filter((t) => t.gateWas).reduce((sum, t) => sum + t.days, 0);

  let low = cash[0];
  for (const c of cash) if (c.cash < low.cash) low = c;

  return {
    projects,
    totalSlip: Object.values(projects).reduce((s, p) => s + p.slip, 0),
    idlePersonDays: idle,
    lowestCash: low.cash,
    lowestCashDay: low.day,
    daysBelowZero: cash.filter((c) => c.cash < 0).length,
    unpaidWorkDays: exposure,
    cash,
    schedule: sched,
  };
}

/* ---------- 4. Events and recovery plans ---------- */

export function applyEvent(data, { paymentId, newDay }) {
  const d = clone(data);
  const p = d.payments.find((x) => x.id === paymentId);
  if (!p) throw new Error('Unknown payment ' + paymentId);
  if (p.day === undefined) throw new Error('Payment ' + paymentId + ' is not a fixed-day payment');
  p.day = newDay;
  return d;
}

// Plan B: the person blocked by the payment gate helps split a splittable task on another project.
function reassign(late, paymentId) {
  const gated = late.tasks.find((t) => t.gate === paymentId);
  if (!gated) return null;
  const sched = schedule(late);
  const candidates = late.tasks
    .filter((t) => t.splittable && !t.fixed && t.project !== gated.project && t.person !== gated.person && t.days >= 2)
    .sort((a, b) => sched.tasks.find((x) => x.id === a.id).start - sched.tasks.find((x) => x.id === b.id).start);
  const target = candidates[0];
  if (!target) return null;

  const d = clone(late);
  const i = d.tasks.findIndex((t) => t.id === target.id);
  const first = Math.ceil(target.days / 2);
  const a = { ...target, id: target.id + 'a', name: target.name + ' (part 1)', days: first, splittable: false };
  const b = { ...target, id: target.id + 'b', name: target.name + ' (part 2)', days: target.days - first, person: gated.person, splittable: false };
  d.tasks.splice(i, 1, a, b);
  for (const t of d.tasks) if (t.after.includes(target.id)) t.after = t.after.flatMap((x) => (x === target.id ? [a.id, b.id] : [x]));
  for (const p of d.payments) if (p.afterTasks?.includes(target.id)) p.afterTasks = p.afterTasks.flatMap((x) => (x === target.id ? [a.id, b.id] : [x]));
  const helper = late.people.find((p) => p.id === gated.person).name;
  const project = late.projects.find((p) => p.id === target.project).name;
  return { data: d, helper, project, task: target.name };
}

// Plan C: start the gated task now, before the payment lands.
function startAtRisk(late, paymentId) {
  const d = clone(late);
  let touched = false;
  for (const t of d.tasks) {
    if (t.gate === paymentId) { t.gateWas = t.gate; t.gate = null; touched = true; }
  }
  return touched ? d : null;
}

const KEYS = [
  ['totalSlip', 'low'],
  ['idlePersonDays', 'low'],
  ['lowestCash', 'high'],
  ['daysBelowZero', 'low'],
  ['unpaidWorkDays', 'low'],
];
// X is dominated by Y if Y is no worse on every metric and strictly better on at least one.
function dominates(y, x) {
  let better = false;
  for (const [k, dir] of KEYS) {
    const diff = dir === 'low' ? x[k] - y[k] : y[k] - x[k];
    if (diff < 0) return false;
    if (diff > 0) better = true;
  }
  return better;
}

export function generatePlans(base, event) {
  const late = applyEvent(base, event);
  const lateDay = event.newDay;
  const payment = base.payments.find((p) => p.id === event.paymentId);
  const out = {};

  out.A = {
    name: 'Wait',
    change: `Do nothing. Work gated by "${payment.label}" stays blocked until it lands on day ${lateDay}.`,
    risk: 'none',
    data: late,
  };
  const b = reassign(late, event.paymentId);
  if (b) {
    out.B = {
      name: `Move ${b.helper} to ${b.project}`,
      change: `${b.helper} helps with "${b.task}" on ${b.project}, so it finishes sooner and its payment lands earlier.`,
      risk: 'none',
      data: b.data,
    };
  }
  const c = startAtRisk(late, event.paymentId);
  if (c) {
    out.C = {
      name: 'Start now, at risk',
      change: `Start the blocked work before "${payment.label}" arrives.`,
      risk: null, // filled below from the numbers
      data: c,
    };
  }

  for (const plan of Object.values(out)) {
    const m = evaluate(plan.data);
    Object.assign(plan, {
      projects: m.projects,
      totalSlip: m.totalSlip,
      idlePersonDays: m.idlePersonDays,
      lowestCash: m.lowestCash,
      lowestCashDay: m.lowestCashDay,
      daysBelowZero: m.daysBelowZero,
      unpaidWorkDays: m.unpaidWorkDays,
      cash: m.cash,
      schedule: m.schedule,
    });
    if (plan.risk === null) plan.risk = `${m.unpaidWorkDays} days of unpaid work if the client never pays`;
  }
  for (const [k, plan] of Object.entries(out)) {
    const dom = Object.entries(out).find(([k2, other]) => k2 !== k && dominates(other, plan));
    plan.dominatedBy = dom ? dom[0] : null;
  }
  return out;
}

/* ---------- 5. Compact, number-only input for the LLM ---------- */

export function toLlmInput(base, event, plans, risk) {
  const p = base.payments.find((x) => x.id === event.paymentId);
  const proj = base.projects.find((x) => x.id === p.project);
  const pct = (x) => Math.round(x * 100);
  return {
    facts: {
      starting_cash: base.startingCash,
      expenses: base.expenses.map((e) => ({ day: e.day, amount: e.amount, label: e.label })),
      late_payment: { client: proj.name, label: p.label, amount: p.amount, expected_day: p.day, new_expected_day: event.newDay, days_late: event.newDay - p.day },
      deadlines: Object.fromEntries(base.projects.map((x) => [x.name, x.deadline])),
    },
    plans: Object.fromEntries(
      Object.entries(plans).map(([k, pl]) => [
        k,
        {
          name: pl.name,
          what_changes: pl.change,
          project_finish_days: Object.fromEntries(Object.values(pl.projects).map((x) => [x.name, x.finish])),
          idle_person_days: pl.idlePersonDays,
          lowest_cash: pl.lowestCash,
          days_below_zero: pl.daysBelowZero,
          risk: pl.risk,
          dominated_by_plan: pl.dominatedBy,
          ...(risk?.[k] && {
            simulated_futures: risk[k].runs,
            chance_of_missing_payroll_pct: pct(risk[k].pMissPayroll),
            chance_of_finishing_on_time_pct: Object.fromEntries(
              base.projects.map((x) => [x.name, pct(risk[k].pOnTime[x.id])]),
            ),
            chance_of_unpaid_work_pct: pct(risk[k].pUnpaidWork),
            typical_worst_case_cash: risk[k].lowestCashP5,
          }),
        },
      ]),
    ),
  };
}

/* ---------- 6. Risk simulation ---------- */
// Instead of trusting one promised payment date, replay each plan against many possible futures.
// Every plan sees the SAME random futures (common random numbers), so differences come from the
// plan, not from luck. Seeded, so results are reproducible.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NEVER = 999; // a payment that never arrives lands "after the horizon"

function sampleDelay(rel, rng) {
  if (!rel) return { delay: 0, never: false };
  const u = rng();
  if (u < rel.onTime) return { delay: 0, never: false };
  if (u < rel.onTime + rel.short) return { delay: 1 + Math.floor(rng() * 7), never: false }; // 1-7 days late
  if (u < rel.onTime + rel.short + rel.long) return { delay: 8 + Math.floor(rng() * 14), never: false }; // 8-21 days late
  return { delay: 0, never: true };
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

export function simulateRisk(plans, base, { runs = 2000, seed = 7, horizon = 45 } = {}) {
  const rng = mulberry32(seed);
  const reliability = new Map(base.projects.map((p) => [p.id, p.reliability]));
  const payrollDays = base.expenses.filter((e) => e.payroll).map((e) => e.day);

  const draws = [];
  for (let r = 0; r < runs; r++) {
    const d = {};
    for (const p of base.payments) d[p.id] = sampleDelay(reliability.get(p.project), rng);
    draws.push(d);
  }

  const out = {};
  for (const [key, plan] of Object.entries(plans)) {
    let missPayroll = 0, shortfallSum = 0, unpaidRuns = 0, unpaidDaysSum = 0;
    const onTime = Object.fromEntries(base.projects.map((p) => [p.id, 0]));
    const lows = [];
    for (const draw of draws) {
      const d = clone(plan.data);
      for (const p of d.payments) {
        const x = draw[p.id];
        if (x.never) { p.day = NEVER; delete p.afterTasks; delete p.lag; }
        else if (p.day !== undefined) p.day += x.delay;
        else p.lag += x.delay;
      }
      const m = evaluate(d, horizon);
      if (payrollDays.some((day) => m.cash[day].cash < 0)) missPayroll++;
      shortfallSum += Math.max(0, -m.lowestCash);
      lows.push(m.lowestCash);
      for (const pr of base.projects) if (m.projects[pr.id].slip === 0) onTime[pr.id]++;
      const unpaid = d.tasks.filter((t) => t.gateWas && draw[t.gateWas].never).reduce((s, t) => s + t.days, 0);
      if (unpaid > 0) unpaidRuns++;
      unpaidDaysSum += unpaid;
    }
    lows.sort((a, b) => a - b);
    out[key] = {
      runs,
      pMissPayroll: missPayroll / runs,
      pOnTime: Object.fromEntries(Object.entries(onTime).map(([k, v]) => [k, v / runs])),
      expectedShortfall: Math.round(shortfallSum / runs),
      lowestCashP5: quantile(lows, 0.05), // 1 future in 20 is worse than this
      pUnpaidWork: unpaidRuns / runs,
      expectedUnpaidDays: unpaidDaysSum / runs,
    };
  }
  return out;
}
