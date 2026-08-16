# Hybrid League Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Deliver a Discord-native League Core where /league guides setup, teams, registrations, approvals, and roster membership with tenant-safe persistence, audit history, and restart-safe role reconciliation.

**Architecture:** Implement a TypeScript modular monolith. Discord handlers only translate interactions to application-service calls; application services own authorization, validation, database transactions, audit insertion, and durable role-sync job creation. PostgreSQL is authoritative in production; PGlite provides an isolated PostgreSQL-compatible integration database for tests.

**Tech Stack:** Node.js 24.14.0, TypeScript 7.0.2, discord.js 14.27.0, PostgreSQL with Drizzle ORM 0.45.2, Zod 4.4.3, Pino 10.3.1, Vitest 4.1.10, PGlite 0.5.5.

## Global Constraints

- Keep the public command surface to /league and /help.
- Keep panels progressive, contextual, and ephemeral by default. Panels provide Home, Back, or Cancel where navigation applies.
- Do not add EA integration, EA data models, fixture generation, fixture scheduling, calendars, or fixture reminders.
- Keep the legacy directory read-only and never copy source, credentials, database files, Discord identities, or legacy data into Hybrid.
- Store Discord snowflakes as text and display names only as mutable metadata.
- Require LeagueContext for every tenant-owned query or mutation; never use an optional tenant ID.
- Recheck authorization for every command, button, select, and modal submission.
- Put domain change, append-only audit event, and role-sync job in one database transaction.
- Never send Discord role changes inside the transaction; use an idempotent, lease-claimed job worker.
- Redact tokens, raw interaction payloads, raw Discord content, and personal data from logs.
- Follow test-first red-green cycles for every production behavior.
- PostgreSQL is the production requirement. PGlite is test-only because Docker is unavailable in the current workspace.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| package.json | Dependencies and scripts. |
| src/main.ts | Process lifecycle: configuration, database, Discord client, role-sync worker. |
| src/platform/config.ts | Zod-validated environment configuration. |
| src/platform/database.ts | PostgreSQL pool, Drizzle database, transactions, graceful shutdown. |
| src/platform/schema.ts | Drizzle schema and row types. |
| src/platform/migrations/0000_league_core.sql | Tenant constraints, partial indexes, job indexes. |
| src/platform/test-db.ts | PGlite setup and migration runner for tests. |
| src/platform/errors.ts | Typed domain errors safe to render in Discord. |
| src/platform/logger.ts | Redacted Pino logger. |
| src/modules/permissions/service.ts | Bootstrap and effective-role authorization. |
| src/modules/league/service.ts | League creation, context resolution, dashboard summary. |
| src/modules/teams/service.ts | Team creation and contextual dashboards. |
| src/modules/registrations/service.ts | Registration state machine and review. |
| src/modules/rosters/service.ts | Atomic roster assignment/end-membership operations. |
| src/modules/audit/repository.ts | Append-only audit writer/history reader. |
| src/modules/discord-jobs/* | Idempotent role-sync enqueue, lease, retry, worker. |
| src/discord/* | Client, commands, router, component IDs, panel/modal builders. |
| tests/helpers/* | PGlite, deterministic clock, fake Discord gateway/interaction helpers. |
| tests/**/*.test.ts | Unit, integration, adapter, and end-to-end workflow tests. |
| .env.example, README.md, docker-compose.yml | Safe local setup and operations documentation. |

## Task 1: Establish the typed runnable foundation

**Files:**
- Create: package.json
- Create: tsconfig.json
- Create: vitest.config.ts
- Create: eslint.config.mjs
- Create: src/platform/config.ts
- Create: src/platform/logger.ts
- Create: src/main.ts
- Create: tests/platform/config.test.ts
- Create: .env.example
- Create: .gitignore

**Interfaces:**
- Produces loadConfig(env: NodeJS.ProcessEnv): AppConfig.
- Produces createLogger(level: AppConfig["logLevel"]): Logger.
- Produces scripts typecheck, lint, test, test:watch, build, dev, and db:generate.

- [ ] **Step 1: Write the failing configuration test**

    import { describe, expect, it } from "vitest";
    import { loadConfig } from "../../src/platform/config.js";

    describe("loadConfig", () => {
      it("parses the minimum production configuration", () => {
        expect(loadConfig({
          DISCORD_TOKEN: "token",
          DISCORD_CLIENT_ID: "123",
          DATABASE_URL: "postgres://hybrid:hybrid@localhost:5432/hybrid",
        })).toMatchObject({ discordClientId: "123", logLevel: "info" });
      });

      it("rejects an absent database URL without exposing environment values", () => {
        expect(() => loadConfig({ DISCORD_TOKEN: "secret", DISCORD_CLIENT_ID: "123" }))
          .toThrow("DATABASE_URL is required");
      });
    });

- [ ] **Step 2: Run the test to verify it fails**

Run: npm test -- tests/platform/config.test.ts

Expected: FAIL because src/platform/config.ts does not exist.

- [ ] **Step 3: Implement the minimum foundation**

    export type AppConfig = Readonly<{
      discordToken: string;
      discordClientId: string;
      databaseUrl: string;
      logLevel: "debug" | "info" | "warn" | "error";
    }>;

    export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
      const parsed = z.object({
        DISCORD_TOKEN: z.string().min(1, "DISCORD_TOKEN is required"),
        DISCORD_CLIENT_ID: z.string().regex(/^\\d+$/, "DISCORD_CLIENT_ID is required"),
        DATABASE_URL: z.string().url("DATABASE_URL is required"),
        LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
      }).parse(env);
      return { discordToken: parsed.DISCORD_TOKEN, discordClientId: parsed.DISCORD_CLIENT_ID,
        databaseUrl: parsed.DATABASE_URL, logLevel: parsed.LOG_LEVEL };
    }

Pin the versions named in the plan header. Enable strict, noUncheckedIndexedAccess, and NodeNext TypeScript settings. Configure logger redaction for authorization headers, token, content, interaction, and database URL paths. Make main exit cleanly after a configuration error.

- [ ] **Step 4: Run foundation checks**

Run: npm test -- tests/platform/config.test.ts && npm run typecheck && npm run lint && npm run build

Expected: PASS with no TypeScript errors, lint violations, or generated secrets.

- [ ] **Step 5: Commit**

    git add package.json package-lock.json tsconfig.json vitest.config.ts eslint.config.mjs src tests .env.example .gitignore
    git commit -m "chore: scaffold typed Hybrid bot"

## Task 2: Build the tenant-safe PostgreSQL schema and test database

**Files:**
- Create: src/platform/schema.ts
- Create: src/platform/database.ts
- Create: src/platform/test-db.ts
- Create: src/platform/migrations/0000_league_core.sql
- Create: tests/helpers/database.ts
- Create: tests/platform/schema.test.ts
- Create: drizzle.config.ts
- Create: docker-compose.yml

**Interfaces:**
- Consumes AppConfig from Task 1.
- Produces createDatabase(databaseUrl: string): AppDatabase.
- Produces withTransaction<T>(db: AppDatabase, fn: (tx: AppTransaction) => Promise<T>): Promise<T>.
- Produces createTestDatabase(): Promise<TestDatabase> with db, dispose(), and truncate().

- [ ] **Step 1: Write failing schema invariant tests**

    it("rejects a second active membership for one player in one league", async () => {
      const { db, dispose } = await createTestDatabase();
      await seedLeagueMember(db, { leagueId: "league-a", userId: "player-1" });
      await seedActiveMembership(db, { leagueId: "league-a", teamId: "team-a", userId: "player-1" });
      await expect(seedActiveMembership(db, {
        leagueId: "league-a", teamId: "team-b", userId: "player-1",
      })).rejects.toThrow(/active_team_membership_per_league/);
      await dispose();
    });

    it("rejects a membership whose team belongs to another league", async () => {
      const { db, dispose } = await createTestDatabase();
      await expect(seedCrossLeagueMembership(db)).rejects.toThrow(/league_id/);
      await dispose();
    });

- [ ] **Step 2: Run schema tests to verify they fail**

Run: npm test -- tests/platform/schema.test.ts

Expected: FAIL because createTestDatabase and the migration do not exist.

- [ ] **Step 3: Implement schema, migration, and PGlite test harness**

Create tables for leagues, discord_users, league_members, staff_assignments, teams, team_memberships, registration_requests, audit_events, discord_resources, and discord_jobs. Use UUID primary keys, timestamptz timestamps, jsonb audit fields, text snowflakes, tenant composite foreign keys, and partial unique indexes named active_team_membership_per_league and open_registration_per_league.

    export async function withTransaction<T>(
      db: AppDatabase,
      fn: (tx: AppTransaction) => Promise<T>,
    ): Promise<T> {
      return db.transaction(async (tx) => fn(tx));
    }

The PGlite helper applies 0000_league_core.sql before each test and never reads DATABASE_URL. docker-compose.yml contains only a local PostgreSQL service; .env.example supplies non-secret placeholders.

- [ ] **Step 4: Run schema checks**

Run: npm test -- tests/platform/schema.test.ts && npm run typecheck && npm run lint

Expected: PASS; duplicate and cross-tenant inserts fail because of database constraints.

- [ ] **Step 5: Commit**

    git add drizzle.config.ts docker-compose.yml src/platform tests/helpers tests/platform
    git commit -m "feat: add tenant-safe League Core schema"

## Task 3: Implement league bootstrap, context resolution, and permissions

**Files:**
- Create: src/platform/errors.ts
- Create: src/modules/permissions/types.ts
- Create: src/modules/permissions/service.ts
- Create: src/modules/league/types.ts
- Create: src/modules/league/service.ts
- Create: tests/modules/league/service.test.ts
- Create: tests/modules/permissions/service.test.ts

**Interfaces:**
- Consumes AppTransaction and schema types from Task 2.
- Produces LeagueContext = { leagueId: string; discordGuildId: string; actor: LeagueActor }.
- Produces bootstrapLeague(input: BootstrapLeagueInput): Promise<LeagueContext>.
- Produces resolveLeagueContext(discordGuildId: string, discordUserId: string): Promise<LeagueContext | null>.
- Produces requirePermission(context: LeagueContext, permission: Permission): void.

- [ ] **Step 1: Write failing bootstrap and authorization tests**

    it("makes the eligible bootstrapper the initial league owner", async () => {
      const league = await leagueService.bootstrapLeague({
        discordGuildId: "guild-1",
        actor: member("owner-1", { manageGuild: true }),
        name: "Hybrid League",
        defaultRosterCap: 12,
      });
      expect(league.actor.role).toBe("OWNER");
      await expect(leagueService.bootstrapLeague({
        discordGuildId: "guild-1",
        actor: member("other", { manageGuild: true }),
        name: "Other",
        defaultRosterCap: 12,
      })).rejects.toMatchObject({ code: "LEAGUE_ALREADY_EXISTS" });
    });

    it("does not allow a Discord administrator alone to review registration", async () => {
      const context = await seedLeagueContext({ role: "PLAYER", discordAdministrator: true });
      expect(() => requirePermission(context, "REGISTRATION_REVIEW")).toThrow(/not permitted/i);
    });

- [ ] **Step 2: Run tests to verify they fail**

Run: npm test -- tests/modules/league/service.test.ts tests/modules/permissions/service.test.ts

Expected: FAIL because services do not exist.

- [ ] **Step 3: Implement bootstrap and application permissions**

Use DomainError codes including LEAGUE_ALREADY_EXISTS, LEAGUE_NOT_FOUND, and FORBIDDEN. Allow first creation only with ManageGuild. Persist the league, Discord user, league member, owner assignment, and league.created audit event in one transaction. Resolve roles from Hybrid staff assignments and active team membership, not Discord administrator flags after bootstrap.

    export type Permission =
      | "LEAGUE_SETTINGS"
      | "TEAM_MANAGE"
      | "REGISTRATION_REVIEW"
      | "ROSTER_MANAGE";

- [ ] **Step 4: Run focused checks**

Run: npm test -- tests/modules/league/service.test.ts tests/modules/permissions/service.test.ts && npm run typecheck

Expected: PASS; duplicate bootstrap and unauthorized review leave no partial records.

- [ ] **Step 5: Commit**

    git add src/platform/errors.ts src/modules/league src/modules/permissions tests/modules/league tests/modules/permissions
    git commit -m "feat: add league bootstrap and permissions"

## Task 4: Implement append-only auditing and teams

**Files:**
- Create: src/modules/audit/repository.ts
- Create: src/modules/audit/types.ts
- Create: src/modules/teams/types.ts
- Create: src/modules/teams/service.ts
- Create: tests/modules/teams/service.test.ts
- Create: tests/modules/audit/repository.test.ts

**Interfaces:**
- Consumes LeagueContext, requirePermission, and AppTransaction.
- Produces appendAuditEvent(tx, event: AuditEventInput): Promise<void>.
- Produces listEntityHistory(context, entityType, entityId): Promise<AuditEvent[]>.
- Produces createTeam(context, input: CreateTeamInput): Promise<TeamDashboard>.
- Produces getTeamDashboard(context, teamId): Promise<TeamDashboard>.

- [ ] **Step 1: Write failing team/audit tests**

    it("creates a team and records an immutable audit event atomically", async () => {
      const team = await teams.createTeam(ownerContext, {
        name: "Northstar", rosterCap: 12, discordRoleId: "role-1",
      });
      expect(team).toMatchObject({ name: "Northstar", rosterCount: 0, rosterCap: 12 });
      expect(await audit.listEntityHistory(ownerContext, "team", team.id))
        .toMatchObject([{ action: "team.created", actorDiscordUserId: "owner-1" }]);
    });

    it("does not expose a league A team to a league B manager", async () => {
      await expect(teams.getTeamDashboard(leagueBManager, leagueATeam.id))
        .rejects.toMatchObject({ code: "TEAM_NOT_FOUND" });
    });

- [ ] **Step 2: Run tests to verify they fail**

Run: npm test -- tests/modules/teams/service.test.ts tests/modules/audit/repository.test.ts

Expected: FAIL because teams and audit services do not exist.

- [ ] **Step 3: Implement team and audit services**

Validate normalized team names, roster cap from 1 through 99, and one Discord-role mapping per league. createTeam requires TEAM_MANAGE, inserts team and team.created audit event in one transaction, and returns manager metadata, roster count, capacity, and status. getTeamDashboard always filters by context.leagueId and returns TEAM_NOT_FOUND for another tenant.

- [ ] **Step 4: Run focused checks**

Run: npm test -- tests/modules/teams/service.test.ts tests/modules/audit/repository.test.ts && npm run lint

Expected: PASS; team creation has one audit event and cross-tenant reads fail safely.

- [ ] **Step 5: Commit**

    git add src/modules/audit src/modules/teams tests/modules/teams tests/modules/audit
    git commit -m "feat: add teams and audit history"

## Task 5: Implement registration and serialized staff review

**Files:**
- Create: src/modules/registrations/types.ts
- Create: src/modules/registrations/service.ts
- Create: tests/modules/registrations/service.test.ts

**Interfaces:**
- Consumes LeagueContext, requirePermission, appendAuditEvent, and withTransaction.
- Produces requestRegistration(context, input): Promise<Registration>.
- Produces withdrawRegistration(context, registrationId): Promise<Registration>.
- Produces reviewRegistration(context, input): Promise<Registration>.
- Produces listPendingRegistrations(context): Promise<RegistrationSummary[]>.

- [ ] **Step 1: Write failing registration-state and race tests**

    it("allows only one staff review to win a concurrent pending registration", async () => {
      const registration = await registrations.requestRegistration(playerContext, {
        displayName: "Player One",
      });
      const results = await Promise.allSettled([
        registrations.reviewRegistration(staffOne, { registrationId: registration.id, decision: "APPROVE" }),
        registrations.reviewRegistration(staffTwo, { registrationId: registration.id, decision: "DECLINE" }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(await registrations.getRegistration(leagueContext, registration.id))
        .toMatchObject({ status: expect.stringMatching(/APPROVED|DECLINED/) });
    });

    it("rejects a duplicate pending request and lets its player withdraw it", async () => {
      await registrations.requestRegistration(playerContext, { displayName: "Player One" });
      await expect(registrations.requestRegistration(playerContext, { displayName: "Player One" }))
        .rejects.toMatchObject({ code: "REGISTRATION_ALREADY_OPEN" });
    });

- [ ] **Step 2: Run registration tests to verify they fail**

Run: npm test -- tests/modules/registrations/service.test.ts

Expected: FAIL because the registration service does not exist.

- [ ] **Step 3: Implement the registration state machine**

Use PENDING, APPROVED, DECLINED, and WITHDRAWN states. Lock the registration row with SELECT FOR UPDATE during review, require REGISTRATION_REVIEW, and allow exactly one pending-to-final transition. Request creates/updates the league member's cached Discord metadata and inserts registration.requested; it never creates team membership. Review and withdrawal each append audit history inside the same transaction.

- [ ] **Step 4: Run focused checks**

Run: npm test -- tests/modules/registrations/service.test.ts && npm run typecheck

Expected: PASS; one concurrent review succeeds, the other returns REGISTRATION_NOT_PENDING, and each state transition is audited.

- [ ] **Step 5: Commit**

    git add src/modules/registrations tests/modules/registrations
    git commit -m "feat: add player registration review"

## Task 6: Implement atomic rosters and durable role-sync jobs

**Files:**
- Create: src/modules/rosters/types.ts
- Create: src/modules/rosters/service.ts
- Create: src/modules/discord-jobs/repository.ts
- Create: tests/modules/rosters/service.test.ts
- Create: tests/modules/discord-jobs/repository.test.ts

**Interfaces:**
- Consumes team, registration, audit, and permission services.
- Produces assignPlayerToTeam(context, input): Promise<TeamMembership>.
- Produces endTeamMembership(context, input): Promise<TeamMembership>.
- Produces enqueueRoleSync(tx, input): Promise<DiscordJob>.
- Produces claimDiscordJobs(workerId, limit, leaseSeconds): Promise<DiscordJob[]>.

- [ ] **Step 1: Write failing roster integrity and job-deduplication tests**

    it("never exceeds cap when two assignments race for the final place", async () => {
      const team = await seedTeam({ rosterCap: 1 });
      const results = await Promise.allSettled([
        rosters.assignPlayerToTeam(adminContext, { teamId: team.id, playerId: playerA.id, role: "PLAYER" }),
        rosters.assignPlayerToTeam(adminContext, { teamId: team.id, playerId: playerB.id, role: "PLAYER" }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(await activeRosterCount(team.id)).toBe(1);
    });

    it("creates one role-sync job with its membership transition", async () => {
      const membership = await rosters.assignPlayerToTeam(adminContext, assignment);
      expect(await jobs.listByDeduplicationKey("role-sync:" + membership.id)).toHaveLength(1);
    });

- [ ] **Step 2: Run roster tests to verify they fail**

Run: npm test -- tests/modules/rosters/service.test.ts tests/modules/discord-jobs/repository.test.ts

Expected: FAIL because roster and job services do not exist.

- [ ] **Step 3: Implement atomic membership transitions**

Require approved registration. In one transaction, lock team and player active memberships; reject an existing team, a full roster, cross-league IDs, and a non-manager actor. Insert membership, roster.player_assigned audit event, and idempotent ROLE_SYNC job keyed by membership ID. Ending membership appends roster.player_removed and queues recalculation. enqueueRoleSync preserves completed-job history and coalesces incomplete work by deduplication key.

- [ ] **Step 4: Run focused checks**

Run: npm test -- tests/modules/rosters/service.test.ts tests/modules/discord-jobs/repository.test.ts && npm run lint

Expected: PASS; cap and unique membership hold under concurrent calls, audit/job records commit atomically.

- [ ] **Step 5: Commit**

    git add src/modules/rosters src/modules/discord-jobs tests/modules/rosters tests/modules/discord-jobs
    git commit -m "feat: add atomic roster membership"

## Task 7: Implement role reconciliation recovery

**Files:**
- Create: src/modules/discord-jobs/worker.ts
- Create: tests/modules/discord-jobs/worker.test.ts

**Interfaces:**
- Consumes job repository from Task 6 and DiscordRoleGateway.
- Produces DiscordRoleGateway with getMemberRoles, setMemberRoles, and roleExists methods.
- Produces RoleSyncWorker.runOnce(): Promise<WorkerRunSummary>.

- [ ] **Step 1: Write failing recovery and deleted-role tests**

    it("reclaims an expired lease and completes sync exactly once", async () => {
      await jobs.enqueueRoleSync(seedTransaction, jobInput);
      await jobs.claimDiscordJobs("crashed-worker", 1, 1);
      clock.advanceSeconds(2);
      await worker.runOnce();
      expect(fakeGateway.setMemberRoles).toHaveBeenCalledTimes(1);
      expect(await jobs.statusFor(jobInput.deduplicationKey)).toBe("COMPLETED");
    });

    it("marks a deleted mapped role unavailable and preserves roster state", async () => {
      fakeGateway.roleExists.mockResolvedValue(false);
      await worker.runOnce();
      expect(await teams.roleState(team.id)).toBe("UNAVAILABLE");
      expect(await activeRosterCount(team.id)).toBe(1);
    });

- [ ] **Step 2: Run worker tests to verify they fail**

Run: npm test -- tests/modules/discord-jobs/worker.test.ts

Expected: FAIL because worker and gateway port do not exist.

- [ ] **Step 3: Implement lease-safe reconciliation**

Claim queued work whose availability arrived or whose lease expired. Recalculate desired Hybrid roles when executing; never replay stale role IDs. Retry rate-limit/network errors with bounded backoff. For a missing role, mark mapping unavailable, append discord.role_unavailable, complete the job as handled, and never create or remove unrelated Discord roles. Complete a job only after the gateway confirms its desired role set.

- [ ] **Step 4: Run focused checks**

Run: npm test -- tests/modules/discord-jobs/worker.test.ts && npm run typecheck

Expected: PASS; crashed leases recover, duplicate work is suppressed, deleted roles leave database roster intact.

- [ ] **Step 5: Commit**

    git add src/modules/discord-jobs tests/modules/discord-jobs
    git commit -m "feat: add resilient Discord role sync"

## Task 8: Build the small /league and /help interaction surface

**Files:**
- Create: src/discord/client.ts
- Create: src/discord/commands.ts
- Create: src/discord/router.ts
- Create: src/discord/types.ts
- Create: src/discord/ui/ids.ts
- Create: src/discord/ui/league-dashboard.ts
- Create: src/discord/ui/setup-wizard.ts
- Create: src/discord/ui/team-dashboard.ts
- Create: src/discord/ui/registration-panel.ts
- Create: src/discord/ui/confirmation.ts
- Create: tests/discord/commands.test.ts
- Create: tests/discord/router.test.ts
- Create: tests/discord/ui/league-dashboard.test.ts

**Interfaces:**
- Consumes all application services through ApplicationServices.
- Produces COMMAND_DEFINITIONS containing exactly /league and /help.
- Produces encodeComponentId(route): string and decodeComponentId(value): ComponentRoute | null.
- Produces renderLeagueDashboard(input): InteractionReplyOptions.
- Produces handleInteraction(interaction, services): Promise<void>.

- [ ] **Step 1: Write failing command, visibility, and stale-control tests**

    it("registers only league and help commands", () => {
      expect(COMMAND_DEFINITIONS.map((command) => command.name)).toEqual(["league", "help"]);
    });

    it("shows setup only to ManageGuild before a league exists", async () => {
      const reply = await renderFor(fakeCommand("league", { manageGuild: false }), emptyGuildServices);
      expect(buttonLabels(reply)).not.toContain("Set up Hybrid");
    });

    it("rejects stale or unauthorized component actions", async () => {
      await expect(routeComponent(staleApproveButton, playerInteraction, services))
        .rejects.toMatchObject({ code: "ACTION_EXPIRED" });
    });

- [ ] **Step 2: Run adapter tests to verify they fail**

Run: npm test -- tests/discord/commands.test.ts tests/discord/router.test.ts tests/discord/ui/league-dashboard.test.ts

Expected: FAIL because Discord adapter and UI builders do not exist.

- [ ] **Step 3: Implement progressive interaction UI**

Register exactly /league and /help. /league defers ephemerally and routes an eligible unconfigured user to setup; otherwise it shows member registration/profile context, a manager team card, or staff registrations/settings. Use one navigation row: Home/Back/Cancel plus contextual actions. Use selects for team and registration lists, modals for text, and explicit confirmation cards for mutation. Component routes include opaque entity ID/version then reload live state before calling service. Map DomainError to concise corrective response; unexpected errors return a correlation ID and log redacted detail.

- [ ] **Step 4: Run focused checks**

Run: npm test -- tests/discord/commands.test.ts tests/discord/router.test.ts tests/discord/ui/league-dashboard.test.ts && npm run lint

Expected: PASS; command surface stays small, controls are contextual, stale/unauthorized actions are denied.

- [ ] **Step 5: Commit**

    git add src/discord tests/discord
    git commit -m "feat: add guided league dashboard"

## Task 9: Compose the app, document it, and verify end-to-end

**Files:**
- Modify: src/main.ts
- Create: src/app.ts
- Create: tests/e2e/league-core.test.ts
- Create: README.md
- Modify: .env.example
- Modify: package.json

**Interfaces:**
- Consumes createDatabase, loadConfig, RoleSyncWorker, Discord client/router, and application services.
- Produces createHybridApplication(dependencies): HybridApplication with start() and stop().

- [ ] **Step 1: Write failing end-to-end workflow test**

    it("guides setup through registration, approval, roster assignment, audit, and role reconciliation", async () => {
      const app = await createTestApplication();
      await app.interactions.command("league", owner({ manageGuild: true }));
      await app.interactions.submitSetup({ name: "North League", rosterCap: 2 });
      await app.interactions.createTeam(owner(), { name: "Northstar", rosterCap: 2, discordRoleId: "role-northstar" });
      await app.interactions.command("league", player("player-1"));
      await app.interactions.requestRegistration({ displayName: "Player One" });
      await app.interactions.approveRegistration(owner(), "player-1");
      await app.interactions.assignRoster(owner(), { playerId: "player-1", teamName: "Northstar" });
      await app.runRoleSync();

      expect(await app.database.auditActions()).toEqual(expect.arrayContaining([
        "league.created", "team.created", "registration.requested",
        "registration.approved", "roster.player_assigned",
      ]));
      expect(app.gateway.rolesFor("player-1")).toEqual(new Set(["role-northstar"]));
    });

- [ ] **Step 2: Run end-to-end test to verify it fails**

Run: npm test -- tests/e2e/league-core.test.ts

Expected: FAIL because composition root and interaction harness do not exist.

- [ ] **Step 3: Implement composition root and safe operations documentation**

createHybridApplication constructs database, services, worker, and Discord router once; main starts only after config passes and stops on SIGINT/SIGTERM. README documents PostgreSQL startup, migrations, development, command registration, test commands, Discord OAuth scopes, and the intentional absence of EA/fixtures. It includes no real tokens, server IDs, or production URLs.

- [ ] **Step 4: Run release verification**

Run: npm test && npm run typecheck && npm run lint && npm run build

Expected: PASS; the end-to-end flow executes against PGlite and fake Discord gateway.

- [ ] **Step 5: Inspect and commit release candidate**

Run: git diff --check && git status --short && git log --oneline --decorate -10

Expected: no whitespace errors; only intended League Core files are changed.

    git add README.md .env.example package.json package-lock.json src/main.ts src/app.ts tests/e2e
    git commit -m "feat: deliver Hybrid League Core"

## Plan Self-Review

### Spec coverage

- Guided /league setup, contextual dashboards, confirmation navigation, and /help: Tasks 8-9.
- Multi-league isolation, Discord identity handling, composite tenant relationships, audit records, and durable resources/jobs: Task 2.
- Application roles, bootstrap guard, and reauthorization: Tasks 3 and 8.
- Teams, cap-bound rosters, registrations, approvals, and membership history: Tasks 4-6.
- Durable retry/lease role reconciliation and deleted-role recovery: Task 7.
- Test-first, type, lint, build, and end-to-end validation: every task, with complete suite in Task 9.
- Explicit EA/fixture exclusion: Global Constraints and README review in Task 9.
- Transfers, discipline, manual results, statistics, and awards are deliberately outside this plan.

### Placeholder scan

Every task names files, interfaces, a failing behavioral test, an expected red command result, concrete implementation rules, a green command result, and a commit.

### Type consistency

LeagueContext is created in Task 3 and consumed by tenant modules. AppDatabase/AppTransaction are created in Task 2 and consumed by services. DiscordJob is defined in Task 2, enqueued in Task 6, and executed in Task 7. ApplicationServices and HybridApplication compose those interfaces in Tasks 8 and 9.
