const BASE = "https://api-m.sandbox.paypal.com";
const { PAYPAL_CLIENT_ID: id, PAYPAL_SECRET: secret } = process.env;

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

async function main() {
  if (!id || !secret) throw new Error("Set PAYPAL_CLIENT_ID and PAYPAL_SECRET first");
  const [mode = "create", orderId] = process.argv.slice(2);
  const { access_token: token } = await call("/v1/oauth2/token", { method: "POST", form: "grant_type=client_credentials" });

  if (mode === "create") {
    const order = await call("/v2/checkout/orders", {
      method: "POST", token,
      body: {
        intent: "CAPTURE",
        payment_source: {
          paypal: {
            experience_context: {
              shipping_preference: "NO_SHIPPING",
              user_action: "PAY_NOW",
              return_url: "https://example.com/return",
              cancel_url: "https://example.com/cancel",
            },
          },
        },
        purchase_units: [{
          reference_id: "phase2-deposit",
          custom_id: "milestone-phase2",
          description: "Phase 2 deposit",
          amount: { currency_code: "USD", value: "500.00" },
        }],
      },
    });
    const link = order.links?.find(l => l.rel === "payer-action" || l.rel === "approve")?.href
      ?? `https://www.sandbox.paypal.com/checkoutnow?token=${order.id}`;
    console.log("\nORDER ID:", order.id);
    console.log("STATUS:", order.status);
    console.log("PAY LINK:", link);
  } else if (mode === "capture") {
    const cap = await call(`/v2/checkout/orders/${orderId}/capture`, { method: "POST", token });
    console.log("\nSTATUS:", cap.status);
    console.log("custom_id:", cap.purchase_units?.[0]?.payments?.captures?.[0]?.custom_id);
  } else if (mode === "check") {
    const o = await call(`/v2/checkout/orders/${orderId}`, { token });
    console.log("\nSTATUS:", o.status);
  }
}
main().catch(e => { console.log("ERROR:", e.message); process.exitCode = 1; });