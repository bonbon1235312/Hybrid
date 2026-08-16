# Hybrid League Core

Hybrid League Core is a small, tenant-safe Discord league application. Its public interaction surface is deliberately limited to `/league` and `/help`.

It supports league setup, teams, player registration and staff review, capacity-safe roster membership, auditing, and durable Discord team-role reconciliation. It intentionally does **not** include EA integrations, fixtures, transfers, discipline, results, statistics, or awards.

## Prerequisites

- Node.js 24.14 or newer
- Docker Desktop (for local PostgreSQL)
- A Discord application with a bot token

## Local setup

1. Install dependencies with `npm install`.
2. Start PostgreSQL with `docker compose up -d postgres`.
3. Copy `.env.example` to `.env` and supply your Discord application credentials. Do not commit `.env`.
4. Apply the production migration with `npm run migrate`. Migration state is recorded in `hybrid_schema_migrations`, so repeat runs are safe.
5. Register the two global Discord commands with `npm run commands:register`.
6. Start the app with `npm run dev`.

For a compiled launch, use `npm run build` and then `npm start`. The build copies the SQL migration beside the runtime code; startup validates config, applies outstanding migrations, logs in the Discord client, and starts the durable role-sync worker. `SIGINT` and `SIGTERM` stop the worker, Discord client, and database pool cleanly.

## Discord configuration

Install the bot with the `bot` and `applications.commands` OAuth2 scopes. The bot needs the Guilds gateway intent. For role synchronization, grant **Manage Roles** and place the bot's highest role above each mapped team role. Initial league setup is limited to Discord members with **Manage Server**; after setup, every action uses Hybrid's application roles and tenant context rather than Discord Administrator.

`npm run commands:register` performs global command registration from `COMMAND_DEFINITIONS`. Global updates may take time to propagate. It registers only `/league` and `/help`.

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
