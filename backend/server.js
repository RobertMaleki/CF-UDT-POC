// backend/server.js
const path = require("path");
const express = require("express");
const dotenv = require("dotenv");
const twilio = require("twilio");

dotenv.config();

const app = express();
app.use(express.json());

// --- Serve the frontend at "/" ---
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
app.use(express.static(FRONTEND_DIR));           // serve /frontend assets
app.get("/", (_req, res) => {                    // root → index.html
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

// --- Health check ---
app.get("/health", (_req, res) => res.json({ ok: true }));

// --- Outbound call trigger ---
const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

app.post("/api/start-call", async (req, res) => {
  try {
    const { name, phone } = req.body;
    if (!name || !phone) return res.status(400).json({ error: "Missing name or phone" });

    // POC TwiML (we’ll swap to Realtime AI later)
    const twiml = `<Response>
      <Say voice="alice">Hi ${name}. This is Crunch Fitness. We'd love to get you in for a free trial pass. Have a great day!</Say>
    </Response>`;

    await client.calls.create({
      to: phone,
      from: process.env.TWILIO_NUMBER, // e.g. +15551234567
      twiml
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("Error starting call:", err);
    res.status(500).json({ error: err.message });
  }
});

// --- Fallback: send index.html for any other path (nice for simple routing) ---
app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running → http://localhost:${PORT}`);
});
