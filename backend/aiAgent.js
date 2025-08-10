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
function mulawToPcm16(uVal){ uVal=~uVal&0xff; let t=((uVal&QUANT_MASK)<<3)+BIAS; t<<=((uVal&SEG_MASK)>>4); return (uVal&SIGN_BIT)?(BIAS - t):(t - BIAS); }
function pcm16ToMulaw(sample){ let sign=(sample>>8)&0x80; if(sign!==0) sample=-sample; if(sample>32635) sample=32635; sample+=BIAS; let exponent=7; for(let m=0x4000;(sample&m)===0 && exponent>0; exponent--, m>>=1){} const mantissa=(sample>>((exponent===0)?4:(exponent+3)))&0x0F; return (~(sign|(exponent<<4)|mantissa))&0xff; }
const b64ToBuf = (b64)=>Buffer.from(b64,"base64");
const bufToB64 = (buf)=>Buffer.from(buf).toString("base64");
function muLawB64ToPCM16(b64){ const u8=b64ToBuf(b64); const pcm=new Int16Array(u8.length); for(let i=0;i<u8.length;i++) pcm[i]=mulawToPcm16(u8[i]); return pcm; }
function pcm16ToMuLawB64(int16){ const mu=Buffer.alloc(int16.length); for(let i=0;i<int16.length;i++) mu[i]=pcm16ToMulaw(int16[i]); return bufToB64(mu); }

// ---- Test tone (8kHz PCM16 sine) ----
function generateTonePCM16({ freq=440, ms=2000, sampleRate=8000, amplitude=6000 }) {
  const total = Math.floor((ms/1000)*sampleRate);
  const pcm = new Int16Array(total);
  for (let i=0;i<total;i++){ const t=i/sampleRate; pcm[i]=Math.floor(amplitude*Math.sin(2*Math.PI*freq*t)); }
  return pcm;
}

// ---- tiny sleep helper for pacing ----
const sleep = (ms)=>new Promise(r=>setTimeout(r, ms));

// ---- send μ-law frames to Twilio at real-time pace ----
async function sendMuLawFramesPaced(twilioWS, streamSid, ulawB64Frames, frameDurationMs=20) {
  for (const payload of ulawB64Frames) {
    const msg = { event: "media", streamSid, media: { payload, track: "outbound" } };
    try { twilioWS.send(JSON.stringify(msg)); } catch(e){ console.error("[twilio] send error:", e?.message||e); }
    await sleep(frameDurationMs);
  }
}

function attach(server) {
  const wss = new WebSocket.Server({
    server,
    path: "/media-stream",
    clientTracking: true,
    perMessageDeflate: false,
    maxPayload: 1024*1024,
  });
  console.log("[media] WebSocket server ready at /media-stream");

  wss.on("connection", (twilioWS, req) => {
    console.log("[media] Twilio WS connected. UA:", req.headers["user-agent"] || "n/a");

    let streamSid = null;

    // OpenAI
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
        openaiWS.send(JSON.stringify({
          type:"session.update",
          session:{
            instructions: SYSTEM_PROMPT,
            voice: "alloy",
            input_audio_format: { type:"pcm16", sample_rate_hz:8000 },
            output_audio_format:{ type:"pcm16", sample_rate_hz:8000 }
          }
        }));
        openaiReady = true;
        console.log("[realtime] sending initial response.create (greeting)");
        openaiWS.send(JSON.stringify({ type:"response.create" }));
      });

      openaiWS.on("message", async (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "response.created") {
            responseInFlight = true; console.log("[realtime] response.created");
          } else if (msg.type === "response.completed") {
            responseInFlight = false; console.log("[realtime] response.completed");
          } else if (msg.type === "response.error") {
            responseInFlight = false; console.error("[realtime] response.error:", msg.error||msg);
          } else if (msg.type === "response.audio.delta" && msg.audio) {
            if (!streamSid) return;
            // base64 PCM16 (8k) -> μ-law -> pace at ~20ms frames
            const pcm = new Int16Array(b64ToBuf(msg.audio).buffer, 0, b64ToBuf(msg.audio).length/2);
            // slice into 160-sample (~20ms) chunks
            const FRAME = 160;
            const frames = [];
            for (let i=0;i<pcm.length;i+=FRAME) {
              const chunk = pcm.subarray(i, i+FRAME);
              frames.push(pcm16ToMuLawB64(chunk));
            }
            await sendMuLawFramesPaced(twilioWS, streamSid, frames, 20);
          }
        } catch { /* ignore non-JSON frames */ }
      });

      openaiWS.on("close", () => console.log("[realtime] OpenAI WS closed"));
      openaiWS.on("error", (err) => console.error("[realtime] OpenAI WS error:", err?.message||err));
    }

    const pingInterval = setInterval(() => {
      try { twilioWS.ping(); } catch {}
      try { openaiWS?.ping(); } catch {}
    }, 15000);

    twilioWS.on("message", async (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

      switch (msg.event) {
        case "start": {
          streamSid = msg.start?.streamSid;
          console.log("[twilio] stream start callSid:", msg.start?.callSid, "streamSid:", streamSid);

          // ---- TEST TONE: 2s @ 8k, μ-law, paced at 20ms/frame ----
          try {
            const tonePcm = generateTonePCM16({ freq: 440, ms: 2000, sampleRate: 8000 });
            const FRAME = 160; // 20ms @ 8k
            const ulawFrames = [];
            for (let i=0;i<tonePcm.length;i+=FRAME) {
              const chunk = tonePcm.subarray(i, i+FRAME);
              ulawFrames.push(pcm16ToMuLawB64(chunk));
            }
            await sendMuLawFramesPaced(twilioWS, streamSid, ulawFrames, 20);
            console.log("[twilio] sent 2s test tone (paced)");
          } catch(e){ console.error("[twilio] test tone error:", e?.message||e); }
          break;
        }

        case "media": {
          if (!openaiReady || !streamSid) break;

          const now = Date.now();
          const shouldCommit = now - lastCommitAt > 250;

          const pcm16 = muLawB64ToPCM16(msg.media.payload);
          openaiWS.send(JSON.stringify({
            type:"input_audio_buffer.append",
            audio: bufToB64(Buffer.from(pcm16.buffer)),
          }));

          if (shouldCommit && !responseInFlight) {
            lastCommitAt = now;
            openaiWS.send(JSON.stringify({ type:"input_audio_buffer.commit" }));
            openaiWS.send(JSON.stringify({ type:"response.create" }));
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
    twilioWS.on("error", (err) => console.error("[twilio] WS error:", err?.message||err));
  });
}

module.exports = { attach };
