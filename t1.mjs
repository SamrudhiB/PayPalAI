const BASE = "https://api-m.sandbox.paypal.com";
const { PAYPAL_CLIENT_ID: id, PAYPAL_SECRET: secret, BUYER_EMAIL: buyer } = process.env;
if (!id || !secret) { console.log("Set PAYPAL_CLIENT_ID and PAYPAL_SECRET first"); process.exitCode = 1; throw new Error("missing env"); }

async function call(path, { method = "GET", body, token, form } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: token ? `Bearer ${token}` : "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"),
      "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json",
    },
    body: form ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  console.log(method, path, res.status);
  if (!res.ok) { console.log(JSON.stringify(json, null, 2)); throw new Error("API call failed"); }
  return json;
}

const tok = await call("/v1/oauth2/token", { method: "POST", form: "grant_type=client_credentials" });
console.log("Has invoicing scope listed:", String(tok.scope).toLowerCase().includes("invoic"));
const token = tok.access_token;

if (process.argv[2] === "check") {
  const inv = await call(`/v2/invoicing/invoices/${process.argv[3]}`, { token });
  console.log("STATUS:", inv.status);
  console.log("Payer link:", inv.detail?.metadata?.recipient_view_url);
} else {
  if (!buyer) { console.log("Set BUYER_EMAIL first"); throw new Error("missing env"); }
  const { invoice_number } = await call("/v2/invoicing/generate-next-invoice-number", { method: "POST", token });
  const created = await call("/v2/invoicing/invoices", {
    method: "POST", token,
    body: {
      detail: { invoice_number, currency_code: "USD", note: "T1 test" },
      primary_recipients: [{ billing_info: { email_address: buyer } }],
      items: [{ name: "Phase 2 deposit", quantity: "1", unit_amount: { currency_code: "USD", value: "500.00" } }],
    },
  });
  const invoiceId = created.href.split("/").pop();
  await call(`/v2/invoicing/invoices/${invoiceId}/send`, {
    method: "POST", token, body: { send_to_recipient: true, send_to_invoicer: false },
  });
  const inv = await call(`/v2/invoicing/invoices/${invoiceId}`, { token });
  console.log("\nINVOICE ID:", invoiceId);
  console.log("STATUS:", inv.status);
  console.log("Payer link:", inv.detail?.metadata?.recipient_view_url);
}