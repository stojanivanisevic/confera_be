# Changelog

All notable changes to this repository are written here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/). `confera_be` and `confera_fe` carry the same
version at every milestone (ADR-19).

## [Unreleased]

### Added

- Users, the two roles and their permissions seeded by migration; every route declares a permission or that it is public, and the application does not start otherwise; the authorisation matrix is generated from the OpenAPI file for five actors (M2-BE-01).
- Sign-in and sessions (ADR-03): a `__Host-` cookie with a random token stored as its SHA-256, a new token at every sign-in, a session-bound CSRF header, an exact Origin check, 24 hours without use and 7 days at the latest, every ending event, the password asked again valid for 5 minutes, the brake per account and per address with the known-device cookie and a limited notice, equal answers in body and time, the one-hop client address, the second-factor step of 0.9.0 in the model (M2-BE-02).
- The password rule set of Gate 2 (12 characters, not common or leaked, not an own or the organisation's name, both entries match), enforced by the server with each broken rule named, and exported with 37 vectors as `contracts/password-rules.json` (M2-BE-02, ST-62).
- Secure links for invitations, password resets and email changes (ADR-04): one purpose per endpoint, opened by GET and used up by POST, a newer link revoking the older, a cool-down and a daily cap for resets, no reset for invited or deactivated accounts, and a mail outbox that stores which link a message needs, never the link (M2-BE-03).
- User administration with the last-admin rule, versions against two admins editing at once, removed users kept for attribution, the password asked again and a notice to every active admin for each change (M2-BE-04); the own password and email change, the latter confirmed from the new address.
- The organisation profile with the issuer data and the payment details (bank accounts and IBAN checked), the latter with the password again and a notice to all admins, and who changed them when (M2-BE-05).
- The audit log, insert-only for both run-time roles, with old and new values only for the fields on the list in code; security events of the instance with the summed entry of failed sign-ins for unknown addresses (M2-BE-06).
- `POST /public/v1/csp-reports` for the reports of the web application's content security policy, with a size limit, a rate limit and no personal data kept (M1-ISS-11).
- `@node-rs/argon2` for the password hashes (argon2id, 19 MiB, 2 passes).
- Mail servers (ADR-11; M2-BE-07): a default and a fallback per organisation, the password write-only and sealed (AES-256-GCM under `DATA_KEY`, bound to its row), cleared when host, port, user or TLS mode change; TLS required (implicit or STARTTLS, TLS 1.2, verified certificate), no TLS only on developer stages; in production no loopback, private or container address and the mail ports only; a test message with a generic answer; every change with the password again and a notice to all admins (ST-19, ST-20). `DATA_KEY` is a new required secret.
- The outbox worker and the mail log (ADR-13; M2-BE-08): due rows claimed inside their organisation so a message goes once, the template chosen by conference and language, the servers in the order of FR-SMTP-02 with the fallback, the secure link minted at send time and logged as `[link]`, a send rate per server, backoff and five attempts, interrupted rows flagged `stuck`; one structured recipient; the log's content can be switched off per organisation; `GET /api/v1/mail-log`. `MAIL_WORKER_INTERVAL_SECONDS` (default 5). nodemailer 10.1.0.
- Conferences (FR-CONF-01 to 04; M2-BE-09): create, change, state, copy; codes unique per organisation and edition; listed sites kept as origins and refused with a wildcard, path, query, user part, space, semicolon or a 21st entry, `https` only outside `STAGE=local` (ST-30); time zone and languages.
- The template document format (ADR-12; M2-BE-10): a closed set of nodes checked on save and again at render, a serialiser to HTML and plain text, the placeholder catalogue per type, `contracts/template-vectors.json` with refused and rendered vectors (ST-58, ST-22); default templates of seven types in English and Serbian; `GET /api/v1/mail-templates` and its catalogue.
- `pnpm seed:production` (the organisation, its templates and the five conferences as drafts, no user) and `pnpm first-admin` (an invitation only, its link printed once to the terminal) (M2-BE-11, ST-27).

### Changed

- `seed:e2e` gives each invented person the invented password of `test/e2e/seed/e2e-seed.json` (they are active and can sign in, for the sign-in tests of the web application) and writes the default email templates; still only on `STAGE=local` or `test`.
- Secret scanner 1.1.0 (M1-ISS-01, M1-ISS-03 to M1-ISS-07, the Security reviewer's proviso M1-ISS-17): a literal handed to a call where it takes a key or a secret (`cookieParser('x')`, `jwt.sign(p, 'x')`, `createHmac(alg, 'x')`, `createCipheriv(alg, 'x', iv)`, `new SignJWT(...).sign(new TextEncoder().encode('x'))` and the other calls of the written list) is a finding; so is a literal through a conversion (`Buffer.from('x')`), a name declared with a literal in the same file, and a literal compared with a secret-like name. Every text of JavaScript and every text value of JSON is read as lines of a shell (`execSync('PGPASSWORD=x ...')`, a script of `package.json`), and every line of a shell is cut into commands at `&&`, `||`, `;` and `|`, which also reads a continued `RUN` of a Dockerfile. `$(echo x)`, `$(printf x)` and PowerShell's `ConvertTo-SecureString 'x'` count as the literal they print. In the maps of dependencies only a version specifier is an exception, and only at the top of a manifest; `compilerOptions.paths` of a tsconfig and the patch paths of `patchedDependencies` are no longer findings. A file larger than 2 MB is reported instead of skipped. The rule in the README says what the scan does not see.
- The limit of an API start, or a refused start, in the integration tests is 120 s instead of 30 s: a guard against a process that hangs, not an assertion of speed, which the timing tier holds; a loaded machine no longer fails them for the wrong reason (M1-ISS-43).
- One development stack per checkout (M1-ISS-13): the Docker Compose project is named after the folder of the checkout (`confera-<folder>-<hash>`, or `CONFERA_STACK_NAME`), so containers and the database volume are its own; the ports come from `.env` (the port of the database addresses, `CONFERA_MAIL_WEB_PORT`, `CONFERA_MAIL_SMTP_PORT`), and `pnpm stack:ports` writes a free set derived from the checkout. `stack:up` refuses a port of another checkout's stack or of another program; `db:provision`, `db:migrate`, `db:status`, `db:diff`, `seed:e2e`, `start`, `start:dev`, `test:int` and `test:e2e` refuse a database that another checkout's stack (or a container of no Confera stack) serves, before they connect. New: `stack:wipe`, `stack:ports`, `stack:info`. The shared project `confera` and volume `confera_pgdata` of 0.1.0 are no longer used.

## [0.1.0] - 2026-10-14

### Added

- Scaffold of the API: NestJS 12, Prisma 7, strict TypeScript 6.0.3, pnpm 11 through corepack.
- Configuration module with a schema: a missing or invalid variable stops the start and is named.
- `pnpm check`: formatting, lint with security rules, typecheck, tests, builds and supply-chain checks.
- Development stack in Docker: PostgreSQL 18 and Mailpit, images referenced by digest.
- STAGE and INSTANCE guard; the dev-tools module exists only in the development build.
- `GET /health` and `GET /api/v1/meta`; the admin API answers only under the admin host name.
- One error format (`application/problem+json`); an unknown error answers with a code and a trace id only.
- JSON log with redaction by field name; the request log holds the route, never the address.
- OpenAPI files generated from the code and committed in `openapi/`, with a drift check and a schema lint.
- Database roles and provisioning script; first migration with row-level security on every tenant table.
- Tenant database client (every operation inside the organisation of the request), resolvers of the system role, start-up check of the database roles, `GET /health/ready`.
- Integration tests against PostgreSQL in Docker (`pnpm test:int`): tenant isolation, catalogue check, roles, clean production start.
- PDF renderer on pdfmake with embedded Manrope and Noto Sans, glyph check, ligatures off; bilingual sample (`pnpm pdf:sample`).
- End-to-end tests of the API (`pnpm test:e2e`): supertest against the real application on PostgreSQL in Docker as the application role, with factories for invented people.
- `pnpm seed:e2e` (refuses to run outside the stages local and test) and `pnpm stubs`, the stub slot of the development stack.
- `pnpm test:supply-chain`, part of `pnpm check`: planted fake secrets, a vulnerable package and an unlisted build script must each be caught.
- Cross-repo smoke test (M1-QA-02): the browser tests of `confera_fe` run in front of this API, started by the commands of README section 9 and nothing else.
- PDF timing gate: the middle one of five fresh processes must make each kind of document in under 5 seconds (not the fastest one).
- Architecture tests: who reads the environment (syntax tree), no credential compared with a configuration value, no `DEV_` key in a compose or deploy file.

### Fixed

- The surface of a request is chosen by an exact match of a syntactically valid `Host` header against the configured host names; a header with a user part, a path, a query or an encoded character is not found.
- The secret scan also reports every literal value bound to a secret-like name (decided by the last word of the name: password, pass, passphrase, secret, token, credentials, a key of an API and the like, with qualifier words such as `_SANDBOX` after it), in every syntax where a name gets a value: `NAME=value` lines and `-e NAME=value` arguments, YAML, JSON, JavaScript and TypeScript, also in UTF-16 files. Empty values, references and placeholders that start with `invented-` or `local-only-` are the only allowed values; there is no guess by length; three narrow exceptions are written down. The scanner (version 1.0.0), its two corpora and a manifest of their hashes are in `scripts/secret-assignments/`.
- PDF: the glyph check covers every place where text can enter a document (page background, title of a table of contents, list separators); what cannot be checked (SVG images, sections, attachments, text references, fill patterns, unknown kinds) is refused.
- PDF: the fonts are loaded once, from memory, with their ligature features removed, so the PDF library no longer shapes every text without its cache; a table of 200 rows renders three to four times faster. The 5-second criterion is asserted by `pnpm test:timing`, a step of its own in `pnpm check`: fresh processes of plain Node, the first document included.
- A start that the configuration refuses ends before the framework and the application are loaded (`src/startup.ts`): it runs no application code and costs a tenth of the time, which the tests of the built application depend on when the machine is busy.
- The start-up role check follows every chain of memberships (`pg_has_role(..., 'MEMBER')`, so a membership that only allows `SET ROLE` counts too): the application role is refused when it can reach a role that is a superuser, may bypass row-level security (the system role among them) or may create roles or databases; the system role when it can reach a superuser or a role that may create roles or databases. Both are refused as members of a predefined role of PostgreSQL: the 15 of PostgreSQL 18 that are memberships (from `pg_read_server_files` to `pg_create_subscription`, each with its reason), and any `pg_` role of a later version until it is decided; `pg_database_owner`, the 16th, is ownership and refused as such. The API exits with 77 (E1).
- On the stages `local`, `dev` and `test` the API listens on a loopback address only: `LISTEN_HOST` must be in 127.0.0.0/8, `::1` or `localhost`, otherwise the start is refused with exit code 78 before the framework is loaded. `prod` is unchanged (E2).
- A database that accepts connections and never answers is not waited for: a new connection may take 10 s, the start-up role check 20 s in all (then exit code 77), and `GET /health/ready` answers 503 when `SELECT 1` has not come back within 5 s; readiness answers 200 again by itself when the database does. `GET /health` never asks the database (E5).
- PDF: a run of more than 24 letters without a space is cut into pieces of 12 before pdfmake sees it (one word of 3 000 letters in a narrow column took 56 s on the event loop, now well under a second), and a document with more than 30 000 characters of text is refused with `PdfTooLargeError`. The timing tier also measures the long word (E6).
- `db:provision` holds an advisory lock on the server for its whole run, so two runs at once wait for each other instead of failing with "tuple concurrently updated"; a database that an interrupted `DROP DATABASE` left invalid is dropped and created again; a run whose connection breaks (PostgreSQL restarted or still starting) starts again by itself, up to three times; a failure is one sentence that names what happened and its error code (E8).
- README: the clone names its branch (`main` the latest release, `develop` the work in progress), with `confera_be` and `confera_fe` side by side in one folder; `db:migrate` ends with one of two sentences, both success; the cross-repo smoke test starts the frontend's three servers before it asks `/health/ready`, so the API is started first; exit codes, test tiers, layout and the things a newcomer trips over brought up to date with the fixes above.
