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
Keep responses under ~10 seconds and avoid long monologues.`;

// =====================================================

// Initialize Fastify
const fastify = Fastify({ logger: false });
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Serve frontend
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");
fastify.register(fastifyStatic, { root: FRONTEND_DIR, prefix: "/" });
fastify.get("/", async (_req, reply) => {
  const file = path.join(FRONTEND_DIR, "index.html");
  reply.type("text/html").send(fs.readFileSync(file, "utf8"));
});

// Root Route
//fastify.get('/', async (request, reply) => {
//  reply.send({ message: 'Twilio Media Stream Server is running!'});
//})

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    // Setup WebSocket server for handling media streams
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        const openaiWS = new WebSocket(OPENAI_REALTIME_URL, { headers: OPENAI_HEADERS});

        let streamSid = null;

        const sendInitialSessionUpdate = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                }
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openaiWS.send(JSON.stringify(sessionUpdate));

            const initialConversationItem = {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: 'Greet the user with "Hello there! I\'m an AI voice assistant from Twilio and the OpenAI Realtime API. How can I help?"'
                        }
                    ]
                }
            };

            openaiWS.send(JSON.stringify(initialConversationItem));
            openaiWS.send(JSON.stringify({ type: 'response.create' }));
        };

        // Open event for OpenAI WebSocket
        openaiWS.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(sendInitialSessionUpdate, 100); // Ensure connection stability, send after .1 second
        });

        // Listen for messages from the OpenAI WebSocket (and send to Twilio if necessary)
        openaiWS.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

                if (response.type === 'session.updated') {
                    console.log('Session updated successfully:', response);
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamSid: streamSid,
                        media: { payload: Buffer.from(response.delta, 'base64').toString('base64') }
                    };
                    connection.send(JSON.stringify(audioDelta));
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle incoming messages from Twilio
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };

                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamSid = data.start.streamSid;
                        console.log('Incoming stream has started', streamSid);
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        // Handle connection close
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected.');
        });

        // Handle WebSocket close and errors
        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});


// Outbound call trigger (keeps your existing frontend flow)
fastify.post("/api/start-call", async (req, reply) => {
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

// ---- Start server ----
fastify.listen({ port: Number(PORT), host: "0.0.0.0" })
  .then(() => console.log(`Fastify server → http://localhost:${PORT}`))
  .catch((e) => { console.error("Server failed:", e); process.exit(1); });

  //FINISH