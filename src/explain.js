// The AI layer, in three pure pieces that run in Node and in the browser:
//   buildPrompt          what we ask the model (numbers only come from the engine)
//   validateExplanation  rejects any answer that uses a number the engine did not produce
//   templateExplanation  a plain, deterministic answer used when the model is down or fails the check

const LETTERS = ['A', 'B', 'C', 'D'];

export function buildPrompt(input, tone = 'diplomatic') {
  const toneGuide = {
    diplomatic: 'Tone: Warm, collaborative, relationship-preserving reminder.',
    firm: 'Tone: Direct, contractual, reminding the client that work remains paused until payment clears.',
    urgent: 'Tone: Urgent, emphasizing imminent payroll deadlines and severe delivery slip.'
  }[tone] || 'Tone: Warm, collaborative reminder.';

  return `You are the decision assistant for a small agency owner. A client payment is late.
Below are the recovery plans, already computed by deterministic code, with risk from simulation.

Rules:
- Use ONLY numbers that appear in the data. Never calculate, estimate or invent a number.
- Refer to plans by letter and name.
- A plan with client_accepts_offer_pct only works if the client accepts; its other figures assume they accept, so weigh them with that chance.
- Plans marked dominated_by_plan are strictly worse than the plan named there; say so if relevant.
- Write for a busy business owner: plain words, no jargon.
- Client message requirement: ${toneGuide}

Return JSON with exactly these keys:
{"recommended_plan":"A"|"B"|"C"|"D" (one of the plan letters in the data),"headline":"one sentence","reasons":["2-3 short sentences"],"when_to_pick_another":"one sentence naming the other plan and the situation that favours it","client_message":"a reminder to the client matching the requested tone, with no new numbers beyond the amount and dates in the data"}

DATA:
${JSON.stringify(input, null, 2)}`;
}

// All numbers in the input are allowed; anything else in the answer is a hallucination.
function numbersIn(text) {
  return [...String(text).matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, '')));
}

export function validateExplanation(out, input) {
  const problems = [];
  if (!out || typeof out !== 'object') return ['not an object'];
  for (const k of ['recommended_plan', 'headline', 'reasons', 'when_to_pick_another', 'client_message']) {
    if (!(k in out)) problems.push('missing key: ' + k);
  }
  if (!Object.keys(input.plans).includes(out.recommended_plan)) problems.push('recommended_plan is not one of the plans');
  if (!Array.isArray(out.reasons) || out.reasons.length === 0) problems.push('reasons must be a non-empty list');
  const allowed = new Set(numbersIn(JSON.stringify(input)).map((n) => Math.abs(n)));
  const text = [out.headline, ...(Array.isArray(out.reasons) ? out.reasons : []), out.when_to_pick_another, out.client_message].join(' ');
  for (const n of numbersIn(text)) if (!allowed.has(n)) problems.push('number not in data: ' + n);
  return problems;
}

const usd = (n) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US');

// Choose by rule: lowest chance of missing payroll, then lowest chance of unpaid work, then earliest finish.
export function templateExplanation(input, tone = 'diplomatic') {
  const entries = Object.entries(input.plans);
  const score = ([, p]) => [
    p.chance_of_missing_payroll_pct ?? 100,
    p.chance_of_unpaid_work_pct ?? 0,
    Math.max(...Object.values(p.project_finish_days)),
  ];
  entries.sort((a, b) => {
    const x = score(a), y = score(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
  const [bestKey, best] = entries[0];
  const others = entries.slice(1);
  const lp = input.facts.late_payment;
  const finish = (p) => Math.max(...Object.values(p.project_finish_days));
  const alt = [...others].filter(([, p]) => p.dominated_by_plan !== bestKey).sort((a, b) => finish(a[1]) - finish(b[1]))[0] ?? others[0];

  const reasons = [
    `Plan ${bestKey} (${best.name}) has the lowest chance of missing payroll: ${best.chance_of_missing_payroll_pct}%.`,
    `Its lowest cash is ${usd(best.lowest_cash)} if ${lp.client} pays on the new date.`,
  ];
  for (const [k, p] of others) {
    if (p.dominated_by_plan === bestKey) reasons.push(`Plan ${k} (${p.name}) is worse than Plan ${bestKey} on every measure.`);
  }

  const clientMessages = {
    diplomatic: `Hi ${lp.client} team, a quick heads-up: the ${usd(lp.amount)} payment for "${lp.label}" was due on day ${lp.expected_day} and is now expected on day ${lp.new_expected_day}. We have planned around the delay, but the schedule depends on this payment. Could you confirm the date it will arrive? Thanks for your help.`,
    firm: `Hello ${lp.client} team, regarding the ${usd(lp.amount)} invoice for "${lp.label}": it was due on day ${lp.expected_day} and is scheduled for day ${lp.new_expected_day}. Per our schedule, dependent work cannot start until funds clear. Please ensure timely payment so we can proceed without further delay.`,
    urgent: `URGENT: ${lp.client} team, the ${usd(lp.amount)} payment for "${lp.label}" is ${lp.days_late} days late (due day ${lp.expected_day}). Our upcoming payroll and project delivery depend strictly on this payment arriving by day ${lp.new_expected_day}. Please confirm release of funds immediately.`
  };

  return {
    recommended_plan: bestKey,
    headline: `Go with Plan ${bestKey}: ${best.name}.`,
    reasons,
    when_to_pick_another: alt
      ? (finish(alt[1]) < finish(best)
        ? `Pick Plan ${alt[0]} (${alt[1].name}) if protecting a deadline matters more than protecting cash.`
        : `Pick Plan ${alt[0]} (${alt[1].name}) if you prefer its trade-off to Plan ${bestKey}.`)
      : 'No other plan is worth considering.',
    client_message: clientMessages[tone] || clientMessages.diplomatic,
    source: 'template',
    tone,
  };
}

export { LETTERS };
