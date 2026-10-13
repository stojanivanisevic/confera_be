# confera_be

The API of **Confera**, the web application for the conferences and membership of the
association UdEkoM Balkans. NestJS 12, Prisma 7 and PostgreSQL 18, written in strict
TypeScript. The web application lives in the repository `confera_fe`.

This README is all you need for a fresh clone: follow sections 1 and 2 from top to
bottom. If a step is missing here, that is a defect; please report it.

## 1. What you need

| Tool     | Version                                     | Check                    |
| -------- | ------------------------------------------- | ------------------------ |
| Node.js  | 22 LTS, 22.13 or later (developed on 22.14) | `node --version`         |
| corepack | the one that comes with Node 22 (0.31)      | `corepack --version`     |
| Docker   | with Docker Compose v2, **running**         | `docker compose version` |
| git      | any current version                         | `git --version`          |

You do **not** install pnpm. Its version is pinned in `package.json` (`packageManager`:
pnpm 11.28.2 with its hash) and corepack downloads it on first use.

**Every command in this README starts with `corepack pnpm`.** On Windows `corepack enable`
needs administrator rights (it writes into `C:\Program Files\nodejs`); `corepack pnpm ...`
needs none and does the same. If you did run `corepack enable`, plain `pnpm ...` works too.

The commands are the same in PowerShell, cmd, Git Bash, macOS and Linux.

Ports used on your machine, all bound to 127.0.0.1: **3001** (API), **5432**
(PostgreSQL), **8025** and **1025** (Mailpit), and **4010** when you start the stub slot
(section 9). They must be free.

## 2. First start

```
git clone https://github.com/stojanivanisevic/confera_be.git
cd confera_be
```

**Step 1. Create your local environment file.** Its values work as they are; none is a
secret.

- Windows (PowerShell or cmd): `copy .env.example .env`
- macOS, Linux, Git Bash: `cp .env.example .env`

**Step 2. Install the dependencies.** The install never changes the lockfile, and it
generates the Prisma client at the end.

```
corepack pnpm install
```

**Step 3. Run all checks.** They need no database and no Docker, only the network (for
the vulnerability audit). Three to six minutes.

```
corepack pnpm check
```

It ends with `check passed`.

**Step 4. Start the development stack** (PostgreSQL and Mailpit in Docker). The first
time it downloads two images.

```
corepack pnpm stack:up
```

**Step 5. Create the database roles and the database, then the schema.**

```
corepack pnpm db:provision
corepack pnpm db:migrate
```

`db:provision` ends with `Database "confera" is provisioned.`, `db:migrate` with
`All migrations have been successfully applied.` Both are safe to run again.

**Step 6. Start the API.**

```
corepack pnpm build
corepack pnpm start
```

The log is JSON lines and ends with `"msg":"api.started"`. In a second terminal:

| Open                                 | You get                                       |
| ------------------------------------ | --------------------------------------------- |
| <http://localhost:3001/health>       | `{"status":"ok"}`                             |
| <http://localhost:3001/health/ready> | `{"status":"ok"}` (the database answers)      |
| <http://localhost:3001/api/v1/meta>  | `{"name":"confera-api","version":"0.1.0"}`    |
| <http://127.0.0.1:3001/api/v1/meta>  | **404** `not_found`. That is right: section 5 |

Stop the API with Ctrl+C.

**Step 7. Run the tests that need the database.** They build the application, create a
database of their own (`confera_integration_test`) with the same two commands as step 5,
and leave your development database alone. Four to eight minutes.

```
corepack pnpm test:int
```

It ends with `Tests: ... passed` and no failure.

**Step 8. Run the end-to-end tests.** They start the real application on a database of
their own (`confera_e2e_test`), created with the same two commands as step 5, and send
HTTP requests to it. They also talk to the mail catcher. About one minute.

```
corepack pnpm test:e2e
```

It ends with `Tests: ... passed` and no failure.

**Step 9. Stop the stack when you are done.**

```
corepack pnpm stack:down
```

The data stays in the Docker volume `confera_pgdata`. To start from an empty database
again: `corepack pnpm stack:down`, then `docker volume rm confera_pgdata`, then steps 4
and 5.

## 3. Commands

| Command                                 | What it does                                                                                                                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `corepack pnpm check`                   | Formatting, lint, typecheck, unit tests, both builds, OpenAPI check, tests of the built application, supply-chain checks and their planted cases. Green before a change is handed over. |
| `corepack pnpm test`                    | Unit and architecture tests. No build, no Docker.                                                                                                                                       |
| `corepack pnpm test:build`              | Tests that start the built application. Needs `build` and `build:dev` first; `check` runs them in the right order.                                                                      |
| `corepack pnpm test:int`                | Integration tests against PostgreSQL in Docker. Needs `stack:up`; builds by itself.                                                                                                     |
| `corepack pnpm test:e2e`                | End-to-end tests: HTTP requests against the real application on PostgreSQL in Docker, as the application role. Needs `stack:up`.                                                        |
| `corepack pnpm test:supply-chain`       | Plants a fake secret, a vulnerable package and an unlisted build script in a copy under `tmp/` and expects the supply-chain checks to catch each. Part of `check`.                      |
| `corepack pnpm build`                   | The **production build** into `dist/`. It does not contain the dev-tools module.                                                                                                        |
| `corepack pnpm start`                   | Runs the production build (`dist/main.js`) with the variables of `.env`.                                                                                                                |
| `corepack pnpm start:dev`               | Development: compiles into `dist-dev/` (with the dev-tools module), recompiles and restarts on every change.                                                                            |
| `corepack pnpm lint` / `format`         | ESLint; Prettier (writes).                                                                                                                                                              |
| `corepack pnpm typecheck`               | `tsc --noEmit` over sources and tests.                                                                                                                                                  |
| `corepack pnpm stack:up` / `stack:down` | Starts and stops PostgreSQL and Mailpit in Docker.                                                                                                                                      |
| `corepack pnpm stubs`                   | Starts the stub slot (stand-ins for outside services; empty in 0.1.0) on <http://127.0.0.1:4010>. Only on `STAGE=local`, `dev` or `test`. Stop with Ctrl+C.                             |
| `corepack pnpm seed:e2e`                | Writes the invented organisations and people of the end-to-end tests into the development database. It refuses to run unless `STAGE` is `local` or `test`.                              |
| `corepack pnpm db:provision`            | Creates the database roles and the database. Safe to repeat.                                                                                                                            |
| `corepack pnpm db:migrate`              | `prisma migrate deploy`: applies the committed migrations, as the owner role.                                                                                                           |
| `corepack pnpm db:status`               | Says which migrations are applied.                                                                                                                                                      |
| `corepack pnpm db:diff`                 | Prints the SQL that would take the development database to `prisma/schema.prisma`: the start of a new migration.                                                                        |
| `corepack pnpm openapi:generate`        | Writes `openapi/openapi.json` and `openapi/openapi.public.json` from the code.                                                                                                          |
| `corepack pnpm openapi:check`           | Fails when those files differ from the code, or a response property is named like a secret.                                                                                             |
| `corepack pnpm pdf:sample`              | Writes the bilingual sample PDF to `tmp/confera-pdf-sample.pdf`.                                                                                                                        |
| `corepack pnpm supply-chain`            | Pinned versions, frozen lockfile, `pnpm audit` (fails on high), secret scan, image digests.                                                                                             |

## 4. Configuration, STAGE and INSTANCE

The API reads its configuration from environment variables, and only through the module
`src/config`. A lint rule forbids `process.env` anywhere else.

- `.env.example` lists every variable with a comment. `pnpm start`, `pnpm start:dev`,
  the Prisma commands and the scripts load `.env` if it exists. The application itself
  never reads a file; on a server the variables come from the container.
- A missing or invalid variable **stops the start**. The message names each variable and
  never repeats a value, because a value can be a secret.
- **`STAGE` has no default.** Its values are exactly `local`, `dev`, `test` and `prod`.
- **`local`, `dev` and `test` run only on a developer machine:** both origins must be
  `localhost`, a loopback address or a name ending in `.test`. Every server runs `prod`,
  the staging server included.
- **On `prod`, `INSTANCE` is required:** `production` or `staging`, no default. It must
  not be set on another stage. On `prod` the origins must be `https`, the log level
  `info` or higher, and the credentials of the migration job must not be present.
- **A `DEV_*` variable is a development convenience** and is accepted only on `local`
  and `dev`. On `test` and `prod` each one stops the start. A `DEV_` variable that the
  schema does not know stops the start on every stage: if your machine has such a
  variable set for another program, the API will name it and refuse.

Exit codes of a refused start: **78** the configuration is not valid; **77** the
application refused (a database role that is too powerful, or no database); **1**
anything else.

No secret is ever committed. `.env` is ignored by git, and `pnpm supply-chain` scans the
files git would take. `deploy/api.env.example` is the template of a server's environment;
it holds no value for a secret and no `DEV_` key.

### Development conveniences

They exist only in the development build (`pnpm start:dev`). The production build does
not contain their code, and a test of the built application proves it.

| In `.env`              | Effect                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `DEV_API_DOCS=true`    | Interactive API documentation: <http://localhost:3001/dev/docs> (admin) and `/dev/docs/public` (public) |
| `DEV_LOG_QUERIES=true` | Every SQL statement in the log, with placeholders instead of values                                     |

`http://localhost:3001/dev/info` says which ones are on.

## 5. Two surfaces, two host names

Confera has an **admin** surface (`/api/v1/...`) and a **public** surface
(`/public/v1/...`), each under its own host name (ADR-02). The API enforces it itself: a
route asked under the other host name is answered `404 not_found`, exactly like a route
that does not exist. `/health` answers under any name.

On a developer machine the two host names are `localhost` (admin, `ADMIN_ORIGIN`) and
`127.0.0.1` (public, `PUBLIC_ORIGIN`): two names for the same computer. So
`http://localhost:3001/api/v1/meta` answers and `http://127.0.0.1:3001/api/v1/meta` does
not.

The API compares the **`Host` header** of the request, without the port. Whatever stands
in front of it (the proxy, or the web application when it forwards a call) must pass the
browser's `Host` header through unchanged. `X-Forwarded-Host` is ignored on purpose: a
client can send it.

There is no CORS: no response ever carries an `Access-Control-*` header, and every
`OPTIONS` request is answered 405.

## 6. Errors and logs

- **One error format**, `application/problem+json`: `code`, `traceId`, and for an error
  the API expected also `status`, `title` and, for refused input, `errors` with field
  path and rule code. **An unexpected error carries `code` and `traceId` only**; the
  full error is in the log under that trace id. The message of an exception never
  leaves the server.
- The **log** is JSON lines on stdout. Every entry is redacted by field name (password,
  token, secret, cookie, authorization, csrf, hash, key, body and more: the list is in
  `src/common/logging/redact.ts`), and credentials are cut out of connection addresses.
- The **request log** holds method, route pattern (`/public/v1/links/:token`), status and
  duration. Never the address that was asked, a query, a header or a body.
- Every response carries `X-Trace-Id`. An id sent by a client is never used.

## 7. Database

### Roles

`db:provision` creates three PostgreSQL roles (ADR-05). Their names are fixed, because
the migrations grant to them by name; their passwords come from the addresses in `.env`.

| Role             | Variable                 | May                                                                          |
| ---------------- | ------------------------ | ---------------------------------------------------------------------------- |
| `confera_owner`  | `MIGRATION_DATABASE_URL` | Owns the schema. Used by `db:migrate` only; never given to the running API.  |
| `confera_app`    | `DATABASE_URL`           | Read and write rows through row-level security. No schema right of any kind. |
| `confera_system` | `SYSTEM_DATABASE_URL`    | Bypass row-level security, with grants on the few columns a resolver reads.  |

`db:provision` connects as the superuser `postgres` of the development stack (password
`POSTGRES_PASSWORD`). For another server set `PROVISION_DATABASE_URL` to a superuser
address.

**At every start the API asks the database what its two roles may do** and refuses to
start when the application role is a superuser, may bypass row-level security, owns
anything or may create anything.

### Tenant isolation

Every tenant table has row-level security, enabled and forced. The organisation of a
statement is the setting `app.org_id`, which lives for one transaction.

In code there is one door to tenant data, `TenantDatabase`:

```ts
// inside a request or a job whose organisation is known
await this.database.db.user.findMany();                 // one statement
await this.database.transaction(async (tx) => { ... }); // several, atomically
```

Each call runs in a transaction that first sets `app.org_id` from `TenantContext`.
Without an organisation it throws before anything reaches the database, and the database
would return nothing anyway. `SystemResolvers` is the only user of the system role: a
resolver returns an organisation id and a record id, nothing else.

### Migrations

The schema changes only through committed migrations in `prisma/migrations`; `prisma db
push` is never used, in no environment and in no test. A merged migration is never edited.

To add one:

1. Change `prisma/schema.prisma`.
2. `corepack pnpm db:diff` prints the SQL of the change (your development database must
   be up to date: `corepack pnpm db:status`).
3. Create `prisma/migrations/<yyyymmddhhmmss>_<name>/migration.sql` with that SQL.
4. **For a new table, add by hand** what Prisma cannot express, as in the first
   migration: `ENABLE` and `FORCE ROW LEVEL SECURITY`, the policy `tenant_isolation`
   with `USING` and `WITH CHECK`, a unique key on `(organisation_id, id)`, composite
   foreign keys to other tenant tables, and the `GRANT`s to `confera_app`.
5. `corepack pnpm db:migrate`, then `corepack pnpm test:int`: the catalogue test finds a
   table that falls short of these rules.

## 8. Tests

| Tier         | Where                                                                 | Needs                | Runs in         |
| ------------ | --------------------------------------------------------------------- | -------------------- | --------------- |
| unit         | `src/**/*.spec.ts`, `test/architecture/`, `test/tooling/`, `test/qa/` | nothing              | `pnpm check`    |
| build        | `test/build/`                                                         | `dist/`, `dist-dev/` | `pnpm check`    |
| supply chain | `scripts/supply-chain-planted.mjs`                                    | the network          | `pnpm check`    |
| integration  | `test/integration/`                                                   | PostgreSQL in Docker | `pnpm test:int` |
| end to end   | `test/e2e/`                                                           | the stack in Docker  | `pnpm test:e2e` |

- **Unit:** configuration and the STAGE guard, redaction, the HTTP layer (errors, host
  separation, headers), the OpenAPI lint and drift check, the PDF golden test,
  architecture tests (lint rules on code samples, who imports the system client, who
  reads the environment, no credential compared with configuration, no `DEV_` key in a
  compose or deploy file), the test tools (`seed:e2e` refuses, the stub slot), and probes
  of single units (Serbian text and the glyph check in every field of a PDF).
- **Build:** the built application refuses every bad stage, instance and `DEV_` key;
  no dev-tools code in `dist/`, and no seed or stub in any build; the committed OpenAPI
  files equal the code.
- **Supply chain:** the checks of section 12 fail when they should, on planted cases.
- **Integration:** row-level security as the application role (raw SQL, Prisma, nested
  relations, a pool of one connection, 200 interleaved requests of two organisations),
  writes into another organisation, the catalogue check, what the roles cannot do, the
  start-up role check, and a clean production start with a canary in every secret.
- **End to end:** supertest against the real application (`createApp` of
  `src/bootstrap.ts`, nothing replaced) with the configuration of a server, connected as
  the application role: every route of the OpenAPI files, the error format, the headers,
  no CORS grant, odd `Host` headers, many requests at once, the request log; the harness
  itself (schema from `migrate deploy`, the role, the factories); `seed:e2e`; the stack
  (the three roles, the mail catcher).

Test people are invented and live on `example.test`. The end-to-end tests make them with
the factories of `test/e2e/support/factories.ts`, which refuse any other domain and
write each row inside its organisation, through row-level security.

To run one file: `corepack pnpm test -- src/config` (any path part works), or for the
integration tier `corepack pnpm test:int -- test/integration/catalogue`, or
`corepack pnpm test:e2e -- test/e2e/api`.

## 9. The stack for end-to-end tests of both repositories

This repository owns the development stack and the seed (ADR-24); the end-to-end tests of
`confera_fe` run against a backend started with these commands and nothing else. From a
fresh clone, after steps 1 and 2 of section 2:

```
corepack pnpm stack:up       PostgreSQL and the mail catcher (Mailpit), in Docker
corepack pnpm db:provision   the three database roles and the database
corepack pnpm db:migrate     the schema
corepack pnpm seed:e2e       the invented organisations and people
corepack pnpm build
corepack pnpm start          the API on http://localhost:3001      (its own terminal)
corepack pnpm stubs          the stub slot on http://127.0.0.1:4010  (its own terminal)
```

- **The mail catcher** shows every mail the stack sends at <http://localhost:8025>; it
  listens for SMTP on `127.0.0.1:1025`. Nothing leaves your machine.
- **The stub slot** is where the stand-ins for outside services run: the PayPal stub
  arrives with 0.7.0, the fixture rate provider with 0.5.0. In 0.1.0 it is empty:
  `GET http://127.0.0.1:4010/health` answers `{"status":"ok","stubs":[]}` and everything
  else 404. It listens on 127.0.0.1 only and refuses to start unless `STAGE` is `local`,
  `dev` or `test`. Another port: `STUBS_PORT` in `.env`.
- **`seed:e2e`** writes what `test/e2e/seed/e2e-seed.json` holds: two invented
  organisations with an admin and a reviewer each, on `example.test`, with fixed ids and
  no password (sign-in arrives with 0.2.0). It is safe to run again. **seed:e2e refuses to
  run unless `STAGE` is exactly `local` or `test`** (exit code 78), before it opens a
  connection; a `STAGE` of the environment wins over the one in `.env`, so on a server,
  where every process runs `STAGE=prod`, it cannot run.
- Neither the seed nor the stub slot is part of a build: they are scripts in `scripts/`,
  and a test of the built application proves that `dist/` and `dist-dev/` hold neither.

Stop everything with Ctrl+C in the two terminals and `corepack pnpm stack:down`.

## 10. OpenAPI

`openapi/openapi.json` (admin API) and `openapi/openapi.public.json` (public API) are
generated from the code and **committed**; the frontend vendors `openapi.json`. Their
`info.version` is the version of this repository.

After changing a controller or a DTO: `corepack pnpm openapi:generate`, look at the diff,
commit it. `corepack pnpm check` fails while the files are stale. Response types come from
the TypeScript types through the `@nestjs/swagger` compiler plugin, so a DTO needs no
`@ApiProperty` decorators; write a `/** comment */` and it becomes the description.

A controller declares its surface by its decorator: `@AdminController('users')` gives
`/api/v1/users`, `@PublicController('forms')` gives `/public/v1/forms`,
`@OpsController('health')` is outside both and not in the documents. Plain `@Controller`
stops the start.

## 11. PDF

`src/platform/pdf` makes PDF files with pdfmake and two embedded font families: Manrope
(the design system's typeface; it has š č ć ž đ, Serbian Cyrillic and Greek) and Noto
Sans as the fallback (the digraph letters ǆ ǉ ǌ, polytonic Greek and more).

- Every character is checked before rendering. A character that no font can print stops
  the render with a message that names it (`MissingGlyphError`).
- Invisible characters (zero-width space, direction overrides, controls) are refused too.
- Ligatures are off, so that text copied from the PDF equals the text that went in, in
  every reader.
- A document cannot read a file or call an address: only the font files are readable.

`corepack pnpm pdf:sample` writes the bilingual sample to look at.

## 12. Dependencies and the supply chain

The rules of ADR-01 are settings in `pnpm-workspace.yaml`; `pnpm supply-chain` checks
that they stay.

- **Exact versions only**, in `package.json` and for pnpm itself.
- **Frozen lockfile:** `pnpm install` fails instead of changing `pnpm-lock.yaml`.
- **Minimum release age:** a version must be public for 3 days before it can be installed.
- **Build scripts by name:** a dependency may run an install script only if
  `allowBuilds` names it. An unlisted build script stops the install.
- **Strict engines:** a dependency that does not support the Node version in use stops
  the install.
- **Vulnerability gate:** `pnpm audit` fails `check` on severity high or critical.
- **Secret scan**, in two parts with one verdict:
  - secretlint finds credentials by their **format**: tokens of known services, private
    keys, an address with a user and a password.
  - `scripts/secret-assignments.mjs` finds a secret that has no format by the **name** it
    is assigned to: a literal value of 8 characters or more assigned to a name with
    `PASSWORD`, `SECRET`, `TOKEN`, `CREDENTIAL` or `KEY` in it. In an environment or
    configuration file that is `NAME=value` or `NAME: value`; in source code and JSON a
    quoted value (`clientSecret: '...'`).

  An invented credential must start with `invented-` or `local-only-` (and an address
  must point at 127.0.0.1); an empty value and a reference such as `${VAR}` are fine too.
  Anything else fails, `changeme` included. In a test, build such a text from parts
  instead of writing it in one piece. A name that ends in `FILE`, `PATH`, `URL`, `NAME`
  or `HEADER` says where a secret is, not what it is, and is not reported.

- **Container images by digest.**

`corepack pnpm test:supply-chain` (part of `check`) proves that these rules bite: in a
copy of the repository under `tmp/` it plants fake secrets, a package version with a
known vulnerability, a dependency with an unlisted build script, a `package.json` that
disagrees with the lockfile and weakened settings, and expects each to be caught. It
plants nothing in your working tree and removes its copy.

To add or update a dependency on purpose:

```
corepack pnpm add <name>@<exact version>
```

If pnpm reports an ignored build script, decide `true` or `false` for it under
`allowBuilds` in `pnpm-workspace.yaml`, with a comment that says why. If it reports that
the version is too young, wait or take the one before.

## 13. Layout

```
prisma/              schema and committed migrations
openapi/             the generated, committed OpenAPI files
deploy/              environment template of a server
src/config/          the configuration schema and the STAGE guard; the only reader of the environment
src/common/          HTTP layer (errors, surfaces, headers), logging
src/platform/prisma  tenant client, resolvers, start-up role check
src/platform/tenancy the organisation of the current request
src/platform/pdf     PDF renderer, fonts, glyph check
src/modules/         one folder per feature; dev-tools is left out of the production build
test/architecture    rules that hold for the whole code base
test/tooling         tests of the test tools (seed:e2e, the stub slot)
test/qa              probes of single units by the test engineer (PDF fields)
test/build           tests that start the built application
test/integration     tests against PostgreSQL in Docker
test/e2e             end-to-end tests of the API; factories and the seed of invented people
test/support         helpers of the tests
scripts/             build, check, provisioning, supply-chain, seed and stub scripts (plain Node)
eslint/              the lint rules with a security purpose
```

## 14. Things a newcomer trips over

- **`pnpm` is not recognised.** Use `corepack pnpm ...` (section 1).
- **Scripts in `package.json` never call `pnpm` by name**, because it is often not on
  PATH. A script that needs pnpm goes through `scripts/lib/process.mjs`.
- **There is no Nest CLI here.** `@nestjs/cli` 12 needs Node 22.22 or later and does not
  start on Node 22.14. `scripts/build.mjs` compiles with the TypeScript compiler and the
  `@nestjs/swagger` plugin, which is all `nest build` did for this repository.
- **NestJS 12 is published as ES modules; this application is CommonJS.** Node 22 loads
  them with `require()`. Jest cannot do that before Node 24.9, so
  `test/support/esm-dependency-transformer.cjs` converts the `@nestjs/*` packages for
  the test run. If a test fails with "Must use import to load ES Module", add the package
  to `esmOnlyPackages` in `jest.config.cjs`.
- **Jest prints `ExperimentalWarning: VM Modules`.** Expected: the Prisma client loads its
  query compiler with a dynamic import, which Jest allows only with that Node flag. The
  test scripts set it.
- **"The database cannot be reached with DATABASE_URL"** (exit code 77). The stack is not
  up, or steps 4 and 5 of section 2 were skipped.
- **`http://127.0.0.1:3001/api/v1/meta` answers 404.** Use `localhost` (section 5).
- **`pnpm install` fails with "frozen lockfile".** You changed `package.json`; see section 12.
- **A script stops with "dependencies are out of date".** Run `corepack pnpm install`.
  Scripts never install behind your back.
- **`check` fails on the secret scan after you wrote a test.** A connection address with
  a password, or a quoted value assigned to a name like `password` or `token`, stands in
  a file as one piece of text; see section 12.
- **Port 3001 is in use.** An earlier `pnpm start` or `start:dev` is still running.
- **`seed:e2e did not run`** (exit code 78). `STAGE` is not `local` or `test`: look at
  `.env` and at the environment of your terminal, which wins over `.env`.
- **`pnpm test:e2e` or `test:int` fails with "cannot connect to PostgreSQL as a
  superuser".** The stack is not up: `corepack pnpm stack:up`.
- **Never write `\uXXXX`-style invisible characters into a file as real characters.**
  Use the escape in the source, so that a reviewer can see them.
