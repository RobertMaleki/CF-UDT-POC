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
- Greet immediately (don't wait silently).
- Ask about their goal (lose weight, strength, classes).
- Offer two specific visit windows (e.g., "today 6–8pm" or "tomorrow 7–9am").
- Handle objections concisely and positively.
- Confirm day/time, repeat back, and close.
Keep responses under ~10 seconds.
`;

// ---- μ-law <-> PCM16 helpers ----
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
const bufToB64 = (buf) => Buffer.from(buf).toString("base64");
function muLawB64ToPCM16(b64) {
  const u8 = b64ToBuf(b64);
  const pcm = new Int16Array(u8.length);
  for (let i = 0; i < u8.length; i++) pcm[i] = mulawToPcm16(u8[i]);
  return pcm;
}
function pcm16ToMuLawB64(int16) {
  const mu = Buffer.alloc(int16.length);
  for (let i = 0; i < int16.length; i++) mu[i] = pcm16ToMulaw(int16[i]);
  return bufToB64(mu);
}

// ---- Test tone (8kHz PCM16 sine) ----
function generateTonePCM16({ freq = 440, ms = 2000, sampleRate = 8000, amplitude = 6000 }) {
  const totalSamples = Math.floor((ms / 1000) * sampleRate);
  const pcm = new Int16Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    pcm[i] = Math.floor(amplitude * Math.sin(2 * Math.PI * freq * t));
  }
  return pcm;
}

// ---- Attach WS bridge to existing HTTP server ----
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

    // Connect to OpenAI Realtime (optional; tone test will work even if this fails)
    let openaiWS = null;
    let openaiReady = false;
    let responseInFlight = false;
    let lastCommitAt = 0;

    if (!process.env.OPENAI_API_KEY) {
      console.warn("[realtime] OPENAI_API_KEY not set — skipping OpenAI bridge (tone test only)");
    } else {
      openaiWS = new WebSocket(OPENAI_REALTIME_URL, { headers: OPENAI_HEADERS });

      openaiWS.on("open", () => {
        console.log("[realtime] OpenAI WS open");
        const sessionUpdate = {
          type: "session.update",
          session: {
            instructions: SYSTEM_PROMPT,
            voice: "alloy",
            input_audio_format: { type: "pcm16", sample_rate_hz: 8000 },
            output_audio_format: { type: "pcm16", sample_rate_hz: 8000 },
          },
        };
        openaiWS.send(JSON.stringify(sessionUpdate));
        openaiReady = true;

        console.log("[realtime] sending initial response.create (greeting)");
        openaiWS.send(JSON.stringify({ type: "response.create" }));
      });

      openaiWS.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "response.created") {
            responseInFlight = true;
            console.log("[realtime] response.created");
          } else if (msg.type === "response.completed") {
            responseInFlight = false;
            console.log("[realtime] response.completed");
          } else if (msg.type === "response.error") {
            responseInFlight = false;
            console.error("[realtime] response.error:", msg.error || msg);
          } else if (msg.type === "response.audio.delta" && msg.audio) {
            const pcmB64 = msg.audio; // base64 PCM16 at 8k
            const pcm = new Int16Array(b64ToBuf(pcmB64).buffer, 0, b64ToBuf(pcmB64).length / 2);
            const muB64 = pcm16ToMuLawB64(pcm);
            twilioWS.send(JSON.stringify({ event: "media", media: { payload: muB64 } }));
          }
        } catch {
          // ignore non-JSON frames
        }
      });

      openaiWS.on("close", () => console.log("[realtime] OpenAI WS closed"));
      openaiWS.on("error", (err) => console.error("[realtime] OpenAI WS error:", err?.message || err));
    }

    // Keepalive pings (some proxies like these)
    const pingInterval = setInterval(() => {
      try { twilioWS.ping(); } catch {}
      try { openaiWS?.ping(); } catch {}
    }, 15000);

    // --- Twilio events ---
    twilioWS.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      switch (msg.event) {
        case "start":
          console.log("[twilio] stream start callSid:", msg.start?.callSid);

          // ---- TEST TONE: play 2s tone to confirm downlink works ----
          try {
            const tone = generateTonePCM16({ freq: 440, ms: 2000, sampleRate: 8000 });
            const muB64 = pcm16ToMuLawB64(tone);
            // Slice into ~20ms frames (160 samples @ 8k)
            const FRAME = 160;
            for (let i = 0; i < tone.length; i += FRAME) {
              const chunk = tone.subarray(i, i + FRAME);
              const chunkMu = pcm16ToMuLawB64(chunk);
              twilioWS.send(JSON.stringify({ event: "media", media: { payload: chunkMu } }));
            }
            console.log("[twilio] sent 2s test tone");
          } catch (e) {
            console.error("[twilio] test tone error:", e?.message || e);
          }
          break;

        case "media": {
          if (!openaiReady) break; // we can still do tone test without OpenAI

          // throttle commits to ~ every 200ms
          const now = Date.now();
          const shouldCommit = now - lastCommitAt > 200;

          const pcm16 = muLawB64ToPCM16(msg.media.payload);
          openaiWS.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: bufToB64(Buffer.from(pcm16.buffer)),
          }));

          if (shouldCommit && !responseInFlight) {
            lastCommitAt = now;
            openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
            openaiWS.send(JSON.stringify({ type: "response.create" }));
            responseInFlight = true;
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
