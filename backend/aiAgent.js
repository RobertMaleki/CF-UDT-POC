// backend/aiAgent.js
const WebSocket = require("ws");
const https = require("https");

// ======================= Config =======================
const OPENAI_REALTIME_MODEL = "gpt-4o-realtime-preview-2025-06-03";
const OPENAI_REALTIME_URL =
  `wss://api.openai.com/v1/realtime?model=${OPENAI_REALTIME_MODEL}`;
const OPENAI_HEADERS = {
  Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  "OpenAI-Beta": "realtime=v1",
  ...(process.env.OPENAI_ORG ? { "OpenAI-Organization": process.env.OPENAI_ORG } : {}),
};

const SYSTEM_PROMPT = `
You are a friendly, upbeat Crunch Fitness outbound agent.
Mission: book a time for the caller to come in and redeem a free trial pass this week.
- Greet warmly and confirm you're calling from Crunch Fitness about a free trial pass.
- Ask about their goal (lose weight, strength, classes).
- Offer two specific visit windows (e.g., "today 6–8pm" or "tomorrow 7–9am").
- Handle objections concisely and positively.
- Confirm day/time, repeat back, and close warmly.
Keep responses under ~10 seconds and avoid long monologues.
`;

// ================= Diagnostics helpers =================
function probeOpenAIModels(apiKey) {
  return new Promise((resolve) => {
    const req = https.request(
      {
        method: "GET",
        host: "api.openai.com",
        path: "/v1/models",
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 8000,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c.toString()));
        res.on("end", () => {
          console.log("[diag] GET /v1/models ->", res.statusCode, body.slice(0, 200));
          resolve({ status: res.statusCode, body });
        });
      }
    );
    req.on("error", (e) => {
      console.error("[diag] models probe error:", e.message);
      resolve(null);
    });
    req.end();
  });
}

// =================== Audio helpers =====================
// μ-law <-> PCM16 (for test tone generation only)
const BIAS = 0x84, SIGN_BIT = 0x80, QUANT_MASK = 0x0F, SEG_MASK = 0x70;
function pcm16ToMulaw(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > 32635) sample = 32635;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  let mu = ~(sign | (exponent << 4) | mantissa);
  return mu & 0xff;
}

function generateToneMuLawB64({ freq = 440, ms = 2000, sampleRate = 8000, amplitude = 6000 }) {
  const total = Math.floor((ms / 1000) * sampleRate);
  const ulaw = Buffer.alloc(total);
  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    const s = Math.floor(amplitude * Math.sin(2 * Math.PI * freq * t));
    ulaw[i] = pcm16ToMulaw(s);
  }
  return ulaw.toString("base64");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Pace μ-law bytes to Twilio as ~20ms frames (160 bytes @ 8kHz). */
async function sendULawB64Paced(twilioWS, streamSid, ulawB64, frameBytes = 160, frameMs = 20) {
  const buf = Buffer.from(ulawB64, "base64");
  let sent = 0;
  for (let i = 0; i < buf.length; i += frameBytes) {
    const slice = buf.subarray(i, i + frameBytes);
    const payload = slice.toString("base64");
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

// =================== Bridge attach =====================
function attach(server) {
  const wss = new WebSocket.Server({
    server,
    path: "/media-stream",
    clientTracking: true,
    perMessageDeflate: false,
    maxPayload: 1024 * 1024,
  });
  console.log("[media] WebSocket server ready at /media-stream");

  // Make handler async so we can await append -> commit safely
  wss.on("connection", async (twilioWS, req) => {
    console.log("[media] Twilio WS connected. UA:", req.headers["user-agent"] || "n/a");

    let streamSid = null;

    // ---- OpenAI Realtime ----
    let openaiWS = null;
    let openaiReady = false;
    let responseInFlight = false;
    let firstResponseRequested = false;

    // Inbound μ-law accumulation: ≥100ms = 800 bytes @ 8kHz
    const APPEND_ULAW_BYTES = 800;
    let ulawChunks = [];
    let ulawBytesAccum = 0;

    if (!process.env.OPENAI_API_KEY) {
      console.warn("[realtime] OPENAI_API_KEY not set — skipping OpenAI bridge");
    } else {
      console.log("[realtime] connecting to:", OPENAI_REALTIME_URL);
      await probeOpenAIModels(process.env.OPENAI_API_KEY);

      openaiWS = new WebSocket(OPENAI_REALTIME_URL, {
        headers: OPENAI_HEADERS,
        handshakeTimeout: 15000,
        perMessageDeflate: false,
      });

      openaiWS.on("unexpected-response", (req2, res) => {
        let body = "";
        res.on("data", (c) => (body += c.toString()));
        res.on("end", () => {
          console.error("[realtime] unexpected-response", {
            status: res.statusCode,
            headers: res.headers,
            body: body.slice(0, 500),
          });
        });
      });

      openaiWS.on("open", () => {
        console.log("[realtime] OpenAI WS open");
        openaiReady = true;
        // Configure the session for μ-law in/out (8 kHz)
        openaiWS.send(JSON.stringify({
          type: "session.update",
          session: {
            instructions: SYSTEM_PROMPT,
            voice: "alloy",
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",
          },
        }));
      });

      openaiWS.on("close", (code, reasonBuf) => {
        const reason = reasonBuf?.toString() || "";
        console.error("[realtime] WS closed", { code, reason });
      });

      openaiWS.on("error", (err) => {
        console.error("[realtime] WS error:", err?.message || err);
      });

      // Handle Realtime events; stream μ-law deltas straight to Twilio
      let audioDeltaCount = 0;
      openaiWS.on("message", async (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type !== "response.audio.delta") {
          console.log("[realtime] evt:", msg.type, (msg.error ? JSON.stringify(msg.error) : ""));
        }

        if (msg.type === "response.created") { responseInFlight = true; }
        else if (msg.type === "response.completed") { responseInFlight = false; }
        else if (msg.type === "response.error") { responseInFlight = false; }

        if (msg.type === "response.audio.delta" && msg.audio && streamSid) {
          audioDeltaCount++;
          if (audioDeltaCount % 10 === 1) {
            console.log("[realtime] audio.delta frames so far:", audioDeltaCount);
          }
          // Model output is already μ-law base64 (8 kHz)
          await sendULawB64Paced(twilioWS, streamSid, msg.audio, 160, 20);
        }
      });
    }

    // Keepalive pings
    const pingInterval = setInterval(() => {
      try { twilioWS.ping(); } catch {}
      try { openaiWS?.ping(); } catch {}
    }, 15000);

    // ---- Twilio events ----
    twilioWS.on("message", async (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (!msg.event) { console.log("[twilio] unknown frame", raw.toString().slice(0, 200)); return; }
      if (!["start", "media", "stop", "connected", "mark"].includes(msg.event)) {
        console.log(`[twilio] event=${msg.event}`, JSON.stringify(msg).slice(0, 300));
      }

      switch (msg.event) {
        case "start": {
          streamSid = msg.start?.streamSid;
          console.log("[twilio] stream start callSid:", msg.start?.callSid, "streamSid:", streamSid);

          // 2s tone to prove downlink (μ-law already)
          try {
            const toneB64 = generateToneMuLawB64({ freq: 440, ms: 2000, sampleRate: 8000 });
            await sendULawB64Paced(twilioWS, streamSid, toneB64, 160, 20);
            console.log("[twilio] sent 2s test tone (μ-law paced)");
          } catch (e) {
            console.error("[twilio] test tone error:", e?.message || e);
          }
          break;
        }

        case "media": {
          // Inbound flow debug (every 25 frames)
          if (!twilioWS._frameCount) twilioWS._frameCount = 0;
          if (++twilioWS._frameCount % 25 === 0) {
            console.log("[twilio] inbound media frames:", twilioWS._frameCount);
          }

          // If OpenAI isn't ready/open, skip
          if (!(openaiReady && openaiWS?.readyState === WebSocket.OPEN)) {
            return;
          }

          // Accumulate μ-law bytes; each Twilio payload is ~160 bytes (~20ms)
          const chunk = Buffer.from(msg.media.payload, "base64");
          ulawChunks.push(chunk);
          ulawBytesAccum += chunk.length;

          // Once ≥100 ms accumulated, append → commit (with small ingest delay)
          if (ulawBytesAccum >= APPEND_ULAW_BYTES && !responseInFlight) {
            const combined = Buffer.concat(ulawChunks, ulawBytesAccum);
            ulawChunks = [];
            ulawBytesAccum = 0;

            const b64 = combined.toString("base64");
            console.log("[realtime] appending μ-law bytes:", combined.length, "(~100ms)");

            // Await send to avoid racing the commit
            await new Promise((resolve, reject) => {
              openaiWS.send(JSON.stringify({
                type: "input_audio_buffer.append",
                audio: b64
              }), (err) => err ? reject(err) : resolve());
            });

            // tiny ingest cushion
            await sleep(90);

            console.log("[realtime] committing input buffer");
            openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

            // Trigger the first spoken response after the first commit
            if (!firstResponseRequested) {
              setTimeout(() => {
                if (openaiWS.readyState === WebSocket.OPEN && !responseInFlight) {
                  openaiWS.send(JSON.stringify({
                    type: "response.create",
                    response: { modalities: ["audio","text"] }
                  }));
                  firstResponseRequested = true;
                  responseInFlight = true;
                  console.log("[realtime] requested first spoken response");
                }
              }, 140);
            }
          }
          break;
        }

        case "stop":
          console.log("[twilio] stream stop");
          try { openaiWS?.close(); } catch {}
          break;
      }
    });

    twilioWS.on("close", () => {
      console.log("[twilio] WS closed");
      clearInterval(pingInterval);
      try { openaiWS?.close(); } catch {}
    });
    twilioWS.on("error", (err) => console.error("[twilio] WS error:", err?.message || err));
  });
}

module.exports = { attach };
