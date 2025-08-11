// backend/aiAgent.js
const WebSocket = require("ws");

// ==== OpenAI Realtime WS config ====
const OPENAI_REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
const OPENAI_HEADERS = {
  Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  "OpenAI-Beta": "realtime=v1",
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

//const ECHO_TEST = process.env.ECHO_TEST === "false"; // optional toggle

// ============ μ-law <-> PCM16 helpers ============
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

// ============ Tone + pacing ============
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
  for (let i = 0; i < pcm16.length; i += frameSamples) {
    const chunk = pcm16.subarray(i, i + frameSamples);
    const payload = pcm16ToMuLawB64(chunk);
    try {
      twilioWS.send(JSON.stringify({ event: "media", streamSid, media: { payload } }));
    } catch (e) {
      console.error("[twilio] send error:", e?.message || e);
      break;
    }
    await sleep(frameMs);
  }
}

// === 8Khz to 16KHz upsampling helper
function upsampleTo16k(pcm8k) {
  // Simple 2x upsample: duplicate/interpolate samples
  const out = new Int16Array(pcm8k.length * 2);
  for (let i = 0, j = 0; i < pcm8k.length; i++, j += 2) {
    const a = pcm8k[i];
    const b = (i + 1 < pcm8k.length) ? pcm8k[i + 1] : a;
    out[j] = a;
    out[j + 1] = (a + b) >> 1; // linear interp between a and next
  }
  return out;
}
function int16ToBase64LE(int16) {
  const buf = Buffer.allocUnsafe(int16.length * 2);
  for (let i = 0; i < int16.length; i++) buf.writeInt16LE(int16[i], i * 2);
  return buf.toString("base64");
}


// ============ Attach Twilio <-> OpenAI bridge ============
function attach(server) {
  const wss = new WebSocket.Server({
    server,
    path: "/media-stream",
    clientTracking: true,
    perMessageDeflate: false,
    maxPayload: 1024 * 1024,
  });
  console.log("[media] WebSocket server ready at /media-stream");

  wss.on("connection", (twilioWS, req) => {
    console.log("[media] Twilio WS connected. UA:", req.headers["user-agent"] || "n/a");

    let streamSid = null;

    // ---- OpenAI Realtime ----
    let openaiWS = null;
    let openaiReady = false;
    let responseInFlight = false;
    let firstResponseRequested = false;

    // PCM16 accumulation for ≥200ms appends (200ms = 1600 samples @ 8k)
    const SAMPLE_RATE = 8000;
    const APPEND_SAMPLES = 1600; // 200ms
    let pcmBatch = new Int16Array(0);

    if (!process.env.OPENAI_API_KEY) {
      console.warn("[realtime] OPENAI_API_KEY not set — skipping OpenAI bridge (tone test only)");
    } else {
      const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
      console.log("[realtime] connecting to:", url);

        openaiWS = new WebSocket(url, {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=v1",
          },
          handshakeTimeout: 15000,
          perMessageDeflate: false,
        });

          // log why the handshake failed (status, headers, body snippet)
          openaiWS.on("unexpected-response", (req, res) => {
            let body = "";
            res.on("data", (c) => { body += c.toString(); if (body.length > 500) body = body.slice(0, 500) + "..."; });
            res.on("end", () => {
              console.error("[realtime] unexpected-response",
                { status: res.statusCode, headers: res.headers, body });
            });
          });

      openaiWS.on("open", () => {
        console.log("[realtime] OpenAI WS open");
        // Expect PCM16 input/output; we convert Twilio μ-law to PCM16 before appending
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

      // Log everything; stream audio deltas back to Twilio (paced)
      openaiWS.on("message", async (raw) => {
        let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

        if (msg.type !== "response.audio.delta") {
          console.log("[realtime] evt:", msg.type, (msg.error ? JSON.stringify(msg.error) : ""));
        }

        if (msg.type === "response.created") { responseInFlight = true; }
        else if (msg.type === "response.completed") { responseInFlight = false; }
        else if (msg.type === "response.error") { responseInFlight = false; }

        if (msg.type === "response.audio.delta" && msg.audio && streamSid) {
          const buf = Buffer.from(msg.audio, "base64");
          const pcm = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
          await sendPCM16AsPacedUlawFrames(twilioWS, streamSid, pcm, 160, 20);
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
            const tone = generateTonePCM16({ freq: 440, ms: 2000, sampleRate: SAMPLE_RATE });
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
          /*
          // ---- Echo fallback (only if OpenAI not ready or ECHO_TEST=true)
          if (ECHO_TEST || !openaiReady || openaiWS?.readyState !== WebSocket.OPEN) {
            // loop caller audio back ~real-time
            const ulaw = Buffer.from(msg.media.payload, "base64");
            // Convert to PCM16 to avoid transcoding drift, then right back to μ-law paced
            const pcm = new Int16Array(ulaw.length);
            for (let i = 0; i < ulaw.length; i++) pcm[i] = mulawToPcm16(ulaw[i]);
            await sendPCM16AsPacedUlawFrames(twilioWS, streamSid, pcm, 160, 20);
            return; // skip OpenAI path on this frame
          }
          */


          // === inside twilioWS.on("message") -> case "media":
          if (openaiReady && openaiWS?.readyState === WebSocket.OPEN) {
            // Twilio frame: μ-law 8k (~20ms, 160 bytes)
            const ulaw = Buffer.from(msg.media.payload, "base64");
            const pcm8k = new Int16Array(ulaw.length);
            for (let i = 0; i < ulaw.length; i++) pcm8k[i] = mulawToPcm16(ulaw[i]);

            // Upsample 8k -> 16k
            const pcm16k = upsampleTo16k(pcm8k);

            // Accumulate to ~200ms at 16k => 3200 samples
            if (!twilioWS._pcm16kBatch) twilioWS._pcm16kBatch = new Int16Array(0);
            const merged = new Int16Array(twilioWS._pcm16kBatch.length + pcm16k.length);
            merged.set(twilioWS._pcm16kBatch, 0);
            merged.set(pcm16k, twilioWS._pcm16kBatch.length);
            twilioWS._pcm16kBatch = merged;

            const APPEND_SAMPLES_16K = 3200; // ~200ms @ 16k
            if (twilioWS._pcm16kBatch.length >= APPEND_SAMPLES_16K && !responseInFlight) {
              const slice = twilioWS._pcm16kBatch.subarray(0, APPEND_SAMPLES_16K);
              const remain = twilioWS._pcm16kBatch.subarray(APPEND_SAMPLES_16K);
              twilioWS._pcm16kBatch = new Int16Array(remain.length);
              twilioWS._pcm16kBatch.set(remain, 0);

              const b64 = int16ToBase64LE(slice);
              console.log("[realtime] appending PCM16@16k samples:", slice.length, "(~200ms)");

              openaiWS.send(JSON.stringify({
                type: "input_audio_buffer.append",
                audio: b64 // single base64 string of 16k PCM16 LE
              }));

              // brief ingest delay
              await new Promise(r => setTimeout(r, 100));

              console.log("[realtime] committing input buffer");
              openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

              if (!firstResponseRequested) {
                setTimeout(() => {
                  if (openaiWS.readyState === WebSocket.OPEN && !responseInFlight) {
                    openaiWS.send(JSON.stringify({
                      type: "response.create",
                      response: { modalities: ["audio", "text"] }
                    }));
                    firstResponseRequested = true;
                    responseInFlight = true;
                    console.log("[realtime] requested first spoken response");
                  }
                }, 150);
              }
            }
          }
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
