import { agency, lateDeposit } from './seed.js';
import { evaluate, generatePlans, simulateRisk } from './engine.js';

const base = evaluate(agency);
console.log('BASELINE (deposit on day 5)');
console.log('  lowest cash:', base.lowestCash, '| Acme finishes day', base.projects.acme.finish, '| Brightly finishes day', base.projects.brightly.finish);

const plans = generatePlans(agency, lateDeposit);
const risk = simulateRisk(plans, agency, { runs: 2000, seed: 7 });
const pct = (x) => Math.round(x * 100) + '%';
console.log('\nEVENT: Acme deposit promised for day', lateDeposit.newDay, 'instead of 5\n');

const keys = Object.keys(plans);
const rows = [
  ['', ...keys.map((k) => `Plan ${k}: ${plans[k].name}`)],
  ['-- if the client pays on the promised date --'],
  ['Acme finishes (deadline 20)', ...keys.map((k) => 'day ' + plans[k].projects.acme.finish)],
  ['Brightly finishes (deadline 24)', ...keys.map((k) => 'day ' + plans[k].projects.brightly.finish)],
  ['Idle person-days', ...keys.map((k) => plans[k].idlePersonDays)],
  ['Lowest cash', ...keys.map((k) => '$' + plans[k].lowestCash)],
  ['Dominated by', ...keys.map((k) => plans[k].dominatedBy ?? '-')],
  [`-- across ${risk.A.runs} simulated futures --`],
  ['Chance of missing payroll', ...keys.map((k) => pct(risk[k].pMissPayroll))],
  ['Chance Acme is on time', ...keys.map((k) => pct(risk[k].pOnTime.acme))],
  ['Chance Brightly is on time', ...keys.map((k) => pct(risk[k].pOnTime.brightly))],
  ['Expected cash shortfall', ...keys.map((k) => '$' + risk[k].expectedShortfall)],
  ['Worst 1-in-20 lowest cash', ...keys.map((k) => '$' + risk[k].lowestCashP5)],
  ['Chance of unpaid work', ...keys.map((k) => pct(risk[k].pUnpaidWork))],
];
for (const r of rows) console.log(r.map((c) => String(c).padEnd(34)).join(''));
