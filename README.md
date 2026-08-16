# Hybrid League Core

Hybrid League Core is a small, tenant-safe Discord league application. Its public interaction surface is deliberately limited to `/league` and `/help`.

It supports league setup, teams, player registration and staff review, capacity-safe roster membership, auditing, and durable Discord team-role reconciliation. It intentionally does **not** include EA integrations, fixtures, transfers, discipline, results, statistics, or awards.

## Prerequisites

- Node.js 24.14 or newer
- Docker Desktop (for local MySQL 8 and integration tests)
- A Discord application with a bot token

## Local setup

1. Install dependencies with `npm install`.
2. Start MySQL 8 with `docker compose up -d mysql`.
3. Copy `.env.example` to `.env` and supply your Discord application credentials. Do not commit `.env`.
4. Start the app with `npm run dev`. Startup applies pending migrations and registers the two Discord commands automatically.

For a compiled launch, use `npm run build` and then `npm start`. The build copies the SQL migration beside the runtime code; startup validates config, applies outstanding migrations, synchronizes the Discord application commands, logs in the Discord client, and starts the durable role-sync worker. `SIGINT` and `SIGTERM` stop the worker, Discord client, and database pool cleanly.

On a managed host with only a startup-file setting, set it to `dist/main.js`. Upload the package, configure `.env`, and start the server; no separate migration or command-registration console command is required.

Hybrid requires MySQL 8.0.46 or newer. Set `DATABASE_URL` to a MySQL URL such as `mysql://USER:PERCENT_ENCODED_PASSWORD@HOST:3306/DATABASE`; never commit it. Use a newly rotated password if a connection string has been shared in chat or screenshots. Tests use an isolated disposable MySQL container and must never run against the production Hybrid schema.

## Discord configuration

Install the bot with the `bot` and `applications.commands` OAuth2 scopes. The bot needs the Guilds gateway intent. For role synchronization, grant **Manage Roles** and place the bot's highest role above each mapped team role. Initial league setup is limited to Discord members with **Manage Server**; after setup, every action uses Hybrid's application roles and tenant context rather than Discord Administrator.

Startup synchronizes global commands from `COMMAND_DEFINITIONS`; global updates may take time to propagate. It registers only `/league` and `/help`. `npm run commands:register` remains available for manual registration when needed.

## Operations

Useful commands:

```text
npm test
npm run typecheck
npm run lint
npm run build
npm run migrate
npm run commands:register
```

The role worker claims durable jobs with leases and retries failures with bounded backoff. Roster changes are committed before a job is queued, so Discord outages never roll back League Core state. Missing mapped roles are recorded as unavailable and reconciled without touching unrelated Discord roles.

## Environment

See `.env.example` for variable names only. Keep real tokens, connection strings, server IDs, and production endpoints outside source control.
