# confera_be

The API of **Confera**, the web application for the conferences and membership of the
association UdEkoM Balkans. NestJS 12, Prisma 7 and PostgreSQL 18, written in strict
TypeScript. The web application lives in the repository `confera_fe`.

This README is the only thing you need for a fresh clone: follow it from top to bottom.
If a step is missing here, that is a defect; please report it.

## 1. What you need

| Tool     | Version                                     | Check                    |
| -------- | ------------------------------------------- | ------------------------ |
| Node.js  | 22 LTS, 22.13 or later (developed on 22.14) | `node --version`         |
| corepack | the one that comes with Node 22 (0.31)      | `corepack --version`     |
| Docker   | with Docker Compose v2, running             | `docker compose version` |
| git      | any current version                         | `git --version`          |

You do **not** install pnpm yourself. The version is pinned in `package.json`
(`packageManager`, pnpm 11.28.2 with its hash) and corepack downloads it on first use.

**Every command in this README starts with `corepack pnpm`.** On Windows `corepack enable`
needs administrator rights (it writes into `C:\Program Files\nodejs`); `corepack pnpm ...`
needs none and does the same. If you did run `corepack enable`, plain `pnpm ...` works too.

The commands work the same in PowerShell, cmd, Git Bash, macOS and Linux.

Ports used on your machine: **3001** (API), **5432** (PostgreSQL), **8025** and **1025** (Mailpit).

## 2. First start

```
git clone https://github.com/stojanivanisevic/confera_be.git
cd confera_be
```

1. Create your local environment file. Its values work as they are; none is a secret.

   - Windows (PowerShell or cmd): `copy .env.example .env`
   - macOS, Linux, Git Bash: `cp .env.example .env`

2. Install the dependencies. The install never changes the lockfile.

   ```
   corepack pnpm install
   ```

3. Run all checks. They need no database.

   ```
   corepack pnpm check
   ```

   It ends with `check passed`.

## 3. Commands

| Command                                       | What it does                                                                                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `corepack pnpm check`                         | Formatting, lint, typecheck, unit tests, both builds, tests of the built application, supply-chain checks. Must be green before a change is handed over. |
| `corepack pnpm test`                          | Unit and architecture tests (no build, no Docker).                                                                                                       |
| `corepack pnpm build`                         | The **production build** into `dist/`.                                                                                                                   |
| `corepack pnpm start`                         | Runs the production build (`dist/main.js`) with the variables of `.env`.                                                                                 |
| `corepack pnpm start:dev`                     | Development: compiles into `dist-dev/`, recompiles and restarts on every change.                                                                         |
| `corepack pnpm lint` / `format` / `typecheck` | The single steps of `check`.                                                                                                                             |
| `corepack pnpm supply-chain`                  | Pinned versions, frozen lockfile, `pnpm audit` (fails on high), secret scan, image digests.                                                              |
| `corepack pnpm stack:up` / `stack:down`       | Starts and stops the development stack in Docker (PostgreSQL and Mailpit).                                                                               |

## 4. Configuration

The API reads its configuration from environment variables, and only through the module
`src/config`. A lint rule forbids `process.env` anywhere else.

- `.env.example` lists every variable with a comment. Copy it to `.env` for local work.
- `pnpm start` and `pnpm start:dev` load `.env` if it exists. The application itself never
  reads a file; on a server the variables come from the container.
- A missing or invalid variable **stops the start**. The message names each variable and
  never repeats a value, because a value can be a secret. The exit code is 78.
- `STAGE` has no default. Its values are exactly `local`, `dev`, `test` and `prod`.

No secret is ever committed. `.env` is ignored by git; `pnpm supply-chain` scans the
files git would take.

## 5. Dependencies and the supply chain

The rules of ADR-01 are settings in `pnpm-workspace.yaml`; `pnpm supply-chain` checks
that they stay.

- **Exact versions only**, in `package.json` and for pnpm itself.
- **Frozen lockfile:** `pnpm install` fails instead of changing `pnpm-lock.yaml`.
- **Minimum release age:** a version must be public for 3 days before it can be installed.
- **Build scripts by name:** a dependency may run an install script only if
  `allowBuilds` names it. An unlisted build script stops the install.
- **Vulnerability gate:** `pnpm audit` fails `check` on a finding of severity high or critical.
- **Secret scan** with secretlint. Invented test credentials must start with `invented-`
  or `local-only-` and point at 127.0.0.1; anything else that looks like a credential fails.
- **Container images by digest.**

To add or update a dependency on purpose:

```
corepack pnpm add <name>@<exact version> --no-frozen-lockfile
```

If pnpm reports an ignored build script, decide `true` or `false` for it under
`allowBuilds` in `pnpm-workspace.yaml`, with a comment that says why.

## 6. Layout

```
prisma/            schema and committed migrations
src/config/        the configuration schema; the only reader of the environment
src/common/        code shared by all modules
src/platform/      technical building blocks (database, PDF, ...)
src/modules/       one folder per feature
test/architecture  tests of rules that hold for the whole code base
test/build         tests that start the built application
test/support       helpers of the tests
scripts/           build, check and supply-chain scripts (plain Node, run everywhere)
eslint/            the lint rules with a security purpose
```

## 7. Things a newcomer trips over

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
- **`pnpm install` fails with "frozen lockfile".** You changed `package.json`; see section 5.
- **A script stops with "dependencies are out of date".** Run `corepack pnpm install`.
  Scripts never install behind your back.
