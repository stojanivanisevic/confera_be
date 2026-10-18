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
(section 9). They must be free. A second checkout on the same machine gets ports of its
own for PostgreSQL and Mailpit (section 2, "One stack per checkout").

## 2. First start

Clone `confera_be` and `confera_fe` **side by side in one folder** (for example
`D:\Code\confera_be` and `D:\Code\confera_fe`): the cross-repo smoke test (section 9) and
the frontend's checks of the API contract and of the shared secret scanner look for the
other repository in `../`.

The branch `main` holds the latest release and `develop` the work in progress; to work on
the code, clone `develop`. Name the branch with `-b` (`-b main` for the release), so that
the clone does not depend on the default branch of the GitHub repository.

```
git clone -b develop https://github.com/stojanivanisevic/confera_be.git
cd confera_be
```

**Step 1. Create your local environment file.** Its values work as they are; none is a
secret.

- Windows (PowerShell or cmd): `copy .env.example .env`
- macOS, Linux, Git Bash: `cp .env.example .env`

**Only if** another checkout of `confera_be` on this machine (another clone, a git worktree,
a copy under `_tmp`) has its stack up, or will have it up while this one runs, give this
one ports of its own: `corepack pnpm stack:ports`, after step 2 and before step 4. On the
only checkout of the machine skip it: the ports of `.env.example` are right. `stack:up`
refuses a port that another stack holds, and says so. See "One stack per checkout" below.

**Step 2. Install the dependencies.** The install never changes the lockfile, and it
generates the Prisma client at the end.

```
corepack pnpm install
```

**Step 3. Run all checks.** They need no database and no Docker, only the network (for
the vulnerability audit). About seven minutes on a fresh clone, up to twelve on a busy
machine (the planted cases of the supply chain take two of them).

```
corepack pnpm check
```

It ends with `check passed`.

**Step 4. Start the development stack** (PostgreSQL and Mailpit in Docker). The first
time it downloads two images.

```
corepack pnpm stack:up
```

It ends with `The stack of this checkout is up.` and its name, folder and ports.

**Step 5. Create the database roles and the database, then the schema.**

```
corepack pnpm db:provision
corepack pnpm db:migrate
```

`db:provision` ends with these lines:

```
Database "confera" is provisioned.
  owner        confera_owner  (migrations only)
  application  confera_app  (no schema rights, bound by row-level security)
  system       confera_system  (resolvers only, may bypass row-level security)
Next: corepack pnpm db:migrate
```

`db:migrate` ends with
`All migrations have been successfully applied.` the first time, and with
`No pending migrations to apply.` when the schema is already up to date: both mean
success. Both commands are safe to run again, and two
`db:provision` at the same moment wait for each other (an advisory lock on the server).
A database that an interrupted `DROP DATABASE` left invalid is dropped and created
again, and a run whose connection breaks (PostgreSQL restarted) starts again by itself,
up to three times. A failure says in one sentence what happened.

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
| <http://localhost:3001/api/v1/meta>  | `{"name":"confera-api","version":"…"}`        |
| <http://127.0.0.1:3001/api/v1/meta>  | **404** `not_found`. That is right: section 5 |

`version` is the version of this checkout, the `version` of `package.json`.

Stop the API with Ctrl+C.

**Step 7. Run the tests that need the database.** They build the application, create a
database of their own (`confera_integration_test`) with the same two commands as step 5,
and leave your development database alone. `test:int` takes about 4 minutes on a quiet
machine and about 12 minutes on a loaded one (0.3.0).

```
corepack pnpm test:int
```

It ends with `Tests: ... passed` and no failure.

**Step 8. Run the end-to-end tests.** They start the real application on a database of
their own (`confera_e2e_test`), created with the same two commands as step 5, and send
HTTP requests to it. They also talk to the mail catcher. About 8 minutes on a quiet
machine and about 22 minutes on a loaded one (0.3.0).

```
corepack pnpm test:e2e
```

It ends with `Tests: ... passed` and no failure.

**Step 9. Stop the stack when you are done.**

```
corepack pnpm stack:down
```

The data stays in the Docker volume of this checkout's stack. To start from an empty
database again: `corepack pnpm stack:wipe` (it stops the stack and removes that volume,
and no other), then steps 4 and 5.

### One stack per checkout

Every checkout of `confera_be` (a clone, a git worktree, a copy under `_tmp`) has a
development stack of its own: its own Docker Compose project, containers, database
volume and ports. Two checkouts can run their test suites at the same time, and neither
can stop, empty or drop the database of the other.

- **The name** of the project is derived from the folder of the checkout:
  `confera-<folder>-<8 hex digits of its path>`, for example `confera-be-m2-c62fdd52`.
  Set `CONFERA_STACK_NAME` in `.env` to choose another. `corepack pnpm stack:info` shows
  name, folder and ports. The containers are `<name>-postgres-1` and `<name>-mailpit-1`,
  the volume `<name>_pgdata`.
- **The ports** are what `.env` says: PostgreSQL listens on the port of the three database
  addresses (`DATABASE_URL`, `SYSTEM_DATABASE_URL`, `MIGRATION_DATABASE_URL`, which must
  name the same port), the mail catcher on `CONFERA_MAIL_WEB_PORT` and
  `CONFERA_MAIL_SMTP_PORT`. A fresh `.env` has 5432, 8025 and 1025. **On a second checkout
  run `corepack pnpm stack:ports`**: it writes a free set derived from the folder (25000 +
  n, 26000 + n, 27000 + n) into those lines of `.env` and changes nothing else. The API
  port (3001) stays; only one checkout runs `pnpm start` at a time.
- **The refusals.** `stack:up` refuses a port that the stack of another checkout publishes,
  or that another program listens on, before Docker starts anything. `db:provision`,
  `db:migrate`, `db:status`, `db:diff`, `seed:e2e`, `start`, `start:dev`, `test:int` and
  `test:e2e` first ask Docker which container publishes the port of their database
  address, and refuse when it belongs to the stack of another checkout, or to a container
  that is no Confera stack at all: `... did not run: the database of DATABASE_URL at
127.0.0.1:5432 belongs to the stack "confera-be-1a2b3c4d" of another checkout,
D:\Code\confera_be, not to this checkout, ...`. Nothing is connected to, provisioned or
  dropped. An address that is not on this machine is not the development stack and is
  not judged.
- Start and stop the stack only with `corepack pnpm stack:up` and `stack:down`.
  `docker-compose.yml` refuses to start without the name and ports the script gives it.
- Checkouts of 0.1.0 shared the project `confera`, the containers `confera-postgres` and
  `confera-mailpit` and the volume `confera_pgdata`. When no checkout of 0.1.0 needs them
  any more: `docker rm -f confera-postgres confera-mailpit` and
  `docker volume rm confera_pgdata`.

## 3. Commands

| Command                                                       | What it does                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `corepack pnpm check`                                         | Formatting, lint, typecheck, unit tests, both builds, OpenAPI check, tests of the built application, PDF timing, supply-chain checks and their planted cases. Green before a change is handed over.                                                                  |
| `corepack pnpm test`                                          | Unit and architecture tests. No build, no Docker.                                                                                                                                                                                                                    |
| `corepack pnpm test:build`                                    | Tests that start the built application. Needs `build` and `build:dev` first; `check` runs them in the right order.                                                                                                                                                   |
| `corepack pnpm test:timing`                                   | Makes PDFs in fresh Node processes and expects each kind in under 5 seconds. Builds by itself; run it alone.                                                                                                                                                         |
| `corepack pnpm test:int`                                      | Integration tests against PostgreSQL in Docker. Needs `stack:up`; builds by itself.                                                                                                                                                                                  |
| `corepack pnpm test:e2e`                                      | End-to-end tests: HTTP requests against the real application on PostgreSQL in Docker, as the application role. Needs `stack:up`.                                                                                                                                     |
| `corepack pnpm test:supply-chain`                             | Plants a fake secret, a vulnerable package and an unlisted build script in a copy under `tmp/` and expects the supply-chain checks to catch each. Part of `check`.                                                                                                   |
| `corepack pnpm build`                                         | The **production build** into `dist/`. It does not contain the dev-tools module.                                                                                                                                                                                     |
| `corepack pnpm start`                                         | Runs the production build (`dist/main.js`) with the variables of `.env`.                                                                                                                                                                                             |
| `corepack pnpm start:dev`                                     | Development: compiles into `dist-dev/` (with the dev-tools module), recompiles and restarts on every change.                                                                                                                                                         |
| `corepack pnpm lint` / `format`                               | ESLint; Prettier (writes).                                                                                                                                                                                                                                           |
| `corepack pnpm typecheck`                                     | `tsc --noEmit` over sources and tests.                                                                                                                                                                                                                               |
| `corepack pnpm stack:up` / `stack:down`                       | Starts and stops PostgreSQL and Mailpit in Docker: the stack of this checkout (section 2, "One stack per checkout").                                                                                                                                                 |
| `corepack pnpm stack:wipe`                                    | Stops the stack of this checkout and removes its database volume.                                                                                                                                                                                                    |
| `corepack pnpm stack:ports`                                   | Writes a free set of ports, derived from the folder of the checkout, into `.env`. For a second checkout on the same machine.                                                                                                                                         |
| `corepack pnpm stack:info`                                    | Says the name, the folder and the ports of the stack of this checkout.                                                                                                                                                                                               |
| `corepack pnpm stubs`                                         | Starts the stub slot (stand-ins for outside services; empty until 0.5.0) on <http://127.0.0.1:4010>. Only on `STAGE=local`, `dev` or `test`. Stop with Ctrl+C.                                                                                                       |
| `corepack pnpm seed:e2e`                                      | Writes the invented organisations and people of the end-to-end tests into the development database, each person with the invented password of `test/e2e/seed/e2e-seed.json`, and the default email templates. It refuses to run unless `STAGE` is `local` or `test`. |
| `corepack pnpm seed:production`                               | Writes the organisation "UdEkoM Balkans", its default email templates and the five conferences as drafts. No user, no password, no price. Safe to repeat; never changes what an admin edited.                                                                        |
| `corepack pnpm first-admin --email <address> --name "<name>"` | Invites the first admin: an invited person with the admin role and an invitation link valid for 72 hours, **printed once to the terminal** and kept nowhere else. Refused once the organisation has an active admin.                                                 |
| `corepack pnpm db:provision`                                  | Creates the database roles and the database. Safe to repeat.                                                                                                                                                                                                         |
| `corepack pnpm db:migrate`                                    | `prisma migrate deploy`: applies the committed migrations, as the owner role.                                                                                                                                                                                        |
| `corepack pnpm db:status`                                     | Says which migrations are applied.                                                                                                                                                                                                                                   |
| `corepack pnpm db:diff`                                       | Prints the SQL that would take the development database to `prisma/schema.prisma`: the start of a new migration.                                                                                                                                                     |
| `corepack pnpm openapi:generate`                              | Writes `openapi/openapi.json` and `openapi/openapi.public.json` from the code.                                                                                                                                                                                       |
| `corepack pnpm openapi:check`                                 | Fails when those files differ from the code, or a response property is named like a secret.                                                                                                                                                                          |
| `corepack pnpm pdf:sample`                                    | Writes the bilingual sample PDF to `tmp/confera-pdf-sample.pdf`.                                                                                                                                                                                                     |
| `corepack pnpm supply-chain`                                  | Pinned versions, frozen lockfile, `pnpm audit` (fails on high), secret scan, image digests.                                                                                                                                                                          |

## 4. Configuration, STAGE and INSTANCE

The API reads its configuration from environment variables, and only through the module
`src/config`. A lint rule forbids `process.env` anywhere else.

- `.env.example` lists every variable with a comment. `pnpm start`, `pnpm start:dev`,
  the Prisma commands and the scripts load `.env` if it exists. The application itself
  never reads a file; on a server the variables come from the container.
- A missing or invalid variable **stops the start**. The message names each variable and
  never repeats a value, because a value can be a secret. The entry checks the
  configuration first (`src/startup.ts`) and loads the framework and the application
  only after it has passed, so a refused start runs no application code.
- **`STAGE` has no default.** Its values are exactly `local`, `dev`, `test` and `prod`.
- **`local`, `dev` and `test` run only on a developer machine:** both origins must be
  `localhost`, a loopback address or a name ending in `.test`, and `LISTEN_HOST` must be
  a loopback address (`127.0.0.1`, `::1` or `localhost`): a dev stage that listened on
  `0.0.0.0` would answer anyone who sends `Host: localhost`. Every server runs `prod`,
  the staging server included.
- **On `prod`, `INSTANCE` is required:** `production` or `staging`, no default. It must
  not be set on another stage. On `prod` the origins must be `https`, the log level
  `info` or higher, and the credentials of the migration job must not be present.
- **A `DEV_*` variable is a development convenience** and is accepted only on `local`
  and `dev`. On `test` and `prod` each one stops the start. A `DEV_` variable that the
  schema does not know stops the start on every stage: if your machine has such a
  variable set for another program, the API will name it and refuse.

Exit codes of a refused start: **78** the configuration is not valid; **77** the
application refused (a database role that is too powerful, no database, or a database
that did not answer within 20 s); **1** anything else.

No secret is ever committed. `.env` is ignored by git, and `pnpm supply-chain` scans the
files git would take. `deploy/api.env.example` is the template of a server's environment;
it holds no secret at all (on a server each secret is a file of its own, section 15) and no
`DEV_` key.

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

### Access: sign-in, sessions and who may call what

Every route declares who may call it, or the application does not start (ADR-05, guards
deny by default): `@Permission('users.manage')` for a signed-in user whose role holds the
permission, `@Public()` for sign-in, a password reset, a secure link, a browser's report.
The permissions are the code constants of `src/modules/access/permissions.ts`; which role
holds which is seeded by migration (`role_permissions`), and an integration test keeps
the two equal. The OpenAPI document carries the declaration of every operation
(`x-confera-access`, `x-confera-fresh-password`); the authorisation matrix of
`test/e2e/authorisation-matrix.spec.ts` is generated from it for five actors.

- **Sign-in** (`POST /api/v1/session`, ADR-03): the session is a random token in the
  cookie `__Host-confera_session` (HttpOnly, Secure, SameSite=Lax, Path=/, no Domain);
  the table holds its SHA-256. A new token at every sign-in. The answer holds the user,
  the organisation, the permissions and the **CSRF value** of the session, which every
  changing request sends in `X-CSRF-Token`; it is bound to the session and never in a
  cookie. A changing request must also carry an `Origin` equal to the origin of its
  surface, exactly; the public host's origin is refused on the admin surface.
- **Lifetime:** a session ends 24 hours after its last use, and at the latest 7 days
  after sign-in (G2-24). Use renews it; a request with the header `X-Confera-Background`
  (a refetch the person did not ask for) does not. Sign-out, "sign out everywhere", an
  own password change (the other sessions), a reset or an email change (all), a change of
  role, a deactivation, a removal and an admin's "end this user's sessions" end sessions
  on the server, each with its reason in the row. The model is ready for the second
  factor of 0.9.0 (`sessions.second_factor`).
- **The password asked again:** a change of users, roles or the payment details (routes
  marked `@FreshPassword()`) needs `POST /api/v1/session/password-confirmation` within
  the last 5 minutes, in that session; otherwise 403 `password_confirmation_required`.
  Every such change, and a sign-in from a new browser, puts a notice to every active
  admin into the mail outbox.
- **The brake** (`src/modules/access/brake.service.ts`, SEC-A-14): failed sign-ins slow
  an account and an address down, never lock them: 5 free failures per account and 20 per
  address in an hour, then a wait of 30 s that doubles up to 15 minutes. A browser that
  signed in before (the cookie `__Host-confera_device`, bound to the account) is exempt
  from the account's brake only. The owner is told by mail at most once a day. Sign-in and
  a reset request answer every failure alike, and not sooner than 300 ms.
- **The client address** is what the one proxy in front of the API writes into
  `X-Forwarded-For` (`trust proxy` is 1): the brake, the limits and the security events
  use it. Failed sign-ins are security events of the instance (kept 90 days); those for
  unknown addresses appear in the audit log of every organisation as one summed entry
  (`SecuritySummary.run()`).
- **Secure links** (ADR-04): invitation (72 hours), password reset and email change (30
  minutes). The token is in the path; only its SHA-256 is stored; opening a link (GET)
  shows and uses nothing up; the action is a POST that uses it up atomically; each path
  accepts one purpose; a newer link ends the older one of the same purpose and person.
  Every failure answers 404 `link_invalid`. The outbox row of a message says which link it
  needs; the sender of 0.2.0 part B makes the link when it sends, so no link is ever stored.
- **The password rule set** (G2-25, FR-USR-06): at least 12 characters (code points, at
  most 128); not a common or leaked password; not the person's own name or email name nor
  the organisation's; both entries match. The server refuses with 400 `password_refused`
  and each broken rule named (`password_length`, `password_common`, `password_personal`,
  `password_mismatch`). The rule set with its 37 vectors is `contracts/password-rules.json`,
  written by `pnpm openapi:generate` and held current by `pnpm openapi:check`; the web
  application vendors it and its live checklist must give the same four results for every
  vector. The rules are in `src/modules/access/password-rules.ts`, the list of common
  passwords beside it.
- **The audit log** (ADR-06, FR-AUD-01 to 03) is insert-only for both run-time roles. An
  entry holds who, when, what, which fields changed and a trace id; old and new values
  only for the fields of `src/modules/audit/audit-fields.ts` (the issuer data and bank
  accounts of the organisation), and the recorder refuses the values of any other.
- **CSP reports** (M1-ISS-11): `POST /public/v1/csp-reports` takes the reports of the web
  application's content security policy, from any origin, with a body limit of 16 KB and
  60 reports per address and hour; the log line holds the directive and the addresses
  without query, fragment or link token, never the client address.

### Mail: servers, templates, the outbox and the log

- **Mail servers** (ADR-11) belong to the organisation; one may be the default and one the
  fallback. The password is write-only: sealed with AES-256-GCM under a key derived from
  `DATA_KEY`, bound to its row, never returned (`credentialSet` says whether one is
  stored). Changing host, port, user or TLS mode without a new password **clears it**.
  Every change asks for the password again and is told to all admins.
- **TLS is required**: `implicit` (port 465) or `starttls`, TLS 1.2 at least, the
  certificate verified. `none` exists for Mailpit and is refused unless `STAGE` is
  `local`, `dev` or `test`. On `prod` a target may not be a loopback, private or
  container-network address (checked again on every address the name resolves to), and
  only the ports 25, 465, 587 and 2525 are allowed. The test message answers `sent`,
  `failed` or `refused` with the rule, never the server's words.
- **Templates** (ADR-12) are documents of a closed format, not HTML:
  `src/modules/templates/document.ts` checks them, `render.ts` makes HTML and plain text
  and escapes every value. The catalogue says which placeholders each type may use; a
  secure link is the address of a link node, never text. `contracts/template-vectors.json`
  holds the format and the vectors the editor of the web application must agree with.
  The defaults, English and Serbian, are `prisma/seed/default-templates.json`.
- **The outbox** (ADR-13): a message is queued in the transaction of the change. The
  worker (every `MAIL_WORKER_INTERVAL_SECONDS`, default 5; 0 is off) claims each due row
  inside its organisation, chooses the template (conference and language, conference in
  English, organisation and language, organisation in English) and the servers (the
  template's, else the conference's, else the default; then the fallback), **makes the
  secure link now**, sends to one recipient, and logs every attempt. The log shows each
  link as `[link]`; the organisation can switch the content off (`mailLogContent`). A
  server never sends faster than its `sendRatePerMinute`. Five attempts with backoff,
  then `failed`; a row left in `sending` by a crash becomes `stuck` and is not sent again
  by itself. With no server or no template a message waits and the application stays
  healthy.

### Forms, embed and intake (0.3.0)

- **Forms** (ADR-09, M3-BE-01): one form of a type per conference (`abstract` in 0.3.0),
  `POST /api/v1/conferences/{id}/forms`. Its fields come from the catalogue in code
  (`src/modules/forms/catalogue.ts`): the current form of the conference sites, field by
  field. The admin's **configuration** is the draft (`PUT /api/v1/forms/{id}/draft`): fields
  on and off, labels, help and options in both languages, required, limits, file types and
  sizes, the texts, the most authors (D7: 10 by default); a mandatory field cannot be switched
  off, nothing beyond a cap is taken. `POST /api/v1/forms/{id}/publish` makes an immutable
  **version** of the definition built from it (the application role may only read and add
  versions); a submission keeps its version. Form texts are plain text with one link syntax,
  `[label](https://...)`, and `[label](terms)` / `[label](privacy)` for the consent links of
  the conference (D6: `publicationTermsUrl`, `privacyNoticeUrl`).
- **Contracts for the web application** (`contracts/`, written by `openapi:generate`):
  `form-definition.schema.json` (a version's definition), `form-configuration.schema.json`
  (the draft), `form-rule-vectors.json` (the rule interpreter of both sides: codes, order,
  word count, the URL rule, the address rule, the safe text, the proof-of-work, and answers
  with their errors). Errors are `answers.<path>` and a code: `answers.authors[2].email`.
- **The public API** (ADR-08, M3-BE-03), under the public host name only:

  | Route                                      |                                                                                                                                        |
  | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
  | `GET /public/v1/forms/{slug}`              | the published definition, `state` (`open`/`closed`), the deadline, the consent links                                                   |
  | `GET /public/v1/forms/{slug}/frame-sites`  | the conference's listed sites for `frame-ancestors` of the frame page, each checked again; none unless the conference is open (ADR-07) |
  | `POST /public/v1/forms/{slug}/tokens`      | a single-use form token (JSON body `{}`), valid 6 hours; under load with a proof-of-work                                               |
  | `POST /public/v1/forms/{slug}/uploads`     | one file: multipart, parts `field` then `file`; header `X-Form-Token`                                                                  |
  | `POST /public/v1/forms/{slug}/submissions` | JSON `{ language, answers, confera_hp, proofOfWork? }`; headers `X-Form-Token` and `Idempotency-Key` (a UUID per form instance)        |

  Every POST needs `Origin` equal to `PUBLIC_ORIGIN`, `Sec-Fetch-Site: same-origin` where the
  browser sends it, and exactly its content type (415 otherwise); `/public` never reads the
  session cookie and no response carries a CORS grant. The token is random, only its SHA-256
  is stored, it works for one submit (409 `form_token_used`), and its uploads are bound to it
  (as many as the version has file fields, plus two). A repeat with the same idempotency key
  returns the first result (409 `idempotency_key_reused` with other answers). `confera_hp` is
  the trap field, a name no autofill fills (SEC-M3-07; its 0.3.0 name `website` is still read
  until the page sends the new one): filled, or a submit within 3 s of the token, is answered
  with a fake success and stores nothing. **A refused token is renewed**: after 403 `form_token_invalid`
  (expired), 409 `form_token_used` or 403 `proof_of_work_failed`, the page asks for a new token
  with `{ "previousFormToken": "<the refused one>" }`. A renewal of a token of the same form
  that is no longer live (expired, or refused by the proof-of-work) and was never used, in a
  chain that began within 24 hours, takes over its files and its count of uploads and uses it
  up (SEC-M3-02: a live token is never renewed, and a chain ends 24 hours after its first
  token; SEC-M3-04: a token used by a submission, a fake success or a renewal renews
  nothing); otherwise the new token starts a chain of its own. The minimum fill
  time counts from the first token of the chain, so a submit at once after a renewal is
  stored when the chain began 3 s ago or more. Limits per client (an IPv4 address, or the
  /64 of an IPv6 address): 30 tokens in 10 minutes, 10 submits an hour, 40 uploads in 10
  minutes, 1 GB of kept uploads in 30 hours (429). The **proof-of-work** (13
  zero bits) is asked for above 20 submissions in 10 minutes on a form, or from a client that
  did three things a script does in 10 minutes (the trap, a submit faster than a person, a
  failed proof, a token not valid); volume alone from one address does not. It is decided
  when a token is issued and again at the submit: the token then carries
  `{ challenge, difficulty }` and the submit `proofOfWork`, a counter such that
  SHA-256(`challenge:counter`) begins with `difficulty` zero bits (403 `proof_of_work_failed`;
  a token without a challenge is renewed first).

- **One submit, one transaction**: the submission (reference `IT27-0001`, unique in the
  organisation; the answers under their keys; typed columns for the table), its authors in
  order, its first status, its files attached, the consent as shown (text, links, a hash, the
  time), and the **confirmation** in the outbox: fixed text, the reference and the title only,
  in the submission's language (SA-13; template type `submission_confirmation`). A title that
  holds an address or a bare domain (`evil.com`, which mail programs make a link of; also
  `ASP.NET`) is left out of the mail, which then names the reference only (SEC-M3-03). If
  sending fails the submission is stored and the mail log shows the failure.
- **The send breaker** (M3-BE-09): per form (`PATCH /api/v1/forms/{id}/breaker`) and per
  organisation (`PATCH /api/v1/held-mail/breaker`), 30 an hour and 200 a day by default, and
  100 a day to one recipient domain. Above it the submission is stored and its confirmation
  is `held` (`heldReason`, and `heldBy`: the `count`, `limit` and `windowHours` that held it);
  every active admin gets one notice an hour per form;
  `GET /api/v1/held-mail` lists them, `POST /api/v1/held-mail/release` (`{ ids }` or
  `{ all: true, formId? }`) queues them again. A held email can be released, not discarded
  (M3-ISS-14, 0.4.0).
- **Deadlines** (FR-DL-01 to 03, M3-BE-05): `PUT /api/v1/conferences/{id}/deadlines/{kind}`
  (`abstract_submission`, `fee_payment`, `full_paper`), a day that ends at the end of that day
  in the conference's time zone (`src/modules/deadlines/deadline-time.ts`, also on the days
  the clocks change). A form is open while its conference is open for submissions ("Open for
  submissions", D10) and its deadline has not passed; an extension opens it again at once; the
  history keeps the old and the new day and who changed it.
- **Files** (ADR-10, M3-BE-04): streamed into `FILE_STORAGE_DIR` under `org/<organisation>/<uuid>`
  (never a client's name; a key that would leave the folder is refused), cut off one byte
  beyond the field's limit (413 `file_too_large`; 20 MB by default, at most 50), the SHA-256
  computed on the way, the type read from the content (PDF, `.docx`, `.doc`, JPEG, PNG; 415
  `file_type_refused`). A `.docx` with a VBA project is refused (422 `docx_macros`); an old
  `.doc` with macros is kept and flagged `macros` (G2-22). The name is kept for display and
  download, cleaned (no control or direction character, no quote, path part or reserved device
  name, at most 150 characters, the extension of the content). A refused or broken upload
  uses none of the token's uploads up, and leaves no temporary file. Above 2 GB of
  unattached bytes in an organisation, uploads on their way included, uploads are refused (503
  `upload_quota_reached`) and the admins told; the files of an expired token are purged once
  its chain of renewals has ended, 24 hours after the chain began (until then a renewal takes
  them back), any unattached file 30 hours after its upload (the row first, checked again,
  then the bytes: SEC-M3-05), the token a day after its issue,
  and a temporary file untouched for an hour. A `.docx` counts as holding macros by the name, the content type
  or the relationship of its VBA project. Its inspection is bounded (SEC-M3-01): at most 64
  parts, 2 MB inflated in all and 1 s per file; a ZIP whose entries repeat a name or overlap
  is refused (415), one that needs more counts as holding macros (422), and either upload
  counts as an act of a script. The parts are read as Word reads them (SEC-M3-06): UTF-8 or
  UTF-16, character references decoded; a part that is neither counts as macros. The names
  of an old `.doc` are compared in any casing. A `.docx` whose relationships reach outside it
  (a remote template, frame or object, a UNC or `file:` target; a plain hyperlink does not
  count) is kept and flagged `external_links`, like a `.doc` with macros. No regular
  expression runs over a part (SEC-M3-11): parts are read by a linear scan, at most 10 000
  elements of at most 16 KB each, the time budget looked at between elements. A file is served only by
  `GET /api/v1/submissions/{id}/files/{fileId}`, as an attachment with `filename*`, and only
  when its scan is clean (409 `scan_pending` or `file_not_clean`).
- **Antivirus** (M3-BE-08): the files worker (every `JOBS_INTERVAL_SECONDS`) sends every
  attached file to ClamAV's daemon at `CLAMAV_ADDRESS` (INSTREAM). Fail closed: no answer, an
  error or a timeout (120 s) leaves the file pending with its attempts counted and tries again
  after 1, 2, 4 ... minutes, and the admins are told once an hour; limits exceeded count as not
  clean. **The development stack has no ClamAV** (about 1.2 GB of memory and a signature
  download): without `CLAMAV_ADDRESS` every file stays "scan pending" and is never served.
  The tests use a fake daemon that speaks the same protocol (`test/support/fake-clamd.ts`).
- **Submissions** (M3-BE-07): `GET /api/v1/submissions` (paged, newest first, at most 100 a
  page; `fileSigns`: the flags of its files and whether a scan is pending) and
  `GET /api/v1/submissions/{id}` (answers, authors, files with their scan state and, while one
  cannot be downloaded, `downloadBlocked` and `nextScanAt`; consent, status history, emails).
- **A copy of a conference** (FR-CONF-03) takes its forms as unpublished drafts with their
  configuration.

### The first admin and the production seed

On a fresh installation, after `db:migrate`: `corepack pnpm seed:production`, then
`corepack pnpm first-admin --email <address> --name "<name>"` with `ADMIN_ORIGIN` set.
The command prints the invitation link once; copy it to the person by hand. Nobody but
that person ever knows their password. Then the admin adds a mail server in the
application. `seed:e2e` and its invented passwords never run on a server.

On a developer machine, `first-admin` refuses ("has an active admin already") when the
database was used before, for example by the real-API browser run of `confera_fe`, which
seeds and signs in its own people. Start from an empty database first:
`corepack pnpm stack:wipe`, `corepack pnpm stack:up`, `db:provision`, `db:migrate`, then
`seed:production` and `first-admin`.

### The inventory of secrets (ADR-11)

The form tokens of 0.3.0 need no key: they are random and only their SHA-256 is stored, like
sessions and secure links.

| Secret                             | Where it lives                         | Who holds it                     | Backup                             | Rotation                                                           |
| ---------------------------------- | -------------------------------------- | -------------------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| `DATA_KEY`                         | the API's environment on the server    | the operator; two people offline | a sealed copy off the server       | a new key with a new key id; stored secrets sealed again (runbook) |
| `confera_owner` password           | the migration job's environment only   | the operator                     | the association's password manager | `ALTER ROLE` and the job's environment                             |
| `confera_app` password             | `DATABASE_URL` of the API              | the operator                     | the association's password manager | `ALTER ROLE`, then restart the API                                 |
| `confera_system` password          | `SYSTEM_DATABASE_URL` of the API       | the operator                     | the association's password manager | `ALTER ROLE`, then restart the API                                 |
| Backup encryption password (1.0.0) | the backup job                         | the operator; two people         | offline                            | new backups with the new password; old ones keep theirs            |
| Registry credential                | the pipeline's secret store            | the maintainer                   | none needed                        | revoke and issue a new one                                         |
| Mail server passwords              | `mail_servers.password_sealed`, sealed | the admins who type them         | the database backup (sealed)       | an admin sets a new one; a changed target clears it                |
| PayPal credentials (0.7.0)         | sealed like the mail passwords         | the admins                       | the database backup (sealed)       | the same rule: a changed target clears them                        |

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
anything or may create anything, or is a member, through any chain of memberships, of a
role that is a superuser, may bypass row-level security (the system role among them) or
may create roles or databases: a member may become that role with `SET ROLE`. The system
role is refused for the same, except bypassing row-level security, which is its purpose.

Both are refused too when they are members of a **predefined role of PostgreSQL**, each
for what it would let a compromised application do beyond its own rows:

| Predefined role                                    | Lets a member                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| `pg_read_server_files`                             | read any file the server can read, the data files included       |
| `pg_write_server_files`                            | write any file the server can write                              |
| `pg_execute_server_program`                        | run any program as the operating-system user of the server       |
| `pg_read_all_data` / `pg_write_all_data`           | read or write every table and column, past the grants            |
| `pg_read_all_settings`                             | read the settings only a superuser sees (paths, archive command) |
| `pg_read_all_stats`, `pg_monitor`                  | read the statements of every other session                       |
| `pg_stat_scan_tables`                              | run functions that lock and scan any table                       |
| `pg_signal_backend`, `pg_signal_autovacuum_worker` | end the sessions of other roles, or the cleaning of the tables   |
| `pg_checkpoint`                                    | force checkpoints, a load on the whole server                    |
| `pg_maintain`                                      | run VACUUM, CLUSTER, REINDEX and LOCK TABLE on any table         |
| `pg_use_reserved_connections`                      | take the connections reserved for administrators                 |
| `pg_create_subscription`                           | subscribe to other servers, with connections out of this one     |

That is every predefined role of PostgreSQL 18 but `pg_database_owner`, which is
ownership and refused as such. A predefined role of a later version is refused until it
is decided here; a test compares the list with the roles of the server.

**A database that does not answer** is not waited for: a new connection may take 10 s,
the start-up check 20 s in all (then the API exits with 77), and readiness answers 503
when `SELECT 1` has not come back within 5 s. Liveness (`/health`) never asks the
database, and readiness turns 200 again by itself when the database answers.

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
| timing       | `test/timing/`                                                        | builds by itself     | `pnpm check`    |
| supply chain | `scripts/supply-chain-planted.mjs`                                    | the network          | `pnpm check`    |
| integration  | `test/integration/`                                                   | PostgreSQL in Docker | `pnpm test:int` |
| end to end   | `test/e2e/`                                                           | the stack in Docker  | `pnpm test:e2e` |

- **Unit:** configuration and the STAGE guard (with `LISTEN_HOST`), redaction, the HTTP
  layer (errors, host separation, headers), the OpenAPI lint and drift check, the PDF
  golden test and the PDF limits (long words, the largest document), architecture tests
  (lint rules on code samples, who imports the system client, who reads the environment,
  no credential compared with configuration, no `DEV_` key in a compose or deploy file),
  the test tools (`seed:e2e` refuses, the stub slot, the secret scanner with its two
  corpora and its manifest, the rules of one stack per checkout), and probes of single units (Serbian text and the glyph check
  in every field of a PDF).
- **Build:** the built application refuses every bad stage, instance and `DEV_` key,
  and a refused start loads no application code; no dev-tools code in `dist/`, and no
  seed or stub in any build; the committed OpenAPI files equal the code.
- **Timing:** a fresh process of plain Node makes its first PDF, the next ones, a table
  of 200 rows and a word of 3 000 letters in a narrow column in under 5 seconds each. It
  is a step of its own, so no other test runs beside it, and the middle one of five
  processes counts (three of the five must be under the limit): other work on the
  machine can only add time to a measurement, but the luckiest process alone must not
  meet a limit that a person waits for. A fresh process also reads a 1 MB relationship part
  of a `.docx` in each shape that makes a backtracking scan quadratic in under 100 ms (the
  middle one of three processes, SEC-M3-11).
- **Supply chain:** the checks of section 12 fail when they should, on planted cases.
- **Integration:** row-level security as the application role (raw SQL, Prisma, nested
  relations, a pool of one connection, 200 interleaved requests of two organisations),
  writes into another organisation, the catalogue check, what the roles cannot do, the
  start-up role check (memberships, `SET ROLE`, the predefined roles), a database that
  never answers, two `db:provision` at once and one after an interrupted `DROP DATABASE`,
  a clean production start with a canary in every secret, every database command
  refusing the stack of another checkout (a container labelled as one), the audit log
  that only grows for both run-time roles, the seeded role permissions, and the security
  events out of reach of a statement inside an organisation. A start or a refused start
  may take 120 s here: a guard against a hang, not an assertion of speed.
- **End to end:** supertest against the real application (`createApp` of
  `src/bootstrap.ts`, nothing replaced) with the configuration of a server, connected as
  the application role: every route of the OpenAPI files, the error format, the headers,
  no CORS grant, odd `Host` headers, many requests at once, the request log, readiness
  while the database hangs and after it answers again; the harness
  itself (schema from `migrate deploy`, the role, the factories); `seed:e2e`; the stack
  (the three roles, the mail catcher). From 0.2.0, on the two-organisation fixture of
  `test/e2e/support/actors.ts`: the authorisation matrix generated from the OpenAPI file
  for five actors (anonymous, an ended session, a reviewer, the other organisation's
  admin, an admin), sessions and sign-in (cookies, CSRF, Origin, expiry, the password
  asked again, the forwarded-for header), the brake, secure links and the password rules,
  users, the organisation profile with the sweep that no reading route shows the other
  organisation anything, the audit log, the CSP report route. Tests that need a link make
  it the way the sender will (`test/e2e/support/links.ts`), and the links suite ends by
  searching every text column and the log for every token it minted.

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
  listens for SMTP on `127.0.0.1:1025`. Nothing leaves your machine. (On a checkout with
  ports of its own: `CONFERA_MAIL_WEB_PORT` and `CONFERA_MAIL_SMTP_PORT` of `.env`.)
- **The stub slot** is where the stand-ins for outside services run: the PayPal stub
  arrives with 0.7.0, the fixture rate provider with 0.5.0. Until then it is empty:
  `GET http://127.0.0.1:4010/health` answers `{"status":"ok","stubs":[]}` and everything
  else 404. It listens on 127.0.0.1 only and refuses to start unless `STAGE` is `local`,
  `dev` or `test`. Another port: `STUBS_PORT` in `.env`.
- **`seed:e2e`** writes what `test/e2e/seed/e2e-seed.json` holds: two invented
  organisations with an admin and a reviewer each, on `example.test`, with fixed ids, and in
  the first one a conference open for submissions whose abstract form is published under the
  address **`e2eprobnaforma01`**: the form that the embedded test page of `confera_fe`
  frames (listed site `http://localhost:4000`, the harness of `confera_fe`; the frame list
  honours an `http` site on `STAGE=local` only),
  each active with the invented password `invented-Jasen-Kula-Reka-42` (for the sign-in
  tests of the web application), and the default email templates. It is safe to run again. **seed:e2e refuses to
  run unless `STAGE` is exactly `local` or `test`** (exit code 78), before it opens a
  connection; a `STAGE` of the environment wins over the one in `.env`, so on a server,
  where every process runs `STAGE=prod`, it cannot run.
- Neither the seed nor the stub slot is part of a build: they are scripts in `scripts/`,
  and a test of the built application proves that `dist/` and `dist-dev/` hold neither.

**The cross-repo smoke test.** With the API started this way (`.env` a copy of
`.env.example`, so it listens on `127.0.0.1:3001` and knows `localhost:3000` and
`127.0.0.1:3000` as its two host names), the browser tests of `confera_fe` run in front of
it instead of their stub. In `..\confera_fe`:

```
corepack pnpm api:check --sibling     the contract vendored there is the one of this checkout
```

- PowerShell: `$env:CONFERA_E2E_API_ORIGIN = 'http://127.0.0.1:3001'; corepack pnpm e2e`
- Git Bash, macOS, Linux: `CONFERA_E2E_API_ORIGIN=http://127.0.0.1:3001 corepack pnpm e2e`

Add `--project=real-api` for the short form (about two minutes). **Start the API first**
and leave it running: the run of `confera_fe` builds and starts its own servers (about
19 s) before it asks <http://127.0.0.1:3001/health/ready>; when the API is
not there it then stops, with its message and a stack trace. The API's part is only to
be up and ready: `/health/ready` answers `{"status":"ok"}` when it is. What the run tests,
and what the variable changes, is in the README of `confera_fe` (section 6, "Against the
real API"). The stub slot (`pnpm stubs`) is not needed for it while it is empty.

Stop everything with Ctrl+C in the two terminals and `corepack pnpm stack:down`.

## 10. OpenAPI

`openapi/openapi.json` (admin API) and `openapi/openapi.public.json` (public API) are
generated from the code and **committed**; the frontend vendors `openapi.json`. Their
`info.version` is the version of this repository. The same command writes the other
contracts of the API, `contracts/password-rules.json` (section 5, "The password rule set"),
`contracts/template-vectors.json` (section 5, "Mail") and the three contracts of the forms
(section 5, "Forms, embed and intake"), and the check fails while any of them is stale. The
committed files write invisible characters (a no-break space, a direction override) as
their escape.

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

- Every character is checked before rendering, in every place where text can enter a
  document: content, header, footer, page background, table cells, lists and the
  separator after their numbers, the title of a table of contents, the watermark. A
  character that no font can print stops the render with a message that names it
  (`MissingGlyphError`).
- What cannot be checked is refused (`UnsupportedPdfFeatureError`): SVG images, sections,
  attachments, text references, fill patterns, and every kind of node or property of a
  document definition that the renderer does not know. A test compares the renderer's
  lists with the source of pdfmake, so an upgrade of pdfmake that brings a new kind fails
  until the kind is added to the check or refused.
- Invisible characters (zero-width space, direction overrides, controls) are refused too.
- Ligatures are off, so that text copied from the PDF equals the text that went in, in
  every reader. The fonts are loaded with their ligature features removed; asking the PDF
  library for "no ligatures" per text made a long table three to four times slower.
- A document cannot read a file or call an address: the fonts are handed to pdfmake from
  memory, and every path and every URL is refused. A picture is given as data
  (`data:image/png;base64,…`).
- The PDF library and the fonts are loaded at the first use, once per process;
  `PdfRenderer.warmUp()` does it ahead of the first document.
- A render is synchronous work on the event loop, so its input is bounded. A run of more
  than 24 letters without a space is cut into pieces of 12 before pdfmake sees it (pdfmake
  breaks a word wider than its column letter by letter, at a cost that grows with the
  square of its length); a line may break between two pieces. A document with more than
  30 000 characters of text is refused (`PdfTooLargeError`): split it.
- A document must be made in under 5 seconds, the first one of a process included. The
  gate is the timing tier (`test/timing/`, section 8): fresh processes of plain Node,
  which is what a server is. On the development laptop the first document takes about
  0.3 s, the next ones under 0.1 s and a table of 200 rows about 0.1 s. Inside Jest the
  clock also measures Jest and whatever else the machine is doing (the same table: 0.5
  to 3 s in the unit tier), so the unit tier reports the time of its first document and
  leaves the judgement to the timing tier.

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
    keys, an address with a user and a password. An invented address must point at
    127.0.0.1 or localhost and its password must start with `invented-` or `local-only-`.
  - `scripts/secret-assignments/` finds a secret that has no format by the **name** it is
    bound to, or by the **place** it is handed to. Its rule is the next paragraph, and it
    is the rule you write code by.
- **Container images by digest.**

**The rule for a secret-like name (scanner 1.1.0).** In every file that git tracks or
would take, no literal value is bound to a secret-like name, compared with one, or handed
to a call where it takes a key or a secret.

- **A secret-like name** is decided by its last word, in any casing (`smtpPassword`,
  `SMTP_PASSWORD`, `smtp-password`):
  - the last word is, or ends with: password, passwd, pwd, passphrase, secret, token
    (`PGPASSWORD`, `DBPASSWD`, `MYSQL_PWD`, `keyPassphrase`, `csrfToken`, `clientSecret`);
  - the last word is pass, credential or credentials (`DB_PASS`, `smtpPass`; `bypass`
    and `compass` are not the word pass);
  - the last word is `key` and the word before it is one of: api, private, data, access,
    secret, signing, encryption, master, client, session (`AWS_SECRET_ACCESS_KEY`,
    `DATA_KEY`, `signingKey`).

  Qualifier words after the secret word, and a number at the end, do not count:
  sandbox, live, prod, production, staging, test, dev, local, previous, prev, old, new,
  current, next, primary, secondary, backup, rotated (`PAYPAL_CLIENT_SECRET_SANDBOX`,
  `DATA_KEY_PREVIOUS`, `SMTP_PASSWORD_2`). A name whose last word is another one is not
  secret-like: `passwordPolicy`, `tokenType`, `secretName`, `PASSWORD_MIN_LENGTH`,
  `SESSION_SECRET_FILE`, a label, a message; nor are `primaryKey`, `sortKey`,
  `cacheKey`, `publicKey`, `idempotencyKey`, nor a plural (`secrets:` of compose lists
  names, not values).

- **A literal value** is what is written in the file: a text, a number, a template text
  that starts with written text, a list of such values. Also:
  - a literal through a conversion: `Buffer.from(L)`, `new TextEncoder().encode(L)`,
    `atob(L)`, `btoa(L)`, `String(L)` (`const secretKey = Buffer.from('x')`);
  - in JavaScript, a name declared in the same file with a literal value, whatever the
    scope (`const k = 'x'; createHmac('sha256', k)`, `password: CANARY`);
  - in a shell, `$(echo x)`, `$(printf x | base64)` and `` `echo x` `` with written text;
    in PowerShell, `ConvertTo-SecureString 'x' -AsPlainText`, `Write-Output 'x'` and
    `echo x`.

- **Allowed values, and nothing else:**
  - nothing: an empty value, and also `null`, `~`, `true` and `false`, which are no
    value or a flag (`persist-credentials: false`);
  - a reference to something else as the whole value: `${VAR}`, `$VAR`, `$1`, `$@`,
    references one after the other (`"$PREFIX$SUFFIX"`), `$(command)` of any other
    command, `${{ secrets.X }}`; in JavaScript anything that is not a literal
    (`process.env.X`, a call that is no conversion, another variable that is not declared
    with a literal); in PowerShell a command or a call (`$p = Read-Host`);
  - a placeholder: a literal that **starts with** `invented-` or `local-only-`.

  A list of values under a secret-like name is read value by value.

- **There is no guess by length or by randomness.** `'too_short'` under a secret-like
  name is a finding, and so are `changeme` and `1`. A test that needs a password that is
  too short uses `'invented-x'`; a canary of a test starts with `invented-` too.
- **The written exceptions, and no others:**
  - the option `credentials` of the Fetch API takes a mode: under exactly that name,
    exactly `'include'`, `'same-origin'` and `'omit'` are not a finding;
  - versions under names of packages: in the maps `dependencies`, `devDependencies`,
    `optionalDependencies`, `peerDependencies`, `overrides`, `resolutions`, `catalog` and
    `catalogs` at the top of a package manifest or a pnpm workspace file (and
    `pnpm.overrides`), a **version specifier**: a semver range (`1.7.1`, `^1.2`,
    `>=1 <2 || 3.x`, `*`) or `workspace:`, `catalog:`, `npm:`, `link:`, `file:`,
    `portal:`, `patch:` followed by text. Any other value there (a dist tag, a git or web
    address) is read as everywhere else;
  - patches of packages: in `patchedDependencies` of a package manifest (also
    `pnpm.patchedDependencies`) or a pnpm workspace file, the path of a `.patch` file;
  - module paths: in `compilerOptions.paths` of a tsconfig or jsconfig file
    (`"@app/token": ["src/token.ts"]`);
  - GitHub Actions: under `permissions`, the levels `read`, `write` and `none`
    (`id-token: write`).
- **Where a name gets a value:**
  - lines of a shell (environment files, shell, compose, Dockerfile, this README): a line
    is cut into commands at `&&`, `||`, `;` and `|` outside quotes (also at its start, as
    in a continued `RUN`); each command is read for `NAME=value` at its start, with or
    without `export`, `env`, `cross-env`, quotes, a leading list dash, `ENV`, `ARG` or `RUN`, and for
    `-e NAME=value` or `--env NAME=value` anywhere. A line that starts with `#` or `;` is
    a comment;
  - `name: value` in YAML and `"name": value` in JSON, in any letter case, also in a file
    with one more extension (`compose.yml.example`); a YAML value under any other name
    is read as a line of a shell;
  - in JavaScript and TypeScript an assignment (also `+=`), a declaration (typed or not),
    a field of a class, an object property, a default parameter, an attribute of a JSX
    element, and a literal used as a fallback for such a name (`??`, `||`, a branch of a
    ternary), also inside the `${...}` of a template; a literal compared with such a name
    (`===`, `!==`, `==`, `!=`; `typeof token === 'string'` compares a type);
  - every text of JavaScript and every text value of JSON is also read as lines of a
    shell, in the strict syntax of a shell (a name of letters, digits and `_`, and `=`
    without spaces): `execSync('PGPASSWORD=x pg_dump')`, a script of `package.json`.
    Texts joined with `+` are read as one, and what is not a text in them is a
    reference (`'PGPASSWORD=' + password` is no finding).

  A file is read as UTF-8, or as UTF-16 when a byte-order mark says so.

- **Where a call takes a key or a secret** (the last name before the brackets, so
  `crypto.createHmac(...)` is `createHmac`): the first argument of `cookieParser`,
  `createSecretKey`, `createPrivateKey`, `pbkdf2`, `pbkdf2Sync`, `scrypt`, `scryptSync`;
  the second of `createHmac`, `createCipheriv`, `createDecipheriv`, `hkdf`, `hkdfSync`,
  `jwtVerify`, `jwtDecrypt`, `compactDecrypt`, `HmacSHA1`, `HmacSHA256`, `HmacSHA384`,
  `HmacSHA512`, `HmacMD5`, `sign`, `verify`, `encrypt`, `decrypt`; the first of `sign`
  when it is its only argument (`new SignJWT(payload).sign(key)`). Only a text counts
  there, not a number (`Math.sign(-1)`), and for `sign` and `verify` the name of an
  encoding is not a key (`signer.sign(privateKey, 'base64')`). A definition of a
  function or a method by such a name is not a call.

- **What is not read:** comments; a binary file; a file git ignores (`.env`); lockfiles;
  the two corpora of the scanner while they are exactly the files its manifest records
  (they hold the shapes of secrets on purpose; a changed corpus is read like any other
  file); and what this repository generates: the OpenAPI documents in `openapi/`
  (generated from the code and committed) and the Prisma client in `src/generated/` (not
  in git). Nothing is vendored. The list of what is left out is
  `scripts/secret-scan.config.mjs`; a hand-written file with a finding is changed, never
  added to that list. **A file larger than 2 MB is not read and is reported**, as a
  finding of its own.

- **What the rule does not see**, written down so that whoever judges a gap can:
  - a literal under a name that is not secret-like, used as a secret in another file, or
    handed on through an object, a function or a second variable
    (`const k = 'x'; const j = k; createHmac('sha256', j)`);
  - a call that is not on the list, a key at another position
    (`crypto.sign(alg, data, 'key')`), a call through an alias or a computed member
    (`const h = crypto.createHmac; h('sha256', 'x')`), a key under a property whose name
    is not secret-like (`{ k: 'x' }`);
  - a comparison by `switch`/`case`, `Object.is` or an assertion (`toBe('x')`);
  - a literal in a language the scan does not read as its syntax (SQL, Python,
    PowerShell beyond `$name = value`), except where its lines look like a shell;
  - YAML explicit keys (`? key`), keys in backticks, escaped identifiers (M1-ISS-08);
  - a secret that is no literal at all: a key file without a format of its own that git
    tracks, or a value put together at run time.

The scanner is one file without dependencies, `scripts/secret-assignments/secret-assignments.mjs`,
with its two corpora beside it: shapes that must be reported (`…reported.mjs`) and ordinary
lines that must not be (`…ordinary.mjs`). The unit tests run both. The three files hold
nothing about this repository and are copied unchanged into `confera_fe`, together with
`secret-assignments.manifest.json`: the version of the scanner and the SHA-256 of each of
the three files (over the text with LF line endings). `--self-test` compares the files
with it, so a copy that was changed, or is of another version, fails. After a change here:
a new `VERSION` in the scanner, then `--write-manifest`. On its own:

```
node scripts/secret-assignments/secret-assignments.mjs               scans the current directory
node scripts/secret-assignments/secret-assignments.mjs --self-test   runs the two corpora, checks the manifest
```

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
Dockerfile           the production images: runtime (API and worker) and jobs (section 15)
deploy/              the production topology, its templates, the proxy, the server scripts, the checks (section 15)
.github/             the pipeline: ci, image, deploy-staging (section 15)
src/startup.ts       checks the configuration before the framework and the application are loaded
src/config/          the configuration schema and the STAGE guard; the only reader of the environment
src/common/          HTTP layer (errors, surfaces, headers), logging
src/platform/prisma  tenant client, resolvers, start-up role check
src/platform/tenancy the organisation of the current request
src/platform/pdf     PDF renderer, fonts, glyph check
src/modules/         one folder per feature; dev-tools is left out of the production build
src/modules/access   sign-in, sessions, the brake, the password rule set, the own account
src/modules/links    secure links (invitation, reset, email change)
src/modules/users    user administration
src/modules/organisation  the organisation profile and its payment details
src/modules/audit    the audit recorder, its field allowlist, the log's route, the security summary
src/modules/mail     the outbox, the secret box, the SMTP transport, the sender and the worker
src/modules/mail-servers  mail servers and the rules of their target (ADR-11)
src/modules/mail-log the mail log, read only
src/modules/templates the template document format, its serialiser, the catalogue and the read API
src/modules/conferences  conferences and their listed sites
src/modules/csp-reports  the route for the web application's content-security-policy reports
src/modules/forms    the field catalogue, definitions, the rule interpreter, the admin and public form APIs
src/modules/files    the private storage, type detection, file names, uploads, the antivirus and its worker
src/modules/deadlines  deadlines in the conference's time zone, with their history
src/modules/submissions  the submissions table and detail, file downloads
src/modules/held-mail  the send breaker, the held emails and their release
contracts/           the password rule set, the template format and the forms (schemas, rule vectors), generated and committed
test/architecture    rules that hold for the whole code base
test/tooling         tests of the test tools (seed:e2e, the stub slot)
test/qa              probes of single units by the test engineer (PDF fields)
test/build           tests that start the built application
test/timing          wall-clock gates, run alone (a PDF from a fresh process)
test/integration     tests against PostgreSQL in Docker
test/e2e             end-to-end tests of the API; factories and the seed of invented people
test/support         helpers of the tests
scripts/             build, check, provisioning, supply-chain, seed and stub scripts (plain Node)
scripts/secret-assignments/  the secret scanner, its two corpora and its manifest (copied to confera_fe)
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
  up, steps 4 and 5 of section 2 were skipped, or PostgreSQL did not answer within 20 s.
- **`LISTEN_HOST` stops the start** (exit code 78). On `local`, `dev` and `test` the API
  listens on a loopback address only (section 4); `0.0.0.0` is for `prod` in a container.
- **`http://127.0.0.1:3001/api/v1/meta` answers 404.** Use `localhost` (section 5).
- **`pnpm install` fails with "frozen lockfile".** You changed `package.json`; see section 12.
- **A script stops with "dependencies are out of date".** Run `corepack pnpm install`.
  Scripts never install behind your back.
- **`check` fails on the secret scan after you wrote a test.** A literal value is bound
  to a name like `password` or `token`, or a connection address holds a password. Start
  the value with `invented-` (`password: 'invented-x'`); the rule is in section 12.
- **Port 3001 is in use.** An earlier `pnpm start` or `start:dev` is still running.
- **"A worker process has failed to exit gracefully"** in the unit tests of `check` is
  harmless: a guard timer of one test (the slow-server case of
  `src/modules/mail/mail-transport.edge.spec.ts`) is still running when the suite ends,
  and Jest stops the worker. Every test has passed when it is printed.
- **`seed:e2e did not run`** (exit code 78). `STAGE` is not `local` or `test`: look at
  `.env` and at the environment of your terminal, which wins over `.env`.
- **`db:provision` (also inside `test:int` and `test:e2e`) fails with "cannot reach
  PostgreSQL".** The stack is not up: `corepack pnpm stack:up`. Its other sentences name
  what else happened: PostgreSQL still starting or recovering, a refused superuser
  password, or a database that does not accept connections.
- **"... did not run: the database of ... belongs to the stack ... of another checkout"**.
  Your `.env` points at the stack of another clone or worktree. Run
  `corepack pnpm stack:ports`, then `corepack pnpm stack:up` (section 2, "One stack per
  checkout").
- **`stack:up` says a port "is in use by another program"**. Something else listens there
  (an old stack of 0.1.0, a PostgreSQL of your own): `corepack pnpm stack:ports`.
- **Never write `\uXXXX`-style invisible characters into a file as real characters.**
  Use the escape in the source, so that a reviewer can see them.

## 15. Production image and pipeline

0.4.0 (M4-BE-07, M4-BE-08) adds the production images, the topology of a server and the
pipeline. They are built and checked here **without a server**: the staging server is rented
only after Gate 4a. No workflow of this repository can reach a server before then.

### The images

| Image                                      | Target    | What it holds                                                                                                                                                     |
| ------------------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ghcr.io/stojanivanisevic/confera-be`      | `runtime` | `dist/` (the production build, without the dev-tools module), the production dependencies, `package.json`. The API **and** the worker run it, by the same digest. |
| `ghcr.io/stojanivanisevic/confera-be-jobs` | `jobs`    | The one-shot jobs: `prisma migrate deploy` (its default), `db-provision`, `seed-production`, `first-admin`. Never serves a request.                               |

- Every stage of `Dockerfile` starts from Node 22.23.3 (Debian bookworm, slim) **by digest**.
- The runtime image holds no source, no test, no script, no development dependency and no
  package manager (npm, npx, corepack and yarn are removed). It runs as `node` (uid 1000) and
  works on a **read-only root**: it writes only to the file volume and to `/tmp`.
- The jobs image needs the Prisma command line, a development dependency, so it carries the
  full installation; it holds no source, no build and no test tool (`seed:e2e`, the stubs).
- The runtime image names its jobs image **by digest** in the label
  `org.udekom.confera.jobs-image`, so a deploy names one digest and the migration that goes
  with it follows from the content of that image.
- **Secrets are files** (`/run/secrets/<name>`), never `ENV` lines, build arguments or
  `docker inspect` entries. `deploy/image/entrypoint.sh` turns the files a service is given
  into the variables of `src/config` and runs the command; it knows five names and refuses to
  start on any other file.

```
docker build --target runtime -t confera-be .
docker build --target jobs -t confera-be-jobs .
```

### The topology of a server: `deploy/`

| File                                                                                          | What it is                                                                                                      |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `deploy/compose.yml`                                                                          | proxy, web, api, worker, postgres, clamav, and the jobs `migrate` and `provision`; staging and production alike |
| `deploy/compose.env.example`                                                                  | the settings of the topology: instance, the two host names, where settings and secrets live, the two ports      |
| `deploy/api.env.example`                                                                      | the settings of the API and the worker (no secret)                                                              |
| `deploy/web.env.example`                                                                      | the settings of the web application: its two origins, nothing else (it must never get a secret)                 |
| `deploy/proxy.env.example`                                                                    | the ACME address, and on staging the gate's user and password hash                                              |
| `deploy/proxy/Caddyfile`                                                                      | the reverse proxy (Caddy 2.11.7): TLS, routing by host and path, body limits, HSTS                              |
| `deploy/proxy/gate-staging.caddy`                                                             | the access gate of staging (every path, noindex); `gate-production.caddy` adds nothing                          |
| `deploy/server/confera-deploy`                                                                | the deploy script (root): one target and one digest, nothing else                                               |
| `deploy/server/confera-deploy-gate`                                                           | the forced command of the deploy keys                                                                           |
| `deploy/server/sshd-confera-deploy.conf`, `sudoers-confera-deploy`, `authorized_keys.example` | how sshd and sudo are set up for the deploy keys                                                                |
| `deploy/server/deploy.conf.example`                                                           | the deploy script's settings: the fixed image repositories                                                      |

What the topology guarantees (ADR-26), and what `deploy/checks/topology.mjs` proves:

- **Two networks.** `edge`: proxy, web, api. `backend`: api, worker, postgres, clamav and the
  jobs. The web container cannot reach Postgres or ClamAV, by name or by address.
- **Secrets per service.** api and worker: `database_url`, `system_database_url`, `data_key`.
  migrate: `migration_database_url` (the owner role exists only there). postgres:
  `postgres_password`. provision: the four database ones. web, proxy and clamav: none.
- **Every container** runs as a user of its own (web, api, worker and the jobs uid 1000,
  postgres 999, clamav 100, proxy 10002), on a read-only root file system, with every
  capability dropped, no new privileges, and memory, CPU and process limits. The proxy keeps
  `NET_BIND_SERVICE` in its bounding set only because the Caddy binary carries that file
  capability; with no new privileges no process holds it (the check reads `CapEff` and
  `CapPrm` of every process of every container). No container mounts the Docker socket; only
  the proxy publishes ports (80 and 443); neither proxy nor web mounts the file volume.
- **One worker.** The API runs with `MAIL_WORKER_INTERVAL_SECONDS=0` and
  `JOBS_INTERVAL_SECONDS=0`; the worker container (the same image) runs the outbox and the
  file jobs. Run one worker only: the outbox is not claimed with row locks.
- **The proxy** (M3-ISS-06): `/api/v1/*` on the admin host and `/public/v1/*` on the public host
  go **straight to the API**; everything else goes to the web application, whose framework
  keeps only 10 MB of a body. An upload (`POST /public/v1/forms/<slug>/uploads`) may carry
  51 MB (the largest file a form may take, 50 MB, and the envelope); every other route 1 MB. A
  declared `Content-Length` above the limit is refused with 413 before anything is forwarded.
  The proxy overwrites `X-Forwarded-For` (it trusts no proxy in front of it), passes `Host`
  unchanged, adds HSTS and no other security header, and answers no other host name.

#### The files on a server

| Path                                                                                             | Owner, mode            | Holds                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/srv/confera/deploy/`                                                                           | root, 0755             | a copy of this repository's `deploy/` folder, put there by the operator                                                                                 |
| `/srv/confera/compose.env`                                                                       | root, 0644             | from `compose.env.example`                                                                                                                              |
| `/srv/confera/images.env`                                                                        | root, 0644             | `CONFERA_API_IMAGE`, `CONFERA_JOBS_IMAGE`, `CONFERA_WEB_IMAGE`, each `repository@sha256:...`; the deploy script writes it (by hand for the first start) |
| `/srv/confera/config/api.env`, `web.env`                                                         | root, 0644             | from the templates                                                                                                                                      |
| `/srv/confera/config/proxy.env`                                                                  | root, 0640             | from the template (the gate's hash in single quotes)                                                                                                    |
| `/srv/confera/secrets/database_url`, `system_database_url`, `data_key`, `migration_database_url` | uid 1000, 0400         | one value each, nothing else                                                                                                                            |
| `/srv/confera/secrets/postgres_password`                                                         | uid 999, gid 999, 0440 | the superuser's password; `provision` reads it through group 999                                                                                        |
| `/srv/confera/proxy-data/`                                                                       | uid 10002, 0700        | the proxy's certificates and ACME account                                                                                                               |
| `/etc/confera/deploy.conf`                                                                       | root, 0644             | from `deploy/server/deploy.conf.example`                                                                                                                |

Compose bind-mounts the secret files read-only, so their owner on the host is the owner the
container sees. The first start, once the files are in place (`C` stands for
`docker compose --project-name confera --env-file /srv/confera/compose.env --env-file /srv/confera/images.env --file /srv/confera/deploy/compose.yml`):

```
C up --detach --wait postgres
C run --rm provision          the roles and the database (again first after a restore)
C run --rm migrate
C up --detach --wait
```

### The deploy by digest (ADR-27)

A deploy is `confera-deploy <be|web> sha256:<64 hex>`. It pulls `<fixed repository>@<digest>`
(the repositories are in root's `/etc/confera/deploy.conf`, never in the request), for `be`
also the jobs image the API image names, runs the migration (a failed one restarts nothing),
writes the digest into `images.env`, restarts the services of the target, waits for their
health checks and smoke-tests (the API's readiness; the web application answers). If the new
version does not come up, it puts `images.env.previous` back and restarts the previous version.
Migrations must therefore stay compatible with the previous version (expand, then contract in
a later release): a rollback restores the image, never the schema. One deploy runs at a time.

- **Staging:** the pipeline calls it through SSH. Each repository has its own deploy user and
  key (`confera-deploy-be`, `confera-deploy-web`). sshd forces the command
  `/usr/local/sbin/confera-deploy-gate <target>` for that user, whatever the client asks; the
  key line carries `restrict` as well. The gate accepts exactly one digest and hands it to the
  deploy script through a sudo rule that allows that script and that target only. No shell, no
  terminal, no forwarding, no sftp or scp, no membership of the docker group.
- **Production:** the server pulls. The operator runs `sudo confera-deploy be <digest>` (and
  `web`) by hand with the digest staging ran, after Stojan's approval (Gate 4).

### The pipeline: `.github/workflows/`

Every third-party action is pinned by commit hash (its version in a comment), every image by
digest (BuildKit v0.33.1 included). The default token is read-only.

| Workflow             | When it runs                                                                   | What it does                                                                                                                                                                                                                                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml`             | every pull request to develop or main; every push to develop, main, release/** | `pnpm check`; the integration and end-to-end tests on the development stack; ST-63 (`deploy/checks/deploy-gate.mjs`). No secret, no push, no server.                                                                                                                                                                                                             |
| `image.yml`          | every push to develop, every `v*` tag, or by hand                              | **build** (runs project code, holds no credential): both images as OCI archives with their digests (`deploy/ci/build-images.sh`), ST-02 and ST-04 on exactly those images. **publish** (no checkout, so no project code; may write packages): copies the archives to ghcr.io with `skopeo --preserve-digests`, checks the digests, writes them into the summary. |
| `deploy-staging.yml` | **by hand only** (`workflow_dispatch`), with a digest                          | Runs no project code. Needs the environment `staging` (protection rule) and refuses until its variable `STAGING_DEPLOY_ENABLED` is `true`. Checks the input is a digest and hands it over SSH to the forced command.                                                                                                                                             |

`.github/CODEOWNERS` names Stojan for `.github/`, `deploy/`, `Dockerfile` and `.dockerignore`.

### The checks on this machine (Docker)

```
node deploy/checks/deploy-gate.mjs                         ST-63, the part that needs no server
node deploy/checks/topology.mjs                            ST-02, ST-04, ST-53, M3-ISS-06 on the real images and compose file
node deploy/checks/topology.mjs --images-only --no-build   ST-02 and ST-04 only, nothing started (the pipeline)
```

- `deploy-gate.mjs` builds an SSH server set up from `deploy/server/` with a stand-in for docker,
  and proves: a deploy key hands over a digest and the script pulls exactly
  `<fixed repository>@<digest>`; 34 malformed requests (tags, repositories, two digests, shell
  syntax, a newline, options, `sftp`, `scp`, `rsync`) are refused with nothing reaching docker;
  the key opens no shell, no terminal and no forward; one repository's key cannot deploy the
  other's image; the deploy user can run nothing else as root; the deploy script refuses a
  foreign or tagged jobs image and an unsafe configuration, and changes nothing on a failed
  migration.
- `topology.mjs` builds both images (or takes them with `--no-build`), takes the web image
  `confera-m4-infra-web:check` (built from `../confera_fe` when it is missing), and starts
  `deploy/compose.yml` as a staging instance (project `confera-m4-infra`, host names under
  `.localhost`, random secrets in files, free ports): provision, migrate, every service healthy,
  then every guarantee listed above. `--without-clamav` saves about 1.5 GB of memory; `--keep`
  leaves the stack up for a look by hand.
- Both remove everything they create (names start with `confera-m4-infra`). Logs:
  `.artifacts/deploy-checks/`. On Windows the large uploads are sent from a container on the
  edge network: WSL's localhost relay stalls large bodies on a published port.

### Gate 4a: what must be set up, and what only the staging server can prove

On GitHub, in each repository:

- [ ] Branch protection on `develop` and `main`: pull request required, **review from Code
      Owners required** (CODEOWNERS covers `.github/`, `deploy/`, `Dockerfile`), no bypass, and
      automation tokens that cannot approve or push.
- [ ] Actions settings: the workflow token read-only by default; Actions may not approve pull
      requests; only actions pinned to a full commit hash allowed.
- [ ] The environment **`staging`** with a protection rule (Stojan approves each run) and
      deployments from `develop` only; its secret `STAGING_DEPLOY_KEY` (the private key of this
      repository's deploy user, nothing else) and its variables `STAGING_SSH_HOST`,
      `STAGING_SSH_KNOWN_HOSTS` (the server's host key line) and `STAGING_DEPLOY_ENABLED=true`.
- [ ] The packages `confera-be`, `confera-be-jobs` and `confera-web` private; the server pulls
      with a read-only token of its own.
- [ ] The event that starts a staging deploy named in the reduced runbook (here: by hand, with
      the digest from the summary of `image.yml`).

On the staging server (M4-OPS-01, M4-QA-03), proved there and not here:

- [ ] ST-63 against the real sshd: the deploy keys open no shell; a deploy by digest pulls,
      migrates, restarts and smoke-tests; a broken image rolls back.
- [ ] ST-53 on the real host: the checks of `topology.mjs` against the running stack, plus the
      owners and modes of the secret files and of the proxy's data directory.
- [ ] ST-02 and ST-04 on the digests staging runs (the pipeline proves them on every build).
- [ ] ST-25: a forged `X-Forwarded-For` does not change the throttle key behind the real proxy.
- [ ] ST-50 and ST-64: from outside only 80, 443 and SSH answer; without the gate credentials
      every path but the listed exceptions is refused; outgoing mail ports closed.
- [ ] A 20 MB upload from outside through the real proxy and TLS (M3-ISS-06 end to end); the
      certificate issued and renewed by Caddy itself.
- [ ] ClamAV keeps its signatures current (freshclam as uid 100) on the server's network.
- [ ] Open for the reduced runbook: request-rate and concurrent-upload limits at the proxy
      (ADR-26). The official Caddy image has no rate-limit module; until it is decided the API's
      own limits apply. The staging mail catcher (Mailpit behind the gate) is not in the compose
      file yet.
