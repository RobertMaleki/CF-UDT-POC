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

// ---- Attach WS bridge to existing HTTP server ----
function attach(server) {
  const wss = new WebSocket.Server({ server, path: "/media-stream" });
  console.log("[media] WebSocket server ready at /media-stream");

  wss.on("connection", (twilioWS, req) => {
    console.log("[media] Twilio WS connected. UA:", req.headers["user-agent"] || "n/a");

    // Connect to OpenAI Realtime
    const openaiWS = new WebSocket(OPENAI_REALTIME_URL, { headers: OPENAI_HEADERS });

    // State flags
    let openaiReady = false;
    let responseInFlight = false;
    let lastCommitAt = 0;

    // Keepalive ping (Render proxies sometimes like this)
    const pingInterval = setInterval(() => {
      try { twilioWS.ping(); } catch {}
      try { openaiWS.ping(); } catch {}
    }, 15000);

    // --- OpenAI events ---
    openaiWS.on("open", () => {
      console.log("[realtime] OpenAI WS open");
      // Configure session: instructions + I/O formats at 8k PCM16
      const sessionUpdate = {
        type: "session.update",
        session: {
          instructions: SYSTEM_PROMPT,
          voice: "alloy",
          input_audio_format: { type: "pcm16", sample_rate_hz: 8000 },
          output_audio_format: { type: "pcm16", sample_rate_hz: 8000 }
        }
      };
      openaiWS.send(JSON.stringify(sessionUpdate));
      openaiReady = true;

      // Send immediate greeting so the caller hears something right away
      // (no need to wait for user speech)
      console.log("[realtime] sending initial response.create (greeting)");
      openaiWS.send(JSON.stringify({ type: "response.create" }));
    });

    openaiWS.on("message", (raw) => {
      // Try parse JSON; some frames may be binary—handle gracefully
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type) {
          // Log key events/types for debugging
          if (msg.type === "response.created") {
            responseInFlight = true;
            console.log("[realtime] response.created");
          }
          if (msg.type === "response.completed") {
            responseInFlight = false;
            console.log("[realtime] response.completed");
          }
          if (msg.type === "response.error") {
            responseInFlight = false;
            console.error("[realtime] response.error:", msg.error || msg);
          }
          if (msg.type === "response.audio.delta" && msg.audio) {
            // msg.audio is base64 PCM16 (8k) per our session settings
            const pcmB64 = msg.audio;
            const pcm = new Int16Array(b64ToBuf(pcmB64).buffer, 0, b64ToBuf(pcmB64).length / 2);
            const muB64 = pcm16ToMuLawB64(pcm);
            twilioWS.send(JSON.stringify({ event: "media", media: { payload: muB64 } }));
          }
        }
      } catch {
        // Non-JSON frames: could be raw audio or control; ignore
      }
    });

    openaiWS.on("close", () => console.log("[realtime] OpenAI WS closed"));
    openaiWS.on("error", (err) => console.error("[realtime] OpenAI WS error:", err?.message || err));

    // --- Twilio events ---
    twilioWS.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      switch (msg.event) {
        case "start":
          console.log("[twilio] stream start callSid:", msg.start?.callSid);
          break;

        case "media": {
          // throttle commits to ~ every 200ms
          const now = Date.now();
          const shouldCommit = now - lastCommitAt > 200;

          // Forward caller audio to OpenAI as 8k PCM16
          if (openaiReady) {
            const pcm16 = muLawB64ToPCM16(msg.media.payload);
            openaiWS.send(JSON.stringify({
              type: "input_audio_buffer.append",
              audio: bufToB64(Buffer.from(pcm16.buffer))
            }));

            if (shouldCommit && !responseInFlight) {
              lastCommitAt = now;
              // Commit the input buffer and ask for a response turn
              openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
              openaiWS.send(JSON.stringify({ type: "response.create" }));
              // Mark that we’re expecting audio back
              responseInFlight = true;
            }
          }
          break;
        }

        case "mark":
          // optional markers; ignore
          break;

        case "stop":
          console.log("[twilio] stream stop");
          try { openaiWS.close(); } catch {}
          break;
      }
    });

    twilioWS.on("close", () => {
      console.log("[twilio] WS closed");
      clearInterval(pingInterval);
      try { openaiWS.close(); } catch {}
    });

    twilioWS.on("error", (err) => console.error("[twilio] WS error:", err?.message || err));
  });
}

module.exports = { attach };
