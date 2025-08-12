// backend/server.js
// Fastify + Twilio Media Streams + OpenAI Realtime (G.711 µ-law @ 8kHz)
// Keeps your existing frontend (served at "/") and /api/start-call endpoint.

const path = require("path");
const fs = require("fs");
const Fastify = require("fastify");
const fastifyFormBody = require("@fastify/formbody");
const fastifyWs = require("@fastify/websocket");
const fastifyStatic = require("@fastify/static");
const WebSocket = require("ws");
const twilio = require("twilio");
const dotenv = require("dotenv");
dotenv.config();

// ---- Env ----
const {
  OPENAI_API_KEY,
  OPENAI_ORG,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  PUBLIC_BASE_URL,
  PORT = 3000
} = process.env;

if (!OPENAI_API_KEY) console.warn("[env] OPENAI_API_KEY missing");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) console.warn("[env] Twilio creds missing");
if (!TWILIO_NUMBER) console.warn("[env] TWILIO_NUMBER missing");
if (!PUBLIC_BASE_URL) console.warn("[env] PUBLIC_BASE_URL missing");

// ---- Twilio client ----
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ---- OpenAI Realtime config ----
const OPENAI_REALTIME_MODEL = "gpt-4o-realtime-preview-2025-06-03";
const OPENAI_REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_MODEL}`;
const OPENAI_HEADERS = {
  Authorization: `Bearer ${OPENAI_API_KEY}`,
  "OpenAI-Beta": "realtime=v1",
  ...(OPENAI_ORG ? { "OpenAI-Organization": OPENAI_ORG } : {})
};

// ---- Agent system prompt ----
const SYSTEM_MESSAGE = `
You are a friendly, upbeat Crunch Fitness outbound agent.
Mission: book a time for the caller to come in and redeem a free trial pass this week.
- Greet warmly and confirm you're calling from Crunch Fitness about a free trial pass.
- Ask about their goal (lose weight, strength, classes).
- Offer two specific visit windows (e.g., "today 6–8pm" or "tomorrow 7–9am").
- Handle objections concisely and positively.
- Confirm day/time, repeat back, and close warmly.
Keep responses under ~10 seconds and avoid long monologues.
`;

// ---- App ----
const app = Fastify({ logger: false });
app.register(fastifyFormBody);
app.register(fastifyWs);

// Serve frontend
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
app.register(fastifyStatic, { root: FRONTEND_DIR, prefix: "/" });
app.get("/", async (_req, reply) => {
  const file = path.join(FRONTEND_DIR, "index.html");
  reply.type("text/html").send(fs.readFileSync(file, "utf8"));
});

// Health
app.get("/health", async () => ({ ok: true }));

// Outbound call trigger (keeps your existing frontend flow)
app.post("/api/start-call", async (req, reply) => {
  try {
    const { name, phone } = req.body || {};
    if (!name || !phone) return reply.code(400).send({ error: "Missing name or phone" });

    const twimlUrl = `${PUBLIC_BASE_URL}/incoming-call`;
    const call = await client.calls.create({
      to: phone,
      from: TWILIO_NUMBER,
      url: twimlUrl // Twilio fetches TwiML here -> Connect Stream to our WS
    });

    console.log("[start-call] created:", call.sid, "to:", phone);
    reply.send({ ok: true, sid: call.sid });
  } catch (err) {
    console.error("[start-call] error:", err?.message || err);
    reply.code(500).send({ error: err.message });
  }
});

// TwiML entrypoint used by Twilio during the call
app.all("/incoming-call", async (req, reply) => {
  // compute wss URL
  // prefer PUBLIC_BASE_URL; fallback to Host header
  const base = PUBLIC_BASE_URL || (`https://${req.headers.host}`);
  const wsUrl = base.replace(/^http/, "ws") + "/media-stream";

  const twiml =
    `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Thanks for taking the call. One moment while I connect our assistant.</Say>
  <Pause length="1"/>
  <Connect>
    <Stream url="${wsUrl}"/>
  </Connect>
</Response>`;

  reply.type("text/xml").send(twiml);
});

// ---- Media Stream bridge (Twilio <-> OpenAI Realtime) ----
// Pace μ-law bytes to Twilio as 20ms frames (160 bytes @ 8kHz)
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function sendULawB64Paced(twilioWS, streamSid, ulawB64, frameBytes = 160, frameMs = 20) {
  const buf = Buffer.from(ulawB64, "base64");
  let sent = 0;
  for (let i = 0; i < buf.length; i += frameBytes) {
    const payload = buf.subarray(i, i + frameBytes).toString("base64");
    try {
      twilioWS.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
      sent++;
      if (sent % 25 === 0) console.log("[twilio] sent outbound frames:", sent);
    } catch (e) {
      console.error("[twilio] send error:", e?.message || e);
      break;
    }
    await sleep(frameMs);
  }
  if (sent > 0) console.log("[twilio] finished sending frames:", sent);
}

app.register(async function (instance) {
  instance.get("/media-stream", { websocket: true }, (twilioWS, req) => {
    console.log("[media] Twilio WS connected. UA:", req.headers["user-agent"] || "n/a");

    // OpenAI realtime WS
    const openaiWS = new WebSocket(OPENAI_REALTIME_URL, {
      headers: OPENAI_HEADERS,
      perMessageDeflate: false,
      handshakeTimeout: 15000
    });

    let streamSid = null;
    let responseInFlight = false;
    let firstResponseRequested = false;

    // Buffer Twilio μ-law chunks (≥100ms = 800 bytes) before append+commit
    let ulawChunks = [];
    let ulawBytes = 0;

    openaiWS.on("unexpected-response", (req2, res) => {
      let body = "";
      res.on("data", c => body += c.toString());
      res.on("end", () => {
        console.error("[realtime] unexpected-response", { status: res.statusCode, body: body.slice(0, 500) });
      });
    });

    openaiWS.on("open", () => {
      console.log("[realtime] OpenAI WS open");
      // Configure session for µ-law both directions; enable server VAD for snappier turns
      openaiWS.send(JSON.stringify({
        type: "session.update",
        session: {
          instructions: SYSTEM_MESSAGE,
          voice: "alloy",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          modalities: ["audio", "text"],
          turn_detection: { type: "server_vad" }
        }
      }));

      // Optional: initial greeting right away (so you hear voice even before you speak)
      openaiWS.send(JSON.stringify({
        type: "response.create",
        response: { modalities: ["audio", "text"] }
      }));
      responseInFlight = true;
      firstResponseRequested = true;
    });

    openaiWS.on("message", async (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type !== "response.audio.delta") {
        console.log("[realtime] evt:", msg.type, (msg.error ? JSON.stringify(msg.error) : ""));
      }

      if (msg.type === "response.created") responseInFlight = true;
      if (msg.type === "response.completed" || msg.type === "response.error") responseInFlight = false;

      if (msg.type === "response.audio.delta" && msg.audio && streamSid) {
        await sendULawB64Paced(twilioWS, streamSid, msg.audio, 160, 20);
      }
    });

    openaiWS.on("close", (code, reasonBuf) => {
      const reason = reasonBuf?.toString() || "";
      console.error("[realtime] WS closed", { code, reason });
      try { twilioWS.close(); } catch {}
    });

    openaiWS.on("error", (err) => {
      console.error("[realtime] WS error:", err?.message || err);
    });

    // Twilio -> OpenAI
    twilioWS.on("message", async (raw) => {
      let frame; try { frame = JSON.parse(raw.toString()); } catch { return; }

      switch (frame.event) {
        case "start":
          streamSid = frame.start?.streamSid;
          console.log("[twilio] stream start callSid:", frame.start?.callSid, "streamSid:", streamSid);
          break;

        case "media": {
          const chunk = Buffer.from(frame.media.payload, "base64");
          ulawChunks.push(chunk);
          ulawBytes += chunk.length;

          // when we have ≥100ms of audio, append→commit
          if (ulawBytes >= 800 && openaiWS.readyState === WebSocket.OPEN) {
            const combined = Buffer.concat(ulawChunks, ulawBytes);
            ulawChunks = []; ulawBytes = 0;

            const b64 = combined.toString("base64");
            // append (await send callback)
            await new Promise((res, rej) =>
              openaiWS.send(JSON.stringify({ type: "input_audio_buffer.append", audio: b64 }), (e) => e ? rej(e) : res())
            );

            // brief ingest cushion
            await new Promise(r => setTimeout(r, 90));

            // commit
            openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

            // If we didn't send an initial greeting, trigger first response after first commit
            if (!firstResponseRequested && !responseInFlight) {
              openaiWS.send(JSON.stringify({ type: "response.create", response: { modalities: ["audio", "text"] } }));
              firstResponseRequested = true;
              responseInFlight = true;
              console.log("[realtime] requested first spoken response");
            }
          }
          break;
        }

        case "stop":
          console.log("[twilio] stream stop");
          try { openaiWS.close(); } catch {}
          break;
      }
    });

    twilioWS.on("close", () => {
      console.log("[twilio] WS closed");
      try { openaiWS.close(); } catch {}
    });

    twilioWS.on("error", (err) => {
      console.error("[twilio] WS error:", err?.message || err);
      try { openaiWS.close(); } catch {}
    });
  });
});

// ---- Start server ----
app.listen({ port: Number(PORT), host: "0.0.0.0" })
  .then(() => console.log(`Fastify server → http://localhost:${PORT}`))
  .catch((e) => { console.error("Server failed:", e); process.exit(1); });
