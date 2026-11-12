import { Gantt } from '@bryntum/gantt';
import '@bryntum/gantt/gantt.css';
import '@bryntum/gantt/svalbard-light.css';
import '@bryntum/gantt/fontawesome/css/fontawesome.css';
import '@bryntum/gantt/fontawesome/css/solid.css';
import './style.css';

import { agency, lateDeposit } from '../src/seed.js';
import { evaluate, generatePlans, simulateRisk, toLlmInput } from '../src/engine.js';
import { templateExplanation, validateExplanation } from '../src/explain.js';

/* ---------- helpers ---------- */

const $ = (s) => document.querySelector(s);
const MINUS = '−';
const usd = (n) => (n < 0 ? MINUS + '$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
const pct = (x) => Math.round(x * 100);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Engine days are working days. Day 1 is Monday 9 Nov 2026; weekends are skipped, like the Gantt's calendar.
const dayToDate = (n) => new Date(2026, 10, 9 + Math.floor((n - 1) / 5) * 7 + ((n - 1) % 5));
const dayAfter = (n) => { const d = dayToDate(n); d.setDate(d.getDate() + 1); return d; };

const PAYMENT = lateDeposit.paymentId;
const baseline = evaluate(agency);
const people = Object.fromEntries(agency.people.map((p) => [p.id, p.name]));
const originalPerson = Object.fromEntries(agency.tasks.map((t) => [t.id, t.person]));
const promised = agency.payments.find((p) => p.id === PAYMENT);
const clientName = agency.projects.find((p) => p.id === promised.project).name.split(' ')[0];

const state = {
  newDay: lateDeposit.newDay,
  selected: 'A',
  applied: null,
  plans: null,
  risk: null,
  input: null,
  explanation: null,
  paid: null,        // the PayPal event that settled the deposit
  dismissed: new Set(), // events the user chose to replay past
  request: null,     // 'creating' | 'opened' | error text
};

/* ---------- compute (engine runs in the browser) ---------- */

function compute(runs) {
  const event = { paymentId: PAYMENT, newDay: state.newDay };
  state.plans = generatePlans(agency, event);
  state.risk = simulateRisk(state.plans, agency, { runs, seed: 7 });
  state.input = toLlmInput(agency, event, state.plans, state.risk);
  if (!state.plans[state.selected]) state.selected = 'A';
  if (state.applied && !state.plans[state.applied]) state.applied = null;
}

/* ---------- banner ---------- */

const late0 = () => lateDeposit.newDay - promised.day;

function renderBanner() {
  const late = state.newDay - promised.day;
  const payroll = agency.expenses.filter((e) => e.payroll && e.day > agency.today).sort((a, b) => a.day - b.day)[0];
  const el = $('#banner');
  el.className = 'hero';
  const amount = usd(promised.amount);
  if (state.paid) {
    el.classList.add('is-paid');
    el.innerHTML = `
    <h1>${esc(clientName)} paid the ${amount} deposit. <span class="n ok">Back on track.</span></h1>
    <p>PayPal confirmed the payment with a signed event. The deposit was ${late0()} days late. The work it was blocking can start, and cash and schedule are back to the original plan.</p>`;
    return;
  }
  el.innerHTML = `
    <h1>${esc(clientName)}&rsquo;s ${amount} deposit is <span class="n">${late} days</span> late.</h1>
    <p>It was due on day ${promised.day} and is now promised for day ${state.newDay}. ${usd(payroll.amount)} payroll is due on day ${payroll.day}. Here is what each option does to the schedule, the cash and the risk.</p>
    ${state.applied ? `<div class="state" role="status">Plan ${state.applied} approved. The schedule below shows the approved plan.</div>` : ''}`;
}

/* ---------- overview: every figure is calculated from the data ---------- */

function renderOverview() {
  const plan = state.plans[state.selected];
  const lateProject = promised.project;
  const projectsAtRisk = Object.values(plan.projects).filter((p) => p.finish > p.deadline).length;
  const heldUp = agency.payments.filter((p) => p.project === lateProject).reduce((a, p) => a + p.amount, 0);
  const blocked = agency.tasks.filter((t) => t.gate === PAYMENT);
  const risk = state.risk[state.selected];
  const miss = Math.round(risk.pMissPayroll * 100);
  const tiles = state.paid
    ? [['Active projects', agency.projects.length, ''], ['Payments late', 0, 'good'], ['Work blocked', 0, 'good'], ['Projects at risk', projectsAtRisk, projectsAtRisk ? 'warn' : 'good'], ['Revenue held up', usd(0), 'good'], ['Payroll miss chance', miss + '%', miss >= 50 ? 'bad' : miss ? 'warn' : 'good']]
    : [['Active projects', agency.projects.length, ''], ['Payments late', 1, 'bad'], ['Tasks blocked', blocked.length, 'bad'], ['Projects at risk', projectsAtRisk, projectsAtRisk ? 'warn' : 'good'], ['Revenue held up', usd(heldUp), 'warn'], [`Payroll miss chance`, miss + '%', miss >= 50 ? 'bad' : miss ? 'warn' : 'good']];
  const label = (l) => (l === 'Payroll miss chance' ? `${l} (Plan ${state.selected})` : l);
  $('#overview').innerHTML = tiles.map(([l, v, c]) => `<div class="tile ${c}"><span class="tile-v">${esc(String(v))}</span><span class="tile-l">${esc(label(l))}</span></div>`).join('');
}

/* ---------- activity feed (server audit trail) ---------- */

const ACTIVITY = {
  payment_requested: 'Payment requested',
  signature_verified: 'PayPal signature verified',
  event_rejected: 'Event rejected',
  event_ignored: 'Event ignored',
  payment_state: 'Payment updated',
  schedule_recalculated: 'Schedule recalculated',
  plan_approved: 'Plan approved',
  plan_rejected: 'Approval withdrawn',
  message_copied: 'Client message copied',
};
const BAD = new Set(['event_rejected']);
const GOOD = new Set(['signature_verified', 'schedule_recalculated']);

function renderActivity(audit) {
  const rows = audit.length ? audit.slice(0, 12).map((a) => {
    const t = new Date(a.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `<li class="${BAD.has(a.kind) ? 'bad' : GOOD.has(a.kind) ? 'good' : ''}"><time>${esc(t)}</time><b>${esc(ACTIVITY[a.kind] ?? a.kind)}</b><span>${esc(a.detail)}</span></li>`;
  }).join('') : '<li class="empty"><span>Nothing yet. Approve a plan and request the payment to see events appear here.</span></li>';
  $('#activity').innerHTML = rows;
}

/* ---------- plan cards ---------- */

function cashRange() {
  let lo = 0, hi = 0;
  const all = [baseline.cash, ...Object.values(state.plans).map((p) => p.cash)];
  for (const series of all) for (const c of series.slice(0, 41)) { lo = Math.min(lo, c.cash); hi = Math.max(hi, c.cash); }
  return [Math.floor(lo / 1000) * 1000, Math.ceil(hi / 1000) * 1000];
}

function stepPath(series, X, Y, maxDay) {
  let prev = series[0].cash;
  let d = `M${X(0).toFixed(1)},${Y(prev).toFixed(1)}`;
  for (let i = 1; i <= maxDay; i++) {
    const c = series[i].cash;
    if (c !== prev) { d += `H${X(i).toFixed(1)}V${Y(c).toFixed(1)}`; prev = c; }
  }
  return d + `H${X(maxDay).toFixed(1)}`;
}

function sparkline(series, [lo, hi], id) {
  const W = 240, H = 54, p = 3, maxDay = 40;
  const X = (d) => p + (d / maxDay) * (W - 2 * p);
  const Y = (v) => p + (1 - (v - lo) / (hi - lo)) * (H - 2 * p);
  const line = stepPath(series, X, Y, maxDay);
  const z = Y(0);
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Cash over time">
    <defs><clipPath id="neg-${id}"><rect x="0" y="${z}" width="${W}" height="${H}"/></clipPath></defs>
    <line x1="0" x2="${W}" y1="${z}" y2="${z}" stroke="#aeb9b2" stroke-width="1"/>
    <path d="${line}" fill="none" stroke="#12222b" stroke-width="1.8" vector-effect="non-scaling-stroke"/>
    <path d="${line}" fill="none" stroke="#c4314b" stroke-width="2.4" clip-path="url(#neg-${id})" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function riskClass(p) { return p >= 0.67 ? 'bad' : p >= 0.15 ? 'warn' : 'good'; }

function renderPlans() {
  const host = $('#plans');
  const range = cashRange();
  host.innerHTML = '';
  const rec = state.explanation?.recommended_plan;
  for (const [key, plan] of Object.entries(state.plans)) {
    const r = state.risk[key];
    const acme = plan.projects.acme, bright = plan.projects.brightly;
    const payrollPct = pct(r.pMissPayroll);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'plan';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', String(state.selected === key));
    btn.dataset.key = key;
    btn.innerHTML = `
      <b class="plan-name">Plan ${key}: ${esc(plan.name)}</b>
      <div class="plan-tags">
        ${rec === key ? '<span class="badge rec">Recommended</span>' : ''}
        ${state.applied === key ? '<span class="badge applied">Approved</span>' : ''}</div>
      <p class="plan-change">${esc(plan.change)}</p>
      ${sparkline(plan.cash, range, key)}
      <dl class="facts">
        <dt>Payroll missed in</dt><dd class="big ${riskClass(r.pMissPayroll)}">${payrollPct}%</dd>
        <div class="bar" aria-hidden="true"><i style="width:${payrollPct}%"></i></div>
        <dt>${esc(clientName)} delivered</dt><dd class="${acme.slip ? 'bad' : 'good'}">day ${acme.finish}${acme.slip ? ` (${acme.slip} late)` : ' (on time)'}</dd>
        <dt>Brightly delivered</dt><dd class="${bright.slip ? 'bad' : 'good'}">day ${bright.finish}${bright.slip ? ` (${bright.slip} late)` : ' (on time)'}</dd>
        <dt>${plan.offer ? `Lowest cash, if ${esc(clientName)} accepts` : 'Lowest cash, if paid on the promised date'}</dt><dd class="${plan.lowestCash < 0 ? 'bad' : ''}">${usd(plan.lowestCash)}</dd>
        ${plan.offer ? `<dt>Chance ${esc(clientName)} accepts (assumed)</dt><dd>${Math.round(plan.offer.acceptProb * 100)}%</dd>` : ''}
        <dt>Unpaid-work risk</dt><dd class="${plan.unpaidWorkDays ? 'warn' : ''}">${plan.unpaidWorkDays ? `${plan.unpaidWorkDays} days, ${pct(r.pUnpaidWork)}% chance` : 'none'}</dd>
        <div class="facts-divider">Simulated (2,000 futures)</div>
        <dt>Acme on time</dt><dd class="${pct(r.pOnTime.acme) === 100 ? 'good' : pct(r.pOnTime.acme) === 0 ? 'bad' : 'warn'}">${pct(r.pOnTime.acme)}%</dd>
        <dt>Brightly on time</dt><dd class="${pct(r.pOnTime.brightly) === 100 ? 'good' : pct(r.pOnTime.brightly) === 0 ? 'bad' : 'warn'}">${pct(r.pOnTime.brightly)}%</dd>
        <dt>Worst-case cash (1-in-20)</dt><dd class="${r.lowestCashP5 < 0 ? 'bad' : ''}">${usd(r.lowestCashP5)}</dd>
      </dl>`;
    btn.addEventListener('click', () => select(key));
    host.appendChild(btn);
  }
}

function select(key) {
  state.selected = key;
  renderPlans();
  renderBoard();
}

/* ---------- plan comparison table ---------- */

function renderCompare() {
  const el = $('#compare');
  if (!el) return;
  if (!state.plans || !state.risk) { el.innerHTML = ''; return; }

  const entries = Object.entries(state.plans);
  const keys = entries.map(([k]) => k);
  const rec = state.explanation?.recommended_plan;

  const metrics = [
    {
      label: 'Payroll miss chance',
      get: (k) => state.risk[k].pMissPayroll,
      fmt: (v) => pct(v) + '%',
      best: 'low',
      cls: (v) => v >= 0.67 ? 'bad' : v >= 0.15 ? 'warn' : 'good',
    },
    {
      label: 'Acme website — on time',
      get: (k) => state.risk[k].pOnTime.acme,
      fmt: (v) => pct(v) + '%',
      best: 'high',
      cls: (v) => v >= 1 ? 'good' : v > 0 ? 'warn' : 'bad',
    },
    {
      label: 'Brightly app — on time',
      get: (k) => state.risk[k].pOnTime.brightly,
      fmt: (v) => pct(v) + '%',
      best: 'high',
      cls: (v) => v >= 1 ? 'good' : v > 0 ? 'warn' : 'bad',
    },
    {
      label: 'Lowest cash (if paid on date)',
      get: (k) => state.plans[k].lowestCash,
      fmt: (v) => usd(v),
      best: 'high',
      cls: (v) => v < 0 ? 'bad' : '',
    },
    {
      label: 'Worst-case cash (1-in-20 futures)',
      get: (k) => state.risk[k].lowestCashP5,
      fmt: (v) => usd(v),
      best: 'high',
      cls: (v) => v < 0 ? 'bad' : '',
    },
    {
      label: 'Unpaid work risk',
      get: (k) => state.risk[k].pUnpaidWork,
      fmt: (v) => v === 0 ? 'None' : pct(v) + '%',
      best: 'low',
      cls: (v) => v > 0 ? 'warn' : 'good',
    },
  ];

  const findBest = (m) => keys.reduce((best, k) => {
    const bv = m.get(best), kv = m.get(k);
    return m.best === 'low' ? (kv < bv ? k : best) : (kv > bv ? k : best);
  });

  const thead = `<thead><tr>
    <th class="cmp-label"></th>
    ${entries.map(([k, p]) => `<th class="cmp-plan${k === state.selected ? ' cmp-sel' : ''}${k === rec ? ' cmp-rec' : ''}">
      <span class="cmp-pkey">Plan ${esc(k)}</span>
      <span class="cmp-pname">${esc(p.name)}</span>
    </th>`).join('')}
  </tr></thead>`;

  const tbody = `<tbody>${metrics.map((m) => {
    const best = findBest(m);
    return `<tr>
      <th class="cmp-label">${esc(m.label)}</th>
      ${keys.map((k) => {
        const v = m.get(k);
        const isBest = k === best;
        return `<td class="cmp-val ${m.cls(v)}${isBest ? ' cmp-best' : ''}${k === state.selected ? ' cmp-sel' : ''}${k === rec ? ' cmp-rec' : ''}">${m.fmt(v)}${isBest ? '<span class="cmp-star" title="Best on this metric"> ★</span>' : ''}</td>`;
      }).join('')}
    </tr>`;
  }).join('')}</tbody>`;

  el.innerHTML = `<div class="cmp-head">
    <h3>Plan comparison</h3>
    <p>All percentages from 2,000 simulated futures.&nbsp; ★&nbsp;= best on this metric.</p>
  </div>
  <div class="cmp-scroll"><table class="cmp-table">${thead}${tbody}</table></div>`;
}

/* ---------- Gantt ---------- */

const taskIndex = Object.fromEntries(agency.tasks.map((t, i) => [t.id, i]));
const orderOfTask = (id) => (taskIndex[id] ?? taskIndex[id.slice(0, -1)]) * 10 + (taskIndex[id] === undefined ? (id.endsWith('b') ? 2 : 1) : 0);
const orderOfPayment = (p) => {
  const gated = agency.tasks.find((t) => t.gate === p.id);
  if (gated) return taskIndex[gated.id] * 10 - 5; // a deposit sits just above the work it unlocks
  return taskIndex[p.afterTasks[p.afterTasks.length - 1]] * 10 + 5; // a milestone sits just below the work that earns it
};

const origTask = new Map(baseline.schedule.tasks.map((t) => [t.id, t]));
const origPay = baseline.schedule.paymentDays;
const taskBaseline = (id) => { const o = origTask.get(id) ?? origTask.get(id.slice(0, -1)); return o ? [{ startDate: dayToDate(o.start), endDate: dayAfter(o.end) }] : []; };

function ganttModel(plan) {
  const homeDays = baseline.schedule.paymentDays;
  const leaves = [];
  const unpaid = new Set(plan.data.tasks.filter((t) => t.gateWas).map((t) => t.id));
  for (const t of plan.schedule.tasks) {
    const moved = originalPerson[t.id] ? originalPerson[t.id] !== t.person : originalPerson[t.id.slice(0, -1)] !== t.person;
    leaves.push({
      id: t.id,
      project: t.project,
      sort: orderOfTask(t.id),
      name: `${t.name} (${people[t.person]})`,
      startDate: dayToDate(t.start),
      duration: t.end - t.start + 1,
      durationUnit: 'day',
      manuallyScheduled: true,
      baselines: taskBaseline(t.id),
      cls: `proj-${t.project}${unpaid.has(t.id) ? ' at-risk' : ''}${moved ? ' moved' : ''}`,
    });
  }
  for (const p of plan.data.payments) {
    const day = plan.schedule.paymentDays.get(p.id);
    const home = homeDays.get(p.id);
    const status = day > home ? 'late' : day < home ? 'early' : 'ontime';
    leaves.push({
      id: 'pay-' + p.id,
      project: p.project,
      sort: orderOfPayment(p),
      name: `${p.label} ${usd(p.amount)}`,
      startDate: dayToDate(day),
      duration: 0,
      manuallyScheduled: true,
      baselines: [{ startDate: dayToDate(home), endDate: dayToDate(home) }],
      cls: `pay pay-${status}`,
    });
  }
  const deadline = Object.fromEntries(agency.projects.map((p) => [p.id, p.deadline]));
  const lastTask = Object.fromEntries(agency.projects.map((p) => {
    const ts = plan.schedule.tasks.filter((t) => t.project === p.id);
    return [p.id, ts.reduce((a, b) => (b.end > a.end ? b : a)).id];
  }));
  for (const l of leaves) if (lastTask[l.project] === l.id) l.deadlineDate = dayAfter(deadline[l.project]);
  leaves.sort((a, b) => a.sort - b.sort);
  const groups = agency.projects.map((p) => ({ id: 'grp-' + p.id, name: p.name, expanded: true, cls: `grp proj-${p.id}`, children: [] }));
  for (const l of leaves) groups.find((g) => g.id === 'grp-' + l.project).children.push(l);
  const deps = plan.data.tasks.flatMap((t) => t.after.map((pid) => ({ id: `${pid}>${t.id}`, fromTask: pid, toTask: t.id })));
  return { groups, leaves, deps };
}

let gantt;

function createGantt() {
  const m = ganttModel(state.plans[state.selected]);
  gantt = new Gantt({
    appendTo: 'gantt',
    readOnly: true,
    startDate: dayToDate(1),
    endDate: dayToDate(36),
    viewPreset: 'weekAndDay',
    rowHeight: 30,
    barMargin: 5,
    columns: [{ type: 'name', text: 'Work and payments', width: window.innerWidth < 700 ? 150 : 270 }],
    features: {
      timeRanges: { showCurrentTimeLine: false, showHeaderElements: false },
      indicators: { items: { earlyDates: false, lateDates: false, deadlineDate: true, constraintDate: false } },
      projectLines: false,
      baselines: true,
      taskMenu: false,
      cellMenu: false,
      headerMenu: false,
      taskEdit: false,
    },
    project: {
      tasks: m.groups,
      dependencies: m.deps,
      timeRanges: [{ id: 'today', name: 'Today', startDate: dayToDate(6), duration: 0 }],
    },
  });
  fitGantt();
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(fitGantt, 150); });
}

function fitGantt() {
  gantt.zoomToSpan({ startDate: dayToDate(1), endDate: dayAfter(36), leftMargin: 0, rightMargin: 0 });
}

async function syncGantt() {
  const plan = state.plans[state.selected];
  const m = ganttModel(plan);
  const project = gantt.project;
  const store = project.taskStore;
  const want = new Map(m.leaves.map((l) => [String(l.id), l]));
  const stale = [];
  store.traverse((r) => { if (r.isLeaf && !String(r.id).startsWith('grp-') && !want.has(String(r.id))) stale.push(r); });
  stale.forEach((r) => r.remove());
  const sortOf = new Map(m.leaves.map((l) => [String(l.id), l.sort]));
  for (const l of m.leaves) {
    const rec = store.getById(l.id);
    if (rec) { rec.set({ name: l.name, startDate: l.startDate, duration: l.duration, cls: l.cls, deadlineDate: l.deadlineDate ?? null }); continue; }
    const group = store.getById('grp-' + l.project);
    const next = group.children.find((c) => sortOf.get(String(c.id)) > l.sort);
    if (next) group.insertChild(l, next); else group.appendChild(l);
  }
  project.dependencyStore.removeAll();
  project.dependencyStore.add(m.deps);
  await project.commitAsync();
}

/* ---------- cash chart ---------- */

function renderCash() {
  const plan = state.plans[state.selected];
  const W = 1000, H = 250, L = 64, R = 18, T = 26, B = 30, maxDay = 40;
  const [lo0, hi0] = cashRange();
  const lo = lo0 - 1000, hi = hi0 + 1000;
  const X = (d) => L + (d / maxDay) * (W - L - R);
  const Y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const z = Y(0);
  const step = Math.max(2000, Math.ceil((hi - lo) / 5 / 1000) * 1000);
  let grid = '';
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
    grid += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v === 0 ? '#12222b' : '#e1e6e2'}" stroke-width="${v === 0 ? 1.4 : 1}"/><text x="${L - 8}" y="${Y(v) + 4}" text-anchor="end">${usd(v)}</text>`;
  }
  let ticks = '';
  for (let d = 0; d <= maxDay; d += 5) ticks += `<text x="${X(d)}" y="${H - 8}" text-anchor="middle">day ${d}</text>`;
  const payroll = agency.expenses.filter((e) => e.payroll).map((e) => `
    <line x1="${X(e.day)}" x2="${X(e.day)}" y1="${T - 6}" y2="${H - B}" stroke="#566872" stroke-dasharray="3 4"/>
    <text x="${X(e.day)}" y="${T - 10}" text-anchor="middle">Payroll ${usd(e.amount)}</text>`).join('');
  const dayMark = (d, label, color) => `<line x1="${X(d)}" x2="${X(d)}" y1="${T}" y2="${H - B}" stroke="${color}" stroke-width="1.5"/><text x="${X(d) + 5}" y="${H - B - 8}" fill="${color}" style="fill:${color};font-weight:600">${label}</text>`;
  const line = stepPath(plan.cash, X, Y, maxDay);
  const area = `${line}V${z}H${X(0)}Z`;
  const ghost = stepPath(baseline.cash, X, Y, maxDay);
  let lowPoint = plan.cash[agency.today];
  for (const c of plan.cash.slice(agency.today, maxDay + 1)) if (c.cash < lowPoint.cash) lowPoint = c;
  const low = lowPoint.day, lowCash = lowPoint.cash;
  const lowLabel = lowCash < 0
    ? `<circle cx="${X(low)}" cy="${Y(lowCash)}" r="4.5" fill="#c4314b"/><text class="low" x="${X(low) + (low <= agency.today + 2 ? 10 : -10)}" y="${Y(lowCash) + (low <= agency.today + 2 ? -10 : 4)}" text-anchor="${low <= agency.today + 2 ? 'start' : 'end'}" style="fill:#c4314b">${usd(lowCash)} on day ${low}</text>`
    : `<circle cx="${X(low)}" cy="${Y(lowCash)}" r="4.5" fill="#12222b"/><text class="low" x="${X(low) + (low <= agency.today + 2 ? 10 : -10)}" y="${Y(lowCash) + (low <= agency.today + 2 ? -10 : 4)}" text-anchor="${low <= agency.today + 2 ? 'start' : 'end'}" style="fill:#12222b">${usd(lowCash)} on day ${low}</text>`;
  // Deposit arrival marker: a green dashed vertical with label near top of chart
  const depositMark = (() => {
    if (state.paid || state.newDay > maxDay) return '';
    const xp = X(state.newDay).toFixed(1);
    const tx = (parseFloat(xp) + 6).toFixed(1);
    // Flip label to left side when deposit is in the last 20% of the chart
    const anchor = state.newDay > maxDay * 0.78 ? 'end' : 'start';
    const txFlipped = anchor === 'end' ? (parseFloat(xp) - 6).toFixed(1) : tx;
    return `<line x1="${xp}" x2="${xp}" y1="${T}" y2="${H - B}" stroke="#1e7b61" stroke-width="1.5" stroke-dasharray="5 3"/>`
      + `<text x="${txFlipped}" y="${T + 14}" fill="#1e7b61" style="fill:#1e7b61;font-weight:600" text-anchor="${anchor}">Deposit arrives</text>`
      + `<text x="${txFlipped}" y="${T + 27}" fill="#1e7b61" style="fill:#1e7b61;font-weight:600" text-anchor="${anchor}">day ${state.newDay}</text>`;
  })();
  $('#cash').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Cash balance by day for Plan ${state.selected}. Lowest cash from today ${usd(lowCash)} on day ${low}.">
      <defs>
        <clipPath id="below"><rect x="0" y="${z}" width="${W}" height="${H}"/></clipPath>
        <clipPath id="above"><rect x="0" y="0" width="${W}" height="${z}"/></clipPath>
      </defs>
      ${grid}${ticks}${payroll}
      <path d="${ghost}" fill="none" stroke="#8b9a92" stroke-width="1.6" stroke-dasharray="5 4"/>
      <path d="${area}" fill="#1e7b61" fill-opacity=".09" clip-path="url(#above)"/>
      <path d="${area}" fill="#c4314b" fill-opacity=".18" clip-path="url(#below)"/>
      <path d="${line}" fill="none" stroke="#12222b" stroke-width="2.4" clip-path="url(#above)"/>
      <path d="${line}" fill="none" stroke="#c4314b" stroke-width="2.8" clip-path="url(#below)"/>
      ${dayMark(agency.today, 'today', '#2f5d7c')}
      ${depositMark}
      ${lowLabel}
    </svg>`;
  $('#cash-note').textContent = `Solid line: Plan ${state.selected}, if ${clientName} pays on day ${state.newDay}. Dashed line: if ${clientName} had paid on day ${promised.day}.`;
}

function renderBoard() {
  const plan = state.plans[state.selected];
  $('#board-title').textContent = `Schedule under Plan ${state.selected}: ${plan.name}`;
  if (gantt) syncGantt();
  renderCash();
}

/* ---------- assessment + approval ---------- */

function renderAssess() {
  const el = $('#assess');
  if (state.paid) {
    el.innerHTML = `
      <h2>Payment received. Nothing to decide.</h2>
      <ul><li>PayPal event ${esc(state.paid.type)} for ${esc(state.paid.custom_id)}, ${esc('$' + state.paid.amount)}, signature ${esc(state.paid.signature)}.</li>
      <li>The schedule and cash chart now show the deposit landing on day ${promised.day}.</li></ul>
      <div class="actions"><button class="btn ghost" id="replay" type="button">Replay the late payment</button></div>`;
    $('#replay').addEventListener('click', () => {
      fetch('/api/reset', { method: 'POST' }).then(pollEvents).catch(() => {});
      state.paid = null; state.applied = null; state.request = null; state.newDay = lateDeposit.newDay;
      $('#slider').value = state.newDay; compute(2000); renderAll(); loadExplanation();
    });
    return;
  }
  const ex = state.explanation;
  if (!ex) {
    el.innerHTML = `<h2>Assessing the options&hellip;</h2><p class="loading" role="status">Comparing the plans against 2,000 simulated futures and writing a recommendation.</p>`;
    return;
  }
  const plan = state.plans[ex.recommended_plan];
  const isApplied = state.applied === ex.recommended_plan;
  const src = ex.source === 'gemini'
    ? `<p class="source">Written by ${esc(ex.model)}. Every number in this text was checked against the engine&rsquo;s output.</p>`
    : `<p class="source warn">Template answer: the AI model was unavailable, so this text comes from a fixed rule. The numbers are the same.</p>`;
  el.innerHTML = `
    <h2>${esc(ex.headline)}</h2>
    <ul>${ex.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    <p class="alt">${esc(ex.when_to_pick_another)}</p>
    <div class="message"><h3>Message to ${esc(clientName)}, ready to send</h3><p id="msg">${esc(ex.client_message)}</p></div>
    <div class="actions">
      <button class="btn" id="approve" type="button" ${isApplied ? 'disabled' : ''}>${isApplied ? `Plan ${ex.recommended_plan} approved` : `Approve Plan ${ex.recommended_plan}`}</button>
      <button class="btn ghost" id="copy" type="button">Copy message</button>
      ${state.applied ? '<button class="btn ghost" id="undo" type="button">Undo approval</button>' : ''}
    </div>
    ${state.applied ? collectBox() : ''}
    ${src}`;
  $('#collect')?.addEventListener('click', requestPayment);
  $('#approve')?.addEventListener('click', () => {
    state.applied = ex.recommended_plan;
    state.selected = ex.recommended_plan;
    logDecision('plan_approved', `Manager approved Plan ${ex.recommended_plan}: ${state.plans[ex.recommended_plan].name}`);
    renderAll();
  });
  $('#undo')?.addEventListener('click', () => { logDecision('plan_rejected', `Manager withdrew approval of Plan ${state.applied}`); state.applied = null; renderAll(); });
  $('#copy').addEventListener('click', async (e) => {
    try { await navigator.clipboard.writeText(ex.client_message); e.target.textContent = 'Copied'; }
    catch { e.target.textContent = 'Select the text above to copy'; }
    setTimeout(() => { e.target.textContent = 'Copy message'; }, 1800);
  });
  void plan;
}

function collectBox() {
  const note = state.request === 'creating' ? 'Creating the PayPal payment link&hellip;'
    : state.request === 'opened' ? 'PayPal opened in a new tab. Pay with the sandbox buyer account. This page updates when PayPal confirms the payment.'
    : state.request ? esc(state.request) : `Creates a PayPal payment link for ${usd(promised.amount)}. Sandbox only, no real money.`;
  return `<div class="collect"><h3>Collect the ${esc(clientName)} deposit</h3><p id="collect-note">${note}</p>
    <button class="btn" id="collect" type="button" ${state.request === 'creating' ? 'disabled' : ''}>Get paid with PayPal</button></div>`;
}

async function requestPayment() {
  state.request = 'creating'; renderAssess();
  try {
    const res = await fetch('/api/payment-request', { method: 'POST' });
    if (!res.ok) throw new Error(await res.text());
    const { approveUrl } = await res.json();
    state.request = 'opened';
    window.open(approveUrl, '_blank', 'noopener');
  } catch (e) {
    state.request = 'Could not create the PayPal link: ' + String(e.message).slice(0, 160);
  }
  renderAssess();
}

function logDecision(kind, detail) {
  fetch('/api/decision', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind, detail }) }).then(pollEvents).catch(() => {});
}

let explainToken = 0;
async function loadExplanation() {
  const token = ++explainToken;
  state.explanation = null;
  renderAssess();
  let result;
  try {
    const res = await fetch('/api/explain', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.input) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    result = await res.json();
  } catch {
    result = templateExplanation(state.input);
  }
  if (token !== explainToken) return; // a newer date was chosen while this was loading
  if (validateExplanation(result, state.input).length) result = templateExplanation(state.input);
  state.explanation = result;
  renderPlans();
  renderCompare();
  renderAssess();
}

/* ---------- what-if ---------- */

let debounce;
function setupSlider() {
  const slider = $('#slider');
  const label = $('#slider-label');
  const show = () => { label.textContent = `${clientName} pays on day ${state.newDay} (${state.newDay - promised.day} days after the due date)`; slider.value = state.newDay; };
  show();
  slider.addEventListener('input', () => {
    state.newDay = Number(slider.value);
    show();
    clearTimeout(debounce);
    debounce = setTimeout(() => { compute(800); renderAll(); loadExplanation(); }, 350);
  });
  $('#reset').addEventListener('click', () => {
    state.newDay = lateDeposit.newDay; show();
    compute(2000); renderAll(); loadExplanation();
  });
}

/* ---------- live PayPal events ---------- */

async function pollEvents() {
  try {
    const [events, ledger] = await Promise.all([fetch('/api/events').then((r) => r.json()), fetch('/api/state').then((r) => r.json())]);
    const e = events[0];
    renderActivity(ledger.audit);
    if (ledger.payments[PAYMENT] === 'paid' && !state.paid) {
      const settled = events.find((x) => x.type === 'PAYMENT.CAPTURE.COMPLETED' && x.custom_id === PAYMENT) ?? {};
      state.paid = { id: settled.id, type: 'PAYMENT.CAPTURE.COMPLETED', custom_id: PAYMENT, amount: settled.amount ?? promised.amount.toFixed(2), signature: settled.signature ?? 'SUCCESS' };
      state.newDay = promised.day; state.selected = 'A'; state.applied = null;
      $('#slider').value = state.newDay; compute(2000); renderAll(); renderAssess();
    } else if (ledger.payments[PAYMENT] !== 'paid' && state.paid) {
      state.paid = null; // the server was reset
    }
    $('#feed').innerHTML = e
      ? `${esc(e.type)}${e.custom_id ? ' for ' + esc(e.custom_id) : ''}${e.amount ? ' ' + esc('$' + e.amount) : ''}, signature <span class="${e.signature === 'SUCCESS' ? 'ok' : ''}">${esc(e.signature)}</span>`
      : 'Connected. No payments received yet.';
  } catch {
    $('#feed').textContent = 'Offline';
  }
}

/* ---------- boot ---------- */

function renderAll() {
  document.body.classList.toggle('paid', !!state.paid);
  renderBanner();
  renderPlans();
  renderCompare();
  renderOverview();
  renderBoard();
  if (state.explanation || state.paid) renderAssess();
}

compute(2000);
renderBanner();
renderOverview();
renderPlans();
renderCompare();
createGantt();
renderBoard();
setupSlider();
loadExplanation();
pollEvents();
setInterval(pollEvents, 5000);
window.__ballast = { state, gantt: () => gantt }; // for automated checks
