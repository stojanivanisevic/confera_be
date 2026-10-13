import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Configuration of the Prisma CLI only (generate, migrate). The application never reads it.
//
// Migrations run as the OWNER database role, whose credentials exist only where
// migrations run (ADR-05): MIGRATION_DATABASE_URL. `prisma generate` needs no database,
// so a missing value is tolerated here and reported by the migrate commands themselves.
//
// This file and src/config are the only places allowed to read the environment (ADR-01).
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.MIGRATION_DATABASE_URL ?? '',
  },
});
