# Contributing to Snap Goblin

Thanks for contributing.

## Development Setup

1. Install Node.js 20 or newer.
2. Run `npm ci`.
3. Copy `.env.example` to `.env`.
4. Set `SNAP_GOBLIN_API_KEY` before starting the service.

For local development:

```bash
npm run dev
```

For Docker-based development:

```bash
docker compose up --build
```

## Validation

Run these checks before opening a pull request:

```bash
npm run typecheck
npm run build
docker build -t snap_goblin .
```

If you change runtime behavior, also verify at least one real request against `GET /health`, `POST /capture`, or `POST /scrape`.

## Pull Requests

- Keep changes focused and easy to review.
- Update `README.md` or `AI_AGENT_INTEGRATION_GUIDE.md` when API behavior or configuration changes.
- Preserve the server-to-server security model. Do not introduce browser-side exposure of `x-api-key`.
- Document new environment variables in both `.env.example` and the README.

## Reporting Issues

When filing a bug, include:

- What you expected to happen.
- What actually happened.
- The request payload used, with secrets removed.
- Relevant logs, response codes, and environment details.
