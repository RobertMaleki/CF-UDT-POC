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

// ============ μ-law <-> PCM16 helpers ============
const BIAS = 0x84, SIGN_BIT = 0x80, QUANT_MASK = 0x0F, SEG_MASK = 0x70;
function mulawToPcm16(uVal){uVal=~uVal&0xff;let t=((uVal&QUANT_MASK)<<3)+BIAS;t<<=((uVal&SEG_MASK)>>4);return(uVal&SIGN_BIT)?(BIAS-t):(t-BIAS);}
function pcm16ToMulaw(s){let sign=(s>>8)&0x80;if(sign!==0)s=-s;if(s>32635)s=32635;s+=BIAS;let e=7;for(let m=0x4000;(s&m)===0&&e>0;e--,m>>=1){}const man=(s>>((e===0)?4:(e+3)))&0x0F;return(~(sign|(e<<4)|man))&0xff;}
const b64ToBuf=(b)=>Buffer.from(b,"base64");
const bufToB64=(buf)=>Buffer.from(buf).toString("base64");

// Twilio μ-law (8 kHz) -> PCM16 (for outbound to Twilio we still convert PCM16 -> μ-law)
function muLawB64ToPCM16(b64){
  const u8=b64ToBuf(b64);
  const pcm=new Int16Array(u8.length);
  for(let i=0;i<u8.length;i++) pcm[i]=mulawToPcm16(u8[i]);
  return pcm;
}
function pcm16ToMuLawB64(int16){
  const mu=Buffer.alloc(int16.length);
  for(let i=0;i<int16.length;i++) mu[i]=pcm16ToMulaw(int16[i]);
  return mu.toString("base64");
}

// ============ Tone + pacing ============
function generateTonePCM16({ freq=440, ms=2000, sampleRate=8000, amplitude=6000 }) {
  const total=Math.floor((ms/1000)*sampleRate);
  const pcm=new Int16Array(total);
  for(let i=0;i<total;i++){const t=i/sampleRate;pcm[i]=Math.floor(amplitude*Math.sin(2*Math.PI*freq*t));}
  return pcm;
}
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
async function sendPCM16AsPacedUlawFrames(twilioWS, streamSid, pcm16, frameSamples=160, frameMs=20){
  for(let i=0;i<pcm16.length;i+=frameSamples){
    const chunk=pcm16.subarray(i,i+frameSamples);
    const payload=pcm16ToMuLawB64(chunk);
    try{ twilioWS.send(JSON.stringify({ event:"media", streamSid, media:{ payload } })); }
    catch(e){ console.error("[twilio] send error:", e?.message||e); break; }
    await sleep(frameMs);
  }
}

// ============ Attach Twilio <-> OpenAI bridge ============
function attach(server){
  const wss=new WebSocket.Server({
    server,
    path:"/media-stream",
    clientTracking:true,
    perMessageDeflate:false,
    maxPayload:1024*1024
  });
  console.log("[media] WebSocket server ready at /media-stream");

  wss.on("connection",(twilioWS,req)=>{
    console.log("[media] Twilio WS connected. UA:",req.headers["user-agent"]||"n/a");

    let streamSid=null;

    // ---- OpenAI Realtime ----
    let openaiWS=null;
    let openaiReady=false;
    let responseInFlight=false;
    let firstResponseRequested=false;

    // μ-law accumulation buffer for appends (≥100ms per append)
    let ulawChunks=[];          // array<Buffer>
    let ulawBytesAccum=0;       // total bytes in current batch
    const APPEND_THRESHOLD=800; // 100 ms @ 8 kHz μ-law (1 byte per sample)

    if(!process.env.OPENAI_API_KEY){
      console.warn("[realtime] OPENAI_API_KEY not set — skipping OpenAI bridge (tone test only)");
    }else{
      openaiWS=new WebSocket(OPENAI_REALTIME_URL,{headers:OPENAI_HEADERS});

      openaiWS.on("open",()=>{
        console.log("[realtime] OpenAI WS open");
        // IMPORTANT: declare μ-law input and PCM16 output
        openaiWS.send(JSON.stringify({
          type:"session.update",
          session:{
            instructions:SYSTEM_PROMPT,
            voice:"alloy",
            input_audio_format:"g711_ulaw",
            output_audio_format:"pcm16"
          }
        }));
        openaiReady=true;
      });

      // Log all messages; stream audio deltas back to Twilio (paced)
      openaiWS.on("message", async (raw)=>{
        let msg; try{ msg=JSON.parse(raw.toString()); }catch{ return; }

        if(msg.type!=="response.audio.delta"){
          console.log("[realtime] evt:", msg.type, (msg.error? JSON.stringify(msg.error):""));
        }

        if(msg.type==="response.created"){ responseInFlight=true; }
        else if(msg.type==="response.completed"){ responseInFlight=false; }
        else if(msg.type==="response.error"){ responseInFlight=false; }

        if(msg.type==="response.audio.delta" && msg.audio && streamSid){
          const buf=b64ToBuf(msg.audio);
          const pcm=new Int16Array(buf.buffer, buf.byteOffset, buf.length/2);
          await sendPCM16AsPacedUlawFrames(twilioWS, streamSid, pcm, 160, 20);
        }
      });

      openaiWS.on("close",()=>console.log("[realtime] OpenAI WS closed"));
      openaiWS.on("error",(err)=>console.error("[realtime] OpenAI WS error:", err?.message||err));
    }

    // Keepalive pings
    const pingInterval=setInterval(()=>{ try{twilioWS.ping();}catch{} try{openaiWS?.ping();}catch{} },15000);

    // ---- Twilio events ----
    twilioWS.on("message", async (raw)=>{
      let msg; try{ msg=JSON.parse(raw.toString()); }catch{ return; }

      if(!msg.event){ console.log("[twilio] unknown frame", raw.toString().slice(0,200)); return; }
      if(!["start","media","stop"].includes(msg.event)){
        console.log(`[twilio] event=${msg.event}`, JSON.stringify(msg).slice(0,300));
      }

      switch(msg.event){
        case "start": {
          streamSid = msg.start?.streamSid;
          console.log("[twilio] stream start callSid:", msg.start?.callSid, "streamSid:", streamSid);

          // 2s tone (paced) to prove downlink immediately
          try{
            const tone=generateTonePCM16({freq:440,ms:2000,sampleRate:8000});
            await sendPCM16AsPacedUlawFrames(twilioWS, streamSid, tone, 160, 20);
            console.log("[twilio] sent 2s test tone (paced minimal frames)");
          }catch(e){ console.error("[twilio] test tone error:", e?.message||e); }
          break;
        }

        case "media": {
          // Inbound flow debug (every 25 frames)
          if(!twilioWS._frameCount) twilioWS._frameCount=0;
          if(++twilioWS._frameCount % 25 === 0){
            console.log("[twilio] inbound media frames:", twilioWS._frameCount);
          }

          // Accumulate μ-law bytes (base64 -> Buffer)
          if(openaiReady && openaiWS?.readyState===WebSocket.OPEN){
            const chunk = b64ToBuf(msg.media.payload); // μ-law bytes
            ulawChunks.push(chunk);
            ulawBytesAccum += chunk.length;

            // Once we have >=100ms of audio, append+commit in one go
            if (ulawBytesAccum >= APPEND_THRESHOLD && !responseInFlight) {
              const combined = Buffer.concat(ulawChunks, ulawBytesAccum);
              ulawChunks = [];
              ulawBytesAccum = 0;

              // Log what we're about to send
              console.log("[realtime] appending uLaw bytes:", combined.length);

              // Send as an ARRAY of base64 chunks (more compatible)
              const b64 = combined.toString("base64");
              openaiWS.send(JSON.stringify({
                type: "input_audio_buffer.append",
                audio: [ b64 ]            // <-- array form
              }));

              // Give the server a beat to ingest before we commit
              await new Promise(r => setTimeout(r, 60));

              console.log("[realtime] committing input buffer");
              openaiWS.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

              if (!firstResponseRequested) {
                openaiWS.send(JSON.stringify({
                  type: "response.create",
                  response: { modalities: ["audio","text"] }
                }));
                firstResponseRequested = true;
                responseInFlight = true;
                console.log("[realtime] requested first spoken response");
              }
            }
          }
          break;
        }

        case "stop":
          console.log("[twilio] stream stop");
          try{ openaiWS?.close(); }catch{}
          break;
      }
    });

    twilioWS.on("close",()=>{ console.log("[twilio] WS closed"); clearInterval(pingInterval); try{openaiWS?.close();}catch{} });
    twilioWS.on("error",(err)=>console.error("[twilio] WS error:", err?.message||err));
  });
}

module.exports = { attach };
