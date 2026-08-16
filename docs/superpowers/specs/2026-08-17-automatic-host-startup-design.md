# Automatic Host Startup Design

## Goal

Allow Hybrid to be deployed to a managed host that exposes only a startup-file setting. Starting `dist/main.js` must prepare the application without a separate console session.

## Startup sequence

1. Load and validate environment configuration.
2. Open the MySQL connection and apply pending ordered migrations. The existing migration ledger and named MySQL advisory lock make this safe across restarts and multiple bot instances.
3. Register the current global Discord application commands using the configured token and client ID.
4. Construct and start the Hybrid application.

The command registration request is intentionally idempotent: Discord replaces the application command set with the current definitions.

## Failure and shutdown behaviour

If migration or command registration fails, startup aborts before the Discord client begins handling interactions. The error is logged by the existing `main` error boundary and the process exits non-zero so the host can surface the failure or retry it.

The database used exclusively for migration is closed before the application creates its own database connection. Existing signal-driven shutdown remains unchanged.

## Scope

This changes only the production entrypoint and introduces an isolated command-registration function that can be reused by the entrypoint and CLI script. It does not change league behavior, schema semantics, permissions, Discord UI, or database credentials.

## Verification

Tests will cover migration-before-start ordering, registration-before-start ordering, and failure short-circuiting. The existing full MySQL suite, typecheck, lint, and build will be rerun.
