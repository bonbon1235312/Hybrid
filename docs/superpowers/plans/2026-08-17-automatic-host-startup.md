# Automatic Host Startup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow `dist/main.js` to register Hybrid's Discord commands before starting, with no console-only setup step.

**Architecture:** `createHybridApplication` already applies the MySQL migration ledger before Discord login. Extract REST command registration into a reusable function, call it from `main` after configuration validation and before application construction, and retain the CLI as a wrapper around the same function.

**Tech Stack:** TypeScript, Node.js 24.14+, discord.js REST API, MySQL 8, Vitest.

## Global Constraints

- Preserve the existing ordered migration ledger and MySQL advisory lock.
- Use the configured Discord token and application client ID.
- Registration failures prevent Discord login and exit non-zero through the existing error boundary.
- Never commit credentials.

---

### Task 1: Reusable registration and startup orchestration

**Files:**
- Modify: `src/discord/register-commands.ts`
- Modify: `src/main.ts`
- Create: `tests/main.test.ts`

**Interfaces:**
- Produces: `registerDiscordCommands(config: Pick<AppConfig, "discordToken" | "discordClientId">): Promise<void>`.
- Produces: `startHybrid(dependencies): Promise<void>` for dependency-injected startup tests.

- [ ] Step 1: Write a red test that injects registration and application factories into `startHybrid`, asserts calls are `register` then `start`, and a second test that registration rejection prevents application construction.
- [ ] Step 2: Run `npm test -- tests/main.test.ts`; expect failure because `startHybrid` does not exist.
- [ ] Step 3: Extract `registerDiscordCommands` from the CLI script; use `REST({ version: "10" })`, the configured token, `Routes.applicationCommands(config.discordClientId)`, and `COMMAND_DEFINITIONS`.
- [ ] Step 4: Implement `startHybrid` to load config, await registration, construct the app, install signal-driven stop handlers, then await `app.start()`.
- [ ] Step 5: Update the CLI script to call the reusable registration function, run the focused tests, and commit `feat: register Discord commands during startup`.

### Task 2: Managed-host guidance and package

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: automatic startup from Task 1.
- Produces: no-console deployment instructions for `dist/main.js`.

- [ ] Step 1: State in README that `dist/main.js` applies pending MySQL migrations and synchronizes Discord commands before logging in.
- [ ] Step 2: Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`, and `npm audit --omit=dev` with the guarded remote MySQL test environment.
- [ ] Step 3: Build a ZIP with tracked files and `dist/`; verify `dist/main.js`, migrations, `.env.example`, `package.json`, and `package-lock.json` are present and `.env` and `node_modules` are absent.
- [ ] Step 4: Commit the documentation change as `docs: explain automatic managed-host startup`.
