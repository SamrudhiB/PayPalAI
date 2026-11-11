const { GEMINI_API_KEY: key, GEMINI_MODEL: model } = process.env;
if (!key || !model) throw new Error("Set GEMINI_API_KEY and GEMINI_MODEL first");

// The T4 scenario, as the scheduler engine would output it
const input = {
  facts: {
    starting_cash: 2000,
    payroll: [{ day: 14, amount: 7000 }, { day: 28, amount: 7000 }],
    late_payment: { client: "Acme", amount: 6000, expected_day: 5, new_expected_day: 15 },
    brightly_milestone: { amount: 3000, day: 12 },
    acme_deadline_day: 20,
  },
  plans: {
    A: { name: "Wait", acme_launch_day: 29, brightly_delivered_day: 18, idle_person_days: 10, lowest_cash: -1000, days_below_zero: 1, risk: "none" },
    B: { name: "Move Asha to Brightly", acme_launch_day: 29, brightly_delivered_day: 14, idle_person_days: 6, lowest_cash: 2000, days_below_zero: 0, risk: "none" },
    C: { name: "Start Acme now, at risk", acme_launch_day: 19, brightly_delivered_day: 18, idle_person_days: 0, lowest_cash: -1000, days_below_zero: 1, risk: "10 days of unpaid work if the client never pays" },
  },
};

const allowed = new Set();
(function walk(x) {
  if (typeof x === "number") allowed.add(Math.abs(x));
  else if (x && typeof x === "object") Object.values(x).forEach(walk);
})(input);

const prompt = `You are a project-finance assistant for a small agency.
A client payment is late. Below are three recovery plans, already computed by deterministic code.
Use ONLY numbers that appear in the data. Do not invent or calculate new numbers.
Return JSON with exactly these keys:
{"recommended_plan":"A"|"B"|"C","reasons":["..."],"when_to_pick_another":"...","client_message":"a short, friendly but firm payment reminder to the client"}

DATA:
${JSON.stringify(input, null, 2)}`;

async function run() {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.3 },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const out = JSON.parse(text);

  const problems = [];
  for (const k of ["recommended_plan", "reasons", "when_to_pick_another", "client_message"])
    if (!(k in out)) problems.push(`missing key: ${k}`);
  if (!["A", "B", "C"].includes(out.recommended_plan)) problems.push("bad recommended_plan");

  const everything = JSON.stringify(out);
  for (const m of everything.matchAll(/\$\s?([\d,]+(?:\.\d+)?)/g)) {
    const n = Number(m[1].replace(/,/g, ""));
    if (!allowed.has(n)) problems.push(`amount not in data: $${n}`);
  }
  for (const m of everything.matchAll(/day\s+(\d+)/gi)) {
    const n = Number(m[1]);
    if (!allowed.has(n)) problems.push(`day not in data: ${n}`);
  }
  return { out, problems };
}

let pass = 0;
for (let i = 1; i <= 5; i++) {
  try {
    const { out, problems } = await run();
    console.log(`\nRun ${i}: ${problems.length ? "FAIL " + problems.join("; ") : "PASS"} | recommends ${out.recommended_plan}`);
    if (i === 1) console.log(JSON.stringify(out, null, 2));
    if (!problems.length) pass++;
  } catch (e) {
    console.log(`\nRun ${i}: ERROR ${e.message}`);
  }
}
console.log(`\nPassed ${pass}/5`);