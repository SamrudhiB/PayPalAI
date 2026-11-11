const key = process.env.GEMINI_API_KEY;
const list = await (await fetch(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=200&key=${key}`)).json();
const names = (list.models || [])
  .filter((m) => m.supportedGenerationMethods?.includes("generateContent") && /flash|lite|pro/i.test(m.name))
  .map((m) => m.name.replace("models/", ""));
console.log("Trying:", names.join(", "), "\n");
for (const n of names) {
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${n}:generateContent?key=${key}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with the JSON {"ok":true}' }] }], generationConfig: { responseMimeType: "application/json" } }),
    });
    console.log(r.ok ? "WORKS " : `HTTP ${r.status}`, n);
  } catch (e) { console.log("ERR   ", n, e.message); }
}