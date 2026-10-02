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
| gpt-oss-120b | no | 0.35 / 0.75 |
| DeepSeek V4 Flash | no | 0.44 / 1.32 |
| Kimi K2.6 | yes | 0.95 / 4.00 |
| GLM-5.3 | no | 1.40 / 4.40 |

- Chat history is stored on the device in IndexedDB. Nothing is stored server-side.
- Requests are routed through the `default` AI Gateway for logs and analytics (`AI_GATEWAY_ID` in `wrangler.jsonc`; set it to `""` to bypass).
- Access is gated by a passcode held as a Worker secret. The app asks for it once per device.

## Passcode

Change it from any machine with Node and Cloudflare credentials:

```sh
echo -n 'new-passcode' | npx wrangler@4.147.0 secret put PASSCODE --name thread
```

Devices holding the old passcode are sent back to the lock screen on their next request.

## Deploy

Pushes to `main` run tests and deploy via `.github/workflows/ci.yml`, using the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets. Pull requests run tests and a build check only.

## Local development

```sh
cp .dev.vars.example .dev.vars && npm run dev
```

The AI binding always calls the real Workers AI service, so local requests are billed. Tests: `npm test` (Node 22, no dependencies).

## Layout

- `src/worker.js`: API (`/api/auth`, `/api/models`, `/api/chat`), passcode check, request validation, Workers AI streaming.
- `src/models.js`: model allowlist.
- `public/`: static app (no build step). `markdown.js` is the renderer; every text path is HTML-escaped and links are limited to http(s) and mailto. `_headers` sets a strict CSP.
