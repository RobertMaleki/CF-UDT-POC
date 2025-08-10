// backend/aiAgent.js
const WebSocket = require("ws");
const crypto = require("crypto");

// ---- Config ----
const OPENAI_REALTIME_URL =
  "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview";
const OPENAI_HEADERS = {
  Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
  "OpenAI-Beta": "realtime=v1",
};

// Conversation system prompt
const SYSTEM_PROMPT = `
You are a friendly, upbeat Crunch Fitness outbound agent.
Mission: book a time for the caller to come in and redeem a free trial pass this week.
Guidelines:
- Greet them by name if available.
- Ask about their goals briefly (lose weight, strength, classes).
- Offer two specific visit windows (e.g., "today 6–8pm" or "tomorrow 7–9am").
- Handle common objections (busy, already have a gym, cost) empathetically.
- Confirm day/time, repeat back, and close positively.
- Keep responses concise (under 12 seconds per turn).
`;

// ---------- μ-law <-> PCM16 helpers ----------
const MULAW_MAX = 0x1FFF;
const SIGN_BIT = 0x80;
const QUANT_MASK = 0x0F;
const SEG_MASK = 0x70;
const BIAS = 0x84;

// μ-law byte -> PCM16 sample
function mulawToPcm16(uVal) {
  uVal = ~uVal & 0xff;
  let t = ((uVal & QUANT_MASK) << 3) + BIAS;
  t <<= ((uVal & SEG_MASK) >> 4);
  return (uVal & SIGN_BIT) ? (BIAS - t) : (t - BIAS);
}

// PCM16 sample -> μ-law byte
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

// Base64 utils
function b64ToBytes(b64) {
  return Buffer.from(b64, "base64");
}
function bytesToB64(buf) {
  return Buffer.from(buf).toString("base64");
}

// Convert a base64 μ-law frame from Twilio → PCM16 (Int16Array)
function muLawBase64ToPCM16(b64) {
  const u8 = b64ToBytes(b64);
  const pcm = new Int16Array(u8.length);
  for (let i = 0; i < u8.length; i++) {
    pcm[i] = mulawToPcm16(u8[i]);
  }
  return pcm;
}

// Convert PCM16 Int16Array → base64 μ-law frame for Twilio
function pcm16ToMuLawBase64(int16) {
  const mu = Buffer.alloc(int16.length);
  for (let i = 0; i < int16.length; i++) {
    mu[i] = pcm16ToMulaw(int16[i]);
  }
  return bytesToB64(mu);
}

// Resample (very naive) 16k → 8k (drop every other sample). Good enough for POC.
function downsample16kTo8k(int16) {
  const out = new Int16Array(Math.floor(int16.length / 2));
  for (let i = 0, j = 0; i < int16.length - 1; i += 2, j++) out[j] = int16[i];
  return out;
}

// --------- Twilio <-> OpenAI bridge ----------
function attach(server) {
  const wss = new WebSocket.Server({ server, path: "/media-stream" });
  console.log("WebSocket media-stream ready at /media-stream");

  wss.on("connection", async (twilioWS, req) => {
    console.log("Twilio WS connected");

    // 1) Connect to OpenAI Realtime
    const openaiWS = new WebSocket(OPENAI_REALTIME_URL, { headers: OPENAI_HEADERS });

    let callStarted = false;

    openaiWS.on("open", () => {
      console.log("Connected to OpenAI Realtime");
      // Set system prompt and output audio instructions
      const sessionUpdate = {
        type: "session.update",
        session: {
          instructions: SYSTEM_PROMPT,
          voice: "alloy",            // use an available voice
          input_audio_format: { type: "pcm16", sample_rate_hz: 8000 },
          output_audio_format: { type: "pcm16", sample_rate_hz: 8000 }
        }
      };
      openaiWS.send(JSON.stringify(sessionUpdate));
    });

    // 2) Forward OpenAI audio back to Twilio
    openaiWS.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        // Realtime emits audio deltas as binary chunks or events, depending on version.
        // Handle both:
        if (msg.type === "response.audio.delta" && msg.audio) {
          // msg.audio is base64 PCM16 at 8k (as configured)
          const pcmB64 = msg.audio;
          const pcm = new Int16Array(b64ToBytes(pcmB64).buffer, 0, (b64ToBytes(pcmB64).length / 2));
          const muB64 = pcm16ToMuLawBase64(pcm);
          const frame = {
            event: "media",
            media: { payload: muB64 }
          };
          twilioWS.send(JSON.stringify(frame));
        }
        // Some versions stream raw binary buffers; handle that too:
        else if (Buffer.isBuffer(msg)) {
          // Treat as PCM16 16k or 8k — assume 8k here
          const buf = new Int16Array(msg.buffer, 0, msg.length / 2);
          const muB64 = pcm16ToMuLawBase64(buf);
          twilioWS.send(JSON.stringify({ event: "media", media: { payload: muB64 } }));
        }
      } catch (e) {
        // Non-JSON frames or unknown events can be ignored
      }
    });

    openaiWS.on("close", () => console.log("OpenAI WS closed"));
    openaiWS.on("error", (err) => console.error("OpenAI WS error:", err));

    // 3) Receive Twilio media, forward to OpenAI
    twilioWS.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        switch (msg.event) {
          case "start":
            callStarted = true;
            console.log("Twilio stream started");
            break;

          case "media": {
            // Twilio sends μ-law @ 8kHz base64 in msg.media.payload
            const pcm16 = muLawBase64ToPCM16(msg.media.payload);
            // Send to OpenAI as 8k PCM16
            openaiWS.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: bytesToB64(Buffer.from(pcm16.buffer))
            }));
            // Commit periodically; simplest: commit every chunk
            openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            // Ask model to create/continue a response
            openaiWS.send(JSON.stringify({ type: "response.create" }));
            break;
          }

          case "stop":
            console.log("Twilio stream stopped");
            try { openaiWS.close(); } catch {}
            break;
        }
      } catch (err) {
        console.error("Error handling Twilio WS msg:", err);
      }
    });

    twilioWS.on("close", () => {
      console.log("Twilio WS closed");
      try { openaiWS.close(); } catch {}
    });
    twilioWS.on("error", (err) => console.error("Twilio WS error:", err));
  });
}

module.exports = { attach };
