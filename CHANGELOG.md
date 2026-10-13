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
