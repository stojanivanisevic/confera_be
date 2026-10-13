# Changelog

All notable changes to this repository are written here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the versions follow
[Semantic Versioning](https://semver.org/). `confera_be` and `confera_fe` carry the same
version at every milestone (ADR-19).

## [Unreleased]

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
- Architecture tests: who reads the environment (syntax tree), no credential compared with a configuration value, no `DEV_` key in a compose or deploy file.
