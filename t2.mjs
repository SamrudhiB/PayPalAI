import http from "node:http";
const { PAYPAL_CLIENT_ID: id, PAYPAL_SECRET: secret, WEBHOOK_ID } = process.env;
const BASE = "https://api-m.sandbox.paypal.com";

async function verify(h, event) {
  const tokRes = await fetch(BASE + "/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from(`${id}:${secret}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const { access_token } = await tokRes.json();
  const res = await fetch(BASE + "/v1/notifications/verify-webhook-signature", {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      auth_algo: h["paypal-auth-algo"],
      cert_url: h["paypal-cert-url"],
      transmission_id: h["paypal-transmission-id"],
      transmission_sig: h["paypal-transmission-sig"],
      transmission_time: h["paypal-transmission-time"],
      webhook_id: WEBHOOK_ID,
      webhook_event: event,
    }),
  });
  return (await res.json()).verification_status;
}

http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    console.log("\n" + new Date().toISOString(), req.method, req.url);
    if (req.method === "POST" && req.url === "/webhook") {
      try {
        const event = JSON.parse(raw);
        console.log("EVENT:", event.event_type);
        console.log("custom_id:", event.resource?.custom_id, "| amount:", event.resource?.amount?.value);
        console.log("SIGNATURE:", WEBHOOK_ID ? await verify(req.headers, event) : "(WEBHOOK_ID not set, skipping)");
      } catch (e) { console.log("error:", e.message); }
    }
    res.writeHead(200); res.end("ok");
  });
}).listen(3000, () => console.log("listening on port 3000"));