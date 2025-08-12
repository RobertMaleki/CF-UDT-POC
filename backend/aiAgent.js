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
const BIAS = 0x84, SIGN_BIT = 0x80, QUANT_MASK = 0x0F, SEG_MASK = 0x70;

function mulawToPcm16(uVal) {
  uVal = ~uVal & 0xff;
  let t = ((uVal & QUANT_MASK) << 3) + BIAS;
  t <<= ((uVal & SEG_MASK) >> 4);
  return (uVal & SIGN_BIT) ? (BIAS - t) : (t - BIAS);
}
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

const b64ToBuf = (b64) => Buffer.from(b64, "base64");
function int16ToBase64LE(int16Array) {
  const buf = Buffer.allocUnsafe(int16Array.length * 2);
  for (let i = 0; i < int16Array.length; i++) buf.writeInt16LE(int16Array[i], i * 2);
  return buf.toString("base64");
}
function pcm16ToMuLawB64(int16) {
  const mu = Buffer.alloc(int16.length);
  for (let i = 0; i < int16.length; i++) mu[i] = pcm16ToMulaw(int16[i]);
  return mu.toString("base64");
}

function upsampleTo16k(pcm8k) {
  // Simple 2x upsample: linear interpolation for intelligible speech
  const out = new Int16Array(pcm8k.length * 2);
  for (let i = 0, j = 0; i < pcm8k.length; i++, j += 2) {
    const a = pcm8k[i];
    const b = (i + 1 < pcm8k.length) ? pcm8k[i + 1] : a;
    out[j] = a;
    out[j + 1] = (a + b) >> 1;
  }
  return out;
}

function applyGain(int16, gain = 1.6) {
  for (let i = 0; i < int16.length; i++) {
    const v = int16[i] * gain;
    int16[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v | 0;
  }
  return int16;
}

function downsample16kTo8k(pcm16k) {
  // Simple 2:1 downsample (average pairs). Good enough for phone audio.
  const out = new Int16Array(Math.floor(pcm16k.length / 2));
  for (let i = 0, j = 0; j < out.length; i += 2, j++) {
    const a = pcm16k[i];
    const b = pcm16k[i + 1] ?? a;
    out[j] = (a + b) >> 1;
  }
  return out;
}

function generateTonePCM16({ freq = 440, ms = 2000, sampleRate = 8000, amplitude = 6000 }) {
  const total = Math.floor((ms / 1000) * sampleRate);
  const pcm = new Int16Array(total);
  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    pcm[i] = Math.floor(amplitude * Math.sin(2 * Math.PI * freq * t));
  }
  return pcm;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Send PCM16 (8kHz) to Twilio as paced μ-law frames (~20ms each). */
async function sendPCM16AsPacedUlawFrames(twilioWS, streamSid, pcm16, frameSamples = 160, frameMs = 20) {
  let sent = 0;
  for (let i = 0; i < pcm16.length; i += frameSamples) {
    const chunk = pcm16.subarray(i, i + frameSamples);
    const payload = pcm16ToMuLawB64(chunk);
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

/*
// Binary append helper (PCM16 LE @ 16 kHz, mono)
function sendBinaryPcm16ToOpenAI(ws, pcm16le) {
  const header = Buffer.from("Content-Type: audio/pcm;rate=16000;channels=1\r\n\r\n");
  const payload = Buffer.allocUnsafe(pcm16le.length * 2);
  for (let i = 0; i < pcm16le.length; i++) payload.writeInt16LE(pcm16le[i], i * 2);
  const frame = Buffer.concat([header, payload]);
  return new Promise((resolve, reject) => {
    ws.send(frame, { binary: true }, (err) => (err ? reject(err) : resolve()));
  });
}
*/

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

  // Make the handler async so we can await append -> commit safely
  wss.on("connection", async (twilioWS, req) => {
    console.log("[media] Twilio WS connected. UA:", req.headers["user-agent"] || "n/a");

    let streamSid = null;

    // ---- OpenAI Realtime ----
    let openaiWS = null;
    let openaiReady = false;
    let responseInFlight = false;
    let firstResponseRequested = false;

    // Inbound batching as PCM16@16k — use 3200 (200ms) or bump to 6400 (400ms) if you want fewer commits
    const APPEND_SAMPLES_16K = 6400; // ~400ms @ 16k
    let pcm16kBatch = new Int16Array(0);

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
        openaiWS.send(JSON.stringify({
          type: "session.update",
          session: {
            instructions: SYSTEM_PROMPT,
            voice: "alloy",
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
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

        // === STREAM MODEL AUDIO BACK TO TWILIO ===
        if (msg.type === "response.audio.delta" && msg.audio && streamSid) {

          audioDeltaCount++;
          if (audioDeltaCount % 10 === 1) {
            console.log("[realtime] audio.delta frames so far:", audioDeltaCount);
          }

          // Model sends PCM16 @ 16kHz base64
          const buf = Buffer.from(msg.audio, "base64");
          const pcm16k = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);

          // Downsample to 8k for Twilio, then add a modest gain
          let pcm8k = downsample16kTo8k(pcm16k);
          pcm8k = applyGain(pcm8k, 1.6);
          //const pcm8k = downsample16kTo8k(pcm16k);

          // Optional: small gain boost for intelligibility (keep under 1.5x to avoid clipping)
          // for (let i = 0; i < pcm8k.length; i++) pcm8k[i] = Math.max(-32768, Math.min(32767, (pcm8k[i] * 1.2)|0));

          await sendPCM16AsPacedUlawFrames(twilioWS, streamSid, pcm8k, 160, 20);
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
      if (!["start", "media", "stop"].includes(msg.event)) {
        console.log(`[twilio] event=${msg.event}`, JSON.stringify(msg).slice(0, 300));
      }

      switch (msg.event) {
        case "start": {
          streamSid = msg.start?.streamSid;
          console.log("[twilio] stream start callSid:", msg.start?.callSid, "streamSid:", streamSid);

          // 2s tone (paced) to prove downlink
          try {
            const tone = generateTonePCM16({ freq: 440, ms: 2000, sampleRate: 8000 });
            await sendPCM16AsPacedUlawFrames(twilioWS, streamSid, tone, 160, 20);
            console.log("[twilio] sent 2s test tone (paced minimal frames)");
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

          // If OpenAI isn't ready/open, just skip (no echo mode)
          if (!(openaiReady && openaiWS?.readyState === WebSocket.OPEN)) {
            return;
          }

          // Twilio frame: μ-law 8k (~20ms, 160 bytes) -> PCM16 8k
          const ulaw = Buffer.from(msg.media.payload, "base64");
          const pcm8k = new Int16Array(ulaw.length);
          for (let i = 0; i < ulaw.length; i++) pcm8k[i] = mulawToPcm16(ulaw[i]);

          // Upsample 8k -> 16k
          const pcm16k = upsampleTo16k(pcm8k);

          // Accumulate to ~200ms at 16k => 3200 samples
          const merged = new Int16Array(pcm16kBatch.length + pcm16k.length);
          merged.set(pcm16kBatch, 0);
          merged.set(pcm16k, pcm16kBatch.length);
          pcm16kBatch = merged;

          if (pcm16kBatch.length >= APPEND_SAMPLES_16K && !responseInFlight) {
            const slice = pcm16kBatch.subarray(0, APPEND_SAMPLES_16K);
            const remain = pcm16kBatch.subarray(APPEND_SAMPLES_16K);
            pcm16kBatch = new Int16Array(remain.length);
            pcm16kBatch.set(remain, 0);

            // Convert Int16Array -> base64 (little-endian)
            const buf = Buffer.allocUnsafe(slice.length * 2);
            for (let i = 0; i < slice.length; i++) buf.writeInt16LE(slice[i], i * 2);
            const b64 = buf.toString("base64");

            console.log("[realtime] appending PCM16@16k JSON:", slice.length, "samples (~400ms)");

            // await ws.send via a Promise
            await new Promise((resolve, reject) => {
              openaiWS.send(JSON.stringify({
                type: "input_audio_buffer.append",
                audio: b64
              }), (err) => err ? reject(err) : resolve());
            });

            // small ingest cushion
            await new Promise(r => setTimeout(r, 120));

            console.log("[realtime] committing input buffer");
            openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

            if (!firstResponseRequested) {
              setTimeout(() => {
                if (openaiWS.readyState === WebSocket.OPEN && !responseInFlight) {
                  openaiWS.send(JSON.stringify({
                    type: "response.create",
                    response: { modalities: ["audio", "text"], audio: {voice: "alloy", format: "pcm16"} }
                  }));
                  firstResponseRequested = true;
                  responseInFlight = true;
                  console.log("[realtime] requested first spoken response");
                }
              }, 150);
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
