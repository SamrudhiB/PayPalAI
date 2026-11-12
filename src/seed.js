// Sample agency from the T4 paper test. Days are working days, money is USD.
// "today" = 5: tasks already finished/running are `fixed`; everything else is scheduled from day 6.

export const agency = {
  today: 5,
  startingCash: 2000,
  people: [
    { id: 'asha', name: 'Asha', role: 'dev' },
    { id: 'ben', name: 'Ben', role: 'dev' },
    { id: 'chitra', name: 'Chitra', role: 'designer' },
  ],
  // `reliability` = how this client usually pays relative to the planned date:
  // on time, 1-7 days late, 8-21 days late, or never. Illustrative here; in the product it is
  // learned from each client's own payment history.
  projects: [
    { id: 'acme', name: 'Acme website', deadline: 20, reliability: { onTime: 0.45, short: 0.3, long: 0.17, never: 0.08 } },
    { id: 'brightly', name: 'Brightly app', deadline: 24, reliability: { onTime: 0.8, short: 0.15, long: 0.05, never: 0 } },
  ],
  tasks: [
    { id: 'A1', project: 'acme', name: 'Design', person: 'chitra', days: 5, after: [], fixed: { start: 1, end: 5 } },
    // A2 cannot start until the Acme deposit has landed.
    { id: 'A2', project: 'acme', name: 'Build', person: 'asha', days: 10, after: ['A1'], gate: 'acme-deposit' },
    { id: 'A3', project: 'acme', name: 'QA and launch', person: 'ben', days: 4, after: ['A2'] },
    { id: 'B1', project: 'brightly', name: 'Prototype', person: 'ben', days: 6, after: [], fixed: { start: 1, end: 6 } },
    { id: 'B2', project: 'brightly', name: 'Build', person: 'ben', days: 8, after: ['B1'], splittable: true },
    { id: 'B3', project: 'brightly', name: 'Polish', person: 'chitra', days: 4, after: ['B2'] },
  ],
  // A payment either lands on a fixed `day`, or `lag` days after its tasks finish.
  payments: [
    { id: 'acme-deposit', project: 'acme', label: 'Acme deposit', amount: 6000, day: 5 },
    { id: 'acme-final', project: 'acme', label: 'Acme final payment', amount: 6000, afterTasks: ['A3'], lag: 3 },
    { id: 'brightly-1', project: 'brightly', label: 'Brightly milestone 1', amount: 4000, afterTasks: ['B1'], lag: 2 },
    { id: 'brightly-2', project: 'brightly', label: 'Brightly milestone 2', amount: 3000, afterTasks: ['B2'], lag: 2 },
    { id: 'brightly-3', project: 'brightly', label: 'Brightly final payment', amount: 3000, afterTasks: ['B3'], lag: 2 },
  ],
  expenses: [
    { day: 14, amount: 7000, label: 'Payroll', payroll: true },
    { day: 28, amount: 7000, label: 'Payroll', payroll: true },
  ],
};

// The T4 event: the Acme deposit that was due on day 5 now arrives on day 15.
// Assumption, disclosed in the README: an early-payment discount is accepted 60% of the time.
agency.earlyPayOffer = { pct: 3, withinDays: 2, acceptProb: 0.6 };

export const lateDeposit = { paymentId: 'acme-deposit', newDay: 15 };
