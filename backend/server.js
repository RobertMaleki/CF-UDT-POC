// backend/server.js
const path = require("path");
const http = require("http");
const express = require("express");
const dotenv = require("dotenv");
const twilio = require("twilio");

dotenv.config();

const app = express();
app.use(express.json());

// ---- Basic request logger (simple and useful for Render logs) ----
app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.url}`);
  next();
});

// ---- Serve the frontend at "/" ----
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
app.use(express.static(FRONTEND_DIR));
app.get("/", (_req, res) => res.sendFile(path.join(FRONTEND_DIR, "index.html")));

// ---- Health check ----
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---- Twilio Client ----
const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER, PUBLIC_BASE_URL } = process.env;
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_NUMBER) {
  console.warn("[env] Missing one or more Twilio vars: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER");
}
if (!PUBLIC_BASE_URL) {
  console.warn("[env] Missing PUBLIC_BASE_URL (e.g., https://your-app.onrender.com)");
}
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Allow GET or POST for Twilio fetch
app.all("/twiml", (req, res) => {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (!base) return res.status(500).type("text/plain").send("PUBLIC_BASE_URL not set");

  const wsUrl = base.replace(/^http/, "ws") + "/media-stream";
  console.log(`[/twiml] method=${req.method} ua=${req.headers["user-agent"] || "n/a"} wsUrl=${wsUrl}`);

  // Bidirectional stream: <Connect><Stream>. Keep a short <Say> BEFORE connect.
  const twiml = `
    <Response>
      <Say voice="alice">Thanks for taking our demo call. Connecting you now.</Say>
      <Connect>
        <Stream url="${wsUrl}" />
      </Connect>
    </Response>
  `.trim();

  res.type("text/xml").send(twiml);
});


// ---- Outbound call trigger: points Twilio to our /twiml URL ----
app.post("/api/start-call", async (req, res) => {
  try {
    const { name, phone } = req.body || {};
    if (!name || !phone) {
      console.warn("[start-call] 400 missing params:", { name, phone });
      return res.status(400).json({ error: "Missing name or phone" });
    }

    const base = (PUBLIC_BASE_URL || "").replace(/\/+$/, "");
    if (!base) {
      console.error("[start-call] PUBLIC_BASE_URL not set");
      return res.status(500).json({ error: "Server misconfigured: PUBLIC_BASE_URL not set" });
    }

    const twimlUrl = `${base}/twiml`;
    console.log(`[start-call] name="${name}" phone="${phone}" from=${TWILIO_NUMBER} twimlUrl=${twimlUrl}`);

    const call = await client.calls.create({
      to: phone,
      from: TWILIO_NUMBER,  // E.164, voice-enabled Twilio number
      url: twimlUrl,
      method: "GET"         // be explicit; our /twiml accepts GET or POST
    });

    console.log("[start-call] call created sid:", call.sid);
    res.json({ ok: true, sid: call.sid });
  } catch (err) {
    // Twilio errors often include more detail in 'err.code' and 'err.moreInfo'
    console.error("[start-call] ERROR:", {
      message: err.message,
      code: err.code,
      moreInfo: err.moreInfo
    });
    res.status(500).json({ error: err.message || "Call failed" });
  }
});

// ---- Fallback: send index.html for any other path (Express 5-safe) ----
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

// ---- Start HTTP server and attach the media bridge (WebSocket) ----
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);

// Log every WS upgrade attempt and path
server.on("upgrade", (req, socket) => {
  console.log(`[upgrade] ${req.method} ${req.url} origin=${req.headers.origin || "n/a"}`);
});

server.listen(PORT, () => {
  console.log(`Server running → http://localhost:${PORT}`);
  console.log(`[env] PUBLIC_BASE_URL=${PUBLIC_BASE_URL || "(unset)"}`);
});

// Attach the Twilio <-> OpenAI Realtime bridge
require("./aiAgent").attach(server);

// ---- Last-resort error handler (logs unhandled exceptions in routes) ----
app.use((err, _req, res, _next) => {
  console.error("[express] Unhandled error:", err);
  res.status(500).json({ error: "Internal Server Error" });
});
