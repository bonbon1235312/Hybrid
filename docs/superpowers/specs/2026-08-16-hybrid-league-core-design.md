# Hybrid League Core Design

## Purpose

Build Hybrid as a Discord-native, multi-league management application that is
easy to operate from a single guided entry point while keeping validation,
permissions, recovery, and auditability below the surface. This document
covers the first usable vertical slice only: league setup, teams, player
registration and approval, roster membership, application permissions, role
reconciliation, and audit history.

## Product boundaries

Hybrid is a fresh TypeScript/Node.js project in `C:\Hybrid`. The legacy bot is
only a behavioural reference and is never copied or modified.

This slice deliberately excludes:

- EA APIs, EA club/match polling, provider payloads, automatic imports, and
  EA-specific retries.
- Fixture generation, fixture scheduling, matchday workflows, calendars, and
  fixture reminders.
- Transfers, discipline, manual results, statistics, awards, and graphics;
  they are separate follow-on vertical slices after League Core is verified.
- Command families that expose implementation detail. The initial command
  surface is `/league` and `/help`.

The legacy circle-method fixture generator is good engineering, but is left
behind because fixtures are outside Hybrid's product boundary.

## Technical baseline

- Node.js 24.14.0 and strict TypeScript.
- discord.js 14.27.0.
- PostgreSQL as the authoritative database, accessed through Drizzle ORM 0.45.2
  with checked-in SQL migrations.
- Zod 4.4.3 for environment and interaction-input validation.
- Pino 10.3.1 for structured logging with redaction.
- Vitest 4.1.10 for unit, repository, application-service, and interaction
  adapter tests.

PostgreSQL is chosen over a local SQLite file because League Core requires
tenant-safe constraints, concurrent approvals, durable job leases, and a
credible path to more than one bot process. The bot remains a modular monolith:
one deployable process with explicit module boundaries rather than a fleet of
services.

## Module boundaries

`src/discord` owns command registration, component routing, interaction
acknowledgement, embeds, navigation controls, and mapping application outcomes
to Discord responses. It contains no business rules or direct SQL.

`src/modules/league`, `teams`, `players`, `registrations`, `permissions`, and
`audit` each own their domain types, validation, application services, and
repositories. `src/platform` owns configuration, database transactions,
logging, clocks, identifiers, and the durable Discord-job worker. Cross-module
work occurs only through application-service interfaces inside one transaction.

Each interaction enters with a `LeagueContext` resolved from the Discord guild.
Repositories require that context and never accept an optional tenant ID.
Queries and mutations are therefore impossible to write accidentally without a
league scope.

## Data model and invariants

Every league-owned row includes `league_id`; relationships that cross league
boundaries use composite foreign keys including `league_id`. Discord snowflakes
are stored as text so JavaScript never loses precision. Discord display names
are cached as metadata and never treated as identity.

The first migration creates these records:

- `leagues`: immutable ID, unique Discord guild ID, configured name, default
  roster cap, lifecycle state, and timestamps.
- `discord_users`: global Discord identity with last-known display metadata.
- `league_members`: a user's membership/status within one league.
- `staff_assignments`: league owner, administrator, and staff assignments.
- `teams`: tenant-owned team identity, status, roster cap, and optional mapped
  Discord role.
- `team_memberships`: historical player, manager, and captain memberships with
  active/end states.
- `registration_requests`: historical requests with pending, approved,
  declined, or withdrawn state and reviewer metadata.
- `audit_events`: append-only actor, entity, action, correlation ID, and
  before/after JSON snapshot.
- `discord_resources`: durable keys for messages, channels, and roles that may
  need repair after Discord objects are renamed or deleted.
- `discord_jobs`: idempotent, lease-claimed, retryable role-reconciliation work.

Database constraints enforce one active team membership per player within a
league, one live registration request per player within a league, roster limits
under concurrent writes, and no cross-league relationships. Application
services also lock the relevant team and player rows before changing rosters.
This preserves the legacy bot's useful approval-race behaviour without copying
its large database module.

## Permission policy

The first person to initialise Hybrid in a guild must have Discord's
`ManageGuild` permission; this is a bootstrap safeguard only. Thereafter Hybrid
uses its own tenant-scoped roles:

- League owner: all league settings and staff management.
- League administrator: teams, registrations, rosters, and operations.
- League staff: registration review and explicitly assigned operations.
- Team manager: their team's roster actions.
- Captain: read-only roster context in this slice, ready for narrowly scoped
  future powers.
- Player/member: own profile and registration actions.

Every button, select, modal submission, and command rechecks this policy on the
server. Hidden controls improve clarity; authorization checks enforce safety.

## Discord experience

`/league` is the application entry point. It responds ephemerally by default
and renders a concise context card, not a command manual.

For an unconfigured guild, `/league` shows a three-step setup wizard: name the
league, choose the default roster limit, then confirm the owner and settings.
Only the bootstrap-eligible user sees the confirmation action.

For a configured league, the dashboard shows league name, the caller's role,
team/player/registration counts, and only relevant next actions. Its first
level contains Teams, Players, Registrations, and Settings; members see their
profile/registration path, managers see their team context, and staff see
review/configuration paths. Selecting a team opens a compact team dashboard
with manager, current roster count/cap, status, and contextual actions.

Player registration, team creation, roster assignment, approval, withdrawal,
and settings changes use modals or selects followed by an explicit confirmation
card. Panels offer Home, Back, and Cancel. Component IDs encode only an action,
opaque entity ID, and version; current data and permissions are always loaded
again before a change. This keeps messages restart-safe without trusting stale
Discord UI state.

## Transaction, reconciliation, and error behaviour

An application service performs each mutation in this order:

1. Resolve the tenant and effective permission.
2. Validate input and current state.
3. Lock affected rows and apply the domain transition in one database
   transaction.
4. Append an audit event in that same transaction.
5. Insert a deduplicated Discord role-sync job in that transaction when needed.
6. Return a view model for the interaction layer.

The worker claims jobs with a lease, retries transient Discord failures using a
bounded backoff, and records the final outcome. It recalculates the desired
role set from Hybrid's database before each attempt, so an earlier failed job
cannot apply stale membership. Deleted Discord roles are marked unavailable,
logged, and surfaced to league administrators; they are never silently
recreated or used for mass actions.

Expected domain errors become concise ephemeral guidance. Unexpected failures
log a redacted structured event with a correlation ID and return that ID to the
user. Tokens, interaction payloads, raw Discord content, and personally
identifying data are not logged by default.

## Test and verification strategy

Development follows test-first cycles. The initial suite proves the behaviours
worth carrying from the legacy bot:

- two leagues cannot read or mutate one another's teams, registrations, or
  memberships;
- concurrent approval or roster actions yield exactly one legal transition;
- roster-cap, duplicate-player, withdrawn-registration, and invalid-role
  transitions fail without partial writes;
- all successful mutations have an audit event;
- role-sync jobs are idempotent, lease-safe, and recover after simulated
  worker interruption;
- controls are filtered for the caller and unauthorized component interactions
  are rejected server-side;
- deleted or missing Discord roles do not corrupt league state.

An end-to-end adapter test runs the setup, registration, approval, team
assignment, audit, and role-sync flow against an isolated PostgreSQL database
and a fake Discord gateway. Command-registration payloads are also verified.
Live Discord verification is explicitly deferred until the bot token and test
guild are supplied; no credentials are needed or created during this slice.

## Legacy knowledge retained and rejected

Retained as concepts: tenant-scoped data access, approval serialization and
restart recovery, roster integrity, durable resource identities, explicit audit
history, role reconciliation, and safe recovery from deleted Discord objects.

Rebuilt rather than copied: the legacy monolithic `database.py`, intertwined
Discord mutations, per-command permission checks, and persistent view code.
Hybrid centralises transaction boundaries and keeps Discord side effects in a
durable worker.

Rejected: EA/collector code, fixture code, destructive full-table Supabase
mirror, hard-coded seasonal bootstrap data, monitoring that forwards PII, and
all bundled legacy data or credentials.

## Delivery sequence

1. Deliver and verify League Core exactly as defined here.
2. Report the built experience and the reliability behaviours adapted from the
   legacy archive.
3. Design Transfers as the next isolated vertical slice, using serialized
   two-party approvals and transaction-safe roster movement.
