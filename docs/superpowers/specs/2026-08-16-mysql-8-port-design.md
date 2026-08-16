# Hybrid MySQL 8 Port Design

## Goal

Run Hybrid's League Core on the user's MySQL 8.0.46 service without weakening its tenant isolation, transactionality, roster integrity, durable Discord-job processing, or interaction-route replay protections.

## Scope

This is a production-database-engine port. It changes Hybrid from PostgreSQL to MySQL 8.0 only. It does not add EA integration, fixture management, new public commands, or any new league product surface.

## Chosen approach

Implement a native MySQL 8 adapter and MySQL-native migrations. Raw SQL stays explicit in the domain repositories, but is rewritten where it relies on PostgreSQL syntax. This avoids a fragile SQL-transpilation layer and avoids supporting two production database engines before there is a need for that complexity.

The deployed application will use `mysql2/promise` and a MySQL URL. Tests will run against a disposable MySQL 8 instance rather than PGlite, so migration and concurrency behaviour is checked on the same SQL family as production.

## Architecture

### Database adapter

`src/platform/postgres.ts` becomes a focused MySQL adapter backed by a pooled `mysql2/promise` connection. The existing `TransactionalDatabase` and `SqlTransaction` interfaces remain stable, so domain services retain their transaction boundaries. The adapter exposes `transaction`, `migrate`, and `close`.

It uses InnoDB transactions, `START TRANSACTION` / `COMMIT` / `ROLLBACK`, and `?` value placeholders. Returned MySQL `RowDataPacket` objects are converted to ordinary row records at the adapter boundary.

### Migrations and schema

New MySQL migration files create the same domain model with engine-appropriate definitions:

- UUID values remain application-generated canonical strings and are stored as `CHAR(36)`, preserving stable external IDs and explicit ownership links.
- JSON audit/job/route state becomes the native `JSON` type.
- UTC timestamps use `DATETIME(3)` with `CURRENT_TIMESTAMP(3)` defaults; application code treats returned values as UTC.
- Existing check constraints remain declarative under MySQL 8.0.
- PostgreSQL partial unique indexes are represented with generated nullable columns and ordinary unique indexes. This preserves the one-active-row rules for staff assignments, memberships, registration requests, team Discord roles, and active interaction routes.
- Composite tenant foreign keys remain in place to prevent a member, team, or reviewer from crossing league boundaries.

No PostgreSQL migration is applied to MySQL. A fresh MySQL database receives its own ordered migration set and records applied versions in `hybrid_schema_migrations`.

### Migration locking

Migration execution uses one dedicated pooled connection and is serialized with MySQL's named lock (`GET_LOCK`) for the short migration session. MySQL DDL implicitly commits, so each migration file is executed first and is ledgered only after it succeeds; a failed file is never marked applied. Migration names are checked before execution so repeat application is safe. The lock is explicitly released in `finally`.

### Repository query changes

Every production query is converted deliberately rather than mechanically:

- `$n` parameters become ordered `?` placeholders.
- `INSERT ... ON CONFLICT` becomes MySQL's `INSERT ... ON DUPLICATE KEY UPDATE`.
- `RETURNING` is removed. Because Hybrid generates all entity UUIDs before writes, repositories reselect the intended tenant-scoped row within the same transaction after a guarded insert/update.
- `NOW()` and PostgreSQL interval expressions become MySQL UTC timestamp functions and `DATE_ADD` / `DATE_SUB`.
- JSON values are explicitly serialized for writes and parsed/normalised at the repository boundary for reads.
- Existing `SELECT ... FOR UPDATE` locking remains. The job claimer uses MySQL 8 `FOR UPDATE SKIP LOCKED` and rechecks state in its guarded update, preserving stale-worker and double-claim protection.

### Durable route and role-job behaviour

Opaque Discord route controls remain database-backed, actor-scoped, expiry-bound, signed, and single-use. Consumption changes from PostgreSQL `UPDATE ... RETURNING` to a conditional update plus tenant/actor/expiry reselect in the same transaction.

The role-sync queue retains its deduplication key, lease owner, lease expiry, attempt counter, and guarded completion/failure writes. InnoDB row locking plus `SKIP LOCKED` ensures concurrent workers cannot claim the same job.

## Configuration and deployment

`DATABASE_URL` will accept a `mysql://` or `mysqls://` URL, for example:

```dotenv
DATABASE_URL=mysql://USER:PERCENT_ENCODED_PASSWORD@HOST:3306/DATABASE
```

The README, `.env.example`, Docker Compose, scripts, and package dependencies will be updated for MySQL 8. The VPS package will remain free of `.env` files and dependencies; it will be installed with `npm ci`, configured with a newly rotated secret, migrated with `npm run migrate`, then started normally.

## Error handling and safety

- A non-MySQL URL fails configuration validation before Discord login.
- Failed migration DML rolls back; MySQL DDL is not transactionally reversible, so each migration is deliberately additive/idempotent and is never ledgered until its full file succeeds. The named lock is always released.
- Duplicate-key and deadlock errors are surfaced as application failures; domain guards and transaction locks preserve data integrity rather than silently retrying unsafe writes.
- The supplied credentials will not be embedded in code, documentation, tests, commits, or the deployment archive. A new password must be used after rotation.

## Verification

1. Add focused red/green tests for MySQL transaction rollback, repeat-safe migrations, tenant composite foreign keys, generated-column active-row uniqueness, durable route consumption, and job lease claiming.
2. Port all existing 61 behaviour tests to run against a disposable MySQL 8 test database.
3. Run the full test suite, typecheck, lint, build, and dependency audit.
4. With newly rotated deployment credentials, perform a read-only connectivity/version check and run the production migration command exactly once against the intended empty Hybrid database.

## Non-goals

- PostgreSQL/MySQL dual-engine support.
- Importing or converting legacy production data.
- Applying schema changes to an unknown non-Hybrid database.
- EA, fixtures, transfers, or additional command/UI scope.
