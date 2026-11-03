# Thread

Mobile-first AI chat (installable web app) on Cloudflare Workers and Workers AI. The Worker (`src/`) serves the API; `public/` is the static app with no build step. Chats and settings live on the device (IndexedDB, localStorage); nothing is stored server-side except lockout counts and push subscriptions in the `Guard` Durable Object. See README.md for features and layout.

## Checks

- Unit tests: `node --test` (Node 22, no dependencies).
- Sandbox runner tests: `python3 test/runner_test.py`.
- Build check: `npx --yes wrangler@4.147.0 deploy --dry-run --outdir dist`. It builds the container image, so it needs Docker; CI runs it, a session without Docker cannot.

## Deploy

Pushes to `main` run the checks and deploy with `wrangler deploy` (`.github/workflows/ci.yml`, secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`). Pull requests run the checks only. After a deploy, confirm the run succeeded and that https://thread.reloru.workers.dev serves the change (for example, `curl` a changed file).

## Conventions

- Wrangler is pinned to 4.147.0 everywhere (package.json, CI, README commands).
- Every element id a script looks up must be in `PAGE_IDS` in `public/page.js` and in `index.html`; `test/page.test.js` enforces it. The guard reloads or stops the app when the page and scripts are from different releases.
- Model parameters are validated by the same code in the app and the Worker (`public/params.js`); per-model specs are in `src/models.js`. Add a control only after checking it changes the output on that model.
- `public/_headers` sets the CSP (`script-src 'self'`, no inline scripts or inline style attributes) and `no-store` on the page.
- Tool calls (`src/agent.js`) are not forwarded to the app; the app sees `{"thread": …}` events (`tool_prepare`, `tool_start`, `tool_result`). Argument limits are in `MAX_ARGS`.
- Diagnosing a live problem: Workers observability (telemetry query API) has per-request wall time; GraphQL `aiInferenceAdaptiveGroups` has per-minute model calls with input and output tokens.
