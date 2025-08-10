// backend/server.js
const path = require("path");
const http = require("http");
const express = require("express");
const dotenv = require("dotenv");
const twilio = require("twilio");
dotenv.config();

const app = express();
app.use(express.json());

// --- Serve the frontend at "/" ---
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
app.use(express.static(FRONTEND_DIR));
app.get("/", (_req, res) => res.sendFile(path.join(FRONTEND_DIR, "index.html")));

// --- Health check ---
app.get("/health", (_req, res) => res.json({ ok: true }));

// --- Twilio Client ---
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// --- TwiML that connects the phone call to our WebSocket media stream ---
app.post("/twiml", (req, res) => {
  const wsUrl = (process.env.PUBLIC_BASE_URL || "").replace(/^http/, "ws") + "/media-stream";
  const twiml = `
    <Response>
      <Connect>
        <Stream url="${wsUrl}" track="both_tracks" />
      </Connect>
    </Response>`;
  res.type("text/xml").send(twiml.trim());
});

// --- Outbound call trigger: now points to our /twiml ---
app.post("/api/start-call", async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name || !phone) return res.status(400).json({ error: "Missing name or phone" });

    // You can pass metadata to your WS via Stream 'params' if needed (e.g., name)
    const twimlUrl = (process.env.PUBLIC_BASE_URL || "") + "/twiml";

    await client.calls.create({
      to: phone,
      from: process.env.TWILIO_NUMBER, // E.164
      url: twimlUrl, // Twilio will fetch this and connect the call to our WS stream
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Error starting call:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Fallback to index.html ---
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

// --- Start HTTP server and attach the media bridge (WebSocket) ---
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`Server running → http://localhost:${PORT}`);
});

require("./aiAgent").attach(server);
