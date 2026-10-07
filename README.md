# Thread

Mobile-first AI chat on Cloudflare Workers and Workers AI. Installable as a home-screen app (web app manifest included).

Live: https://thread.reloru.workers.dev

## Features

- Streaming replies with Markdown rendering (headings, lists, tables, code blocks with copy).
- Reasoning shown in a collapsible "Thought for Ns" section.
- Image attachments (camera or photo library) for vision models; images are downscaled on the device before upload.
- Curated model picker (defined in `src/models.js`):

| Model | Vision | Price in / out (USD per M tokens) |
| --- | --- | --- |
| GLM-5.3 Flash (default) | yes | 0.15 / 0.50 |
| Gemma 4 26B | yes | 0.10 / 0.30 |
| Granite 4.0 Micro | no | 0.017 / 0.112 |
| gpt-oss-20b | no | 0.20 / 0.30 |
| Llama 3.3 70B (fp8-fast) | no | 0.293 / 2.253 |
| gpt-oss-120b | no | 0.35 / 0.75 |
| Mistral Small 3.1 | yes | 0.351 / 0.555 |
| DeepSeek V4 Flash | no | 0.44 / 1.32 |
| Qwen 3.8 27B | yes | 0.45 / 3.20 |
| Nemotron 3 120B (A12B) | no | 0.50 / 1.50 |
| Kimi K2.6 | yes | 0.95 / 4.00 |
| Kimi K2.7 Code | yes | 0.95 / 4.00 |
| DeepSeek V4 Pro | no | 1.32 / 3.96 |
| GLM-5.3 | no | 1.40 / 4.40 |

- Settings (gear in the model picker):
  - Instructions sent as the system message: one text for all chats, optionally replaced per chat.
  - Per-model parameters: reasoning effort and thinking toggles, temperature, top P/K, penalties, max output tokens, stop sequences, seed, response format, logit bias. Ranges and options follow each model's schema, narrowed where the service rejects or mishandles values. Controls that had no measurable effect in testing are not offered (for example seed on several models, Clear thinking, Skip special tokens).
  - Empty fields, shown as –, are left out of the request and the model uses its own default. Only max output tokens is always sent (some models stop after 256 tokens without it).
  - Advanced JSON: any other schema field for that model (tools, n, logprobs, …), sent as-is. The Worker validates every parameter against the same rules (`public/params.js`).
- Tools, switched on per chat with the chips above the composer:
  - **Code**: the model runs Python in an isolated Cloudflare Container (one per chat, standard-3: 2 vCPU, 8 GiB RAM; no internet; numpy/pandas/matplotlib/scipy/sympy; 60 s per run). Output and figures appear inline; variables and files persist while the container is awake (it sleeps after 10 idle minutes).
  - **Web**: the model reads a page by URL through Browser Run (headless Chrome, converted to Markdown). There is no search.
- Files: the + button accepts PDF, Office, OpenDocument, CSV, HTML and XML documents (up to 10 MB). Workers AI `toMarkdown` converts them to text, which is sent with the message.
- Voice chat: the waveform button next to send opens a full-screen voice mode. Nothing is stored server-side; only the text of the conversation is saved to the chat.
  - Speech to text: Nova-3 (`language=multi`, smart format), $0.0052 per audio minute. Chosen over Whisper large-v3-turbo because it answered in 0.4-0.8 s against 1.2-4 s and returned nothing for silence, where Whisper wrote "Thank you.".
  - Turn detection: after a 0.5 s pause, Smart Turn v2 judges the last 8 s of audio ($0.000338 per audio minute) while the same audio is transcribed in parallel. If you are mid-thought it keeps listening, up to 3 s of silence.
  - Speech: Aura-2, one request per sentence ($0.03 per 1000 characters). The service rejects text over 2000 characters and takes longer the more text it gets.
  - Voices: the 50 that Workers AI serves, 40 English (`aura-2-en`) and 10 Spanish (`aura-2-es`), each with a preview. Deepgram's own table lists more (for example selene); the service rejects them.
  - Hands-free mode, where speaking over a reply interrupts it (it takes 240 ms of voiced audio within half a second, so a cough does not; turn it off in the voice picker if the speaker sets off the microphone), or tap to talk.
  - On iPhone and iPad the microphone closes while a reply plays and the page asks for a "playback" audio session, so replies use the speaker and ignore the silent switch. With the microphone open, iOS uses a "play-and-record" session that can send replies to the earpiece or silence them. Talk-over needs the open microphone, so it is off by default there and can be turned on in the voice picker.
  - Voice requests turn thinking off where a way is verified (Gemma, DeepSeek, Qwen, Nemotron: Thinking off; Kimi: effort none), add a spoken-style instruction in the language of the voice, and keep only the spoken part of a reply you interrupt.
- Chat history and settings are stored on the device (IndexedDB and localStorage). Nothing is stored server-side.
- Requests go straight to Workers AI. To route them through an AI Gateway for logs and analytics, set `AI_GATEWAY_ID` in `wrangler.jsonc` to the gateway's ID.
- Access is gated by a passcode held as a Worker secret. The app asks for it once per device and exchanges it for a sign-in token, which it sends from then on; the passcode is not stored on the device. Apps that stored the passcode before tokens existed swap it for a token on their next start.
  - Lockouts apply to passcodes only; a signed-in device keeps working through them. 5 wrong passcodes within an hour, from anywhere, freeze passcode logins for 8 hours. The 4th gets a warning on the lock screen and a notification to every device that allowed notifications; the 5th sends another.
  - Per IP, 5 wrong passcodes lock that IP for 15 minutes; each further lockout doubles, up to 24 hours. A correct passcode, or a day without failures after a lockout ends, clears it. This catches guessing slow enough to stay under the hourly limit.
  - While locked, the right passcode is refused too. Requests with no credentials or with an invalid token are not counted.
- Notifications: the app asks once per device, with a card above the chips (iPhone allows the permission prompt only after a tap; notifications need the Home Screen app there, iOS 16.4 or later). Allowing sends a test notification. Pushes are encrypted and signed in the Worker (RFC 8291, RFC 8292) without libraries; `public/sw.js` shows them.
- Usage counter (right of the Code and Web chips): Workers AI neurons and billed USD for today (UTC), or this month after a tap. Billed means above the free 10,000 neurons per day, at $0.011 per 1,000 ([pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)), each day counted separately.
  - The figures come from the account's GraphQL analytics (`aiInferenceAdaptiveGroups`), refreshed every minute while the app is open. They cover the whole account (the data has no per-Worker field), so Workers AI calls made outside the app count too.
  - Analytics rows appear about 10 minutes after a request. Each reply's own cost, which the model reports in its last stream event, is added on the device that received it until analytics includes it. Voice transcription and speech are counted only through analytics.

## Passcode

Change it from any machine with Node and Cloudflare credentials:

```sh
echo -n 'new-passcode' | npx wrangler@4.147.0 secret put PASSCODE --name thread
```

Changing it signs every device out (tokens are derived from it); each goes back to the lock screen on its next request. A passcode cannot start with `t1.`, which marks a token.

Sign-in tokens and notifications need two more secrets, made once:

```sh
openssl rand -base64 32 | tr -d '\n' | npx wrangler@4.147.0 secret put SESSION_SECRET --name thread && node -e 'crypto.subtle.generateKey({name:"ECDSA",namedCurve:"P-256"},true,["sign"]).then(k=>crypto.subtle.exportKey("jwk",k.privateKey)).then(j=>process.stdout.write(JSON.stringify(j)))' | npx wrangler@4.147.0 secret put VAPID_JWK --name thread
```

Replacing `SESSION_SECRET` signs every device out. Replacing `VAPID_JWK` makes existing notification subscriptions invalid until each device opens the app again.

## Usage counter

The counter needs an API token with Account Analytics Read and the account ID, held as Worker secrets; without them it stays hidden.

```sh
echo -n 'TOKEN' | npx wrangler@4.147.0 secret put USAGE_API_TOKEN --name thread && echo -n 'ACCOUNT_ID' | npx wrangler@4.147.0 secret put USAGE_ACCOUNT_ID --name thread
```

## Deploy

`wrangler deploy` builds the sandbox image with Docker, so Docker must be running where it deploys. `--env staging` deploys `thread-staging` with its own container application.

Pushes to `main` run tests and deploy via `.github/workflows/ci.yml`, using the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets. Pull requests run tests and a build check only.

## Local development

```sh
cp .dev.vars.example .dev.vars && npm run dev
```

The AI binding always calls the real Workers AI service, so local requests are billed. Tests: `npm test` (Node 22, no dependencies).

## Layout

- `src/worker.js`: API (`/api/auth`, `/api/models`, `/api/chat`, `/api/usage`, `/api/push/*`), passcode check, request and parameter validation, Workers AI streaming.
- `src/auth.js`: sign-in tokens. `src/lockout.js` + `src/guard.js`: passcode lockout rules and the Durable Object that keeps the counts and the push subscriptions. `src/push.js` + `src/alerts.js`: Web Push (VAPID, payload encryption) and the notification texts. `src/usage.js`: `/api/usage` (neurons per UTC day this month from the GraphQL Analytics API).
- `src/models.js`: model allowlist and per-model parameter specs.
- `src/voice.js` + `src/voices.js`: voice API (`/api/voices`, `/api/voice/transcribe`, `/api/voice/turn`, `/api/voice/speak`) and the Aura-2 voice list. `src/http.js`: helpers shared by the Worker and the voice API.
- `src/agent.js`: server-side tool loop (streams model output, runs tool calls, feeds results back, at most 6 rounds).
- `src/sandbox.js` + `container/`: Durable Object that starts the Python sandbox container; `runner.py` (HTTP) and `kernel.py` (persistent interpreter).
- `src/index.js`: Worker entry (exports the Worker and the `Sandbox` and `Guard` classes).
- `public/params.js`: parameter validation shared by the app and the Worker; `public/settings.js`: settings panel.
- `public/voice.js`: voice mode (microphone, turn taking, playback, voice picker); `pcm.js`: resampling, WAV encoding, voice detection and turn segmentation; `speech.js`: markdown to spoken sentences; `voice-worklet.js`: microphone tap. `public/usage.js`: usage counter. `public/notify.js` + `public/sw.js`: notification prompt, push subscription and the service worker that shows notifications.
- `public/`: static app (no build step). `markdown.js` is the renderer; every text path is HTML-escaped and links are limited to http(s) and mailto. `_headers` sets a strict CSP.
