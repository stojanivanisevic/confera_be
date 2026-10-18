import { join } from 'node:path';
import type { Client } from 'pg';
import { runNode } from '../support/run-node';
import { as, createActors, type Actors } from './support/actors';
import { type E2eApp, startE2eApp } from './support/e2e-app';
import { connectAsOwner, e2eDatabase } from './support/e2e-database';
import { Factories } from './support/factories';
import { inOrganisation } from './support/forms';
import { linkPath, mintLink } from './support/links';

/**
 * The operator's global revoke (M2-ISS-12, ADR-03): `pnpm sessions:revoke-all --yes` ends every
 * session of an organisation, every secure link not yet used and every queued message that
 * would make a link, and leaves the other organisation alone.
 */
const REVOKE = join('scripts', 'revoke-all.mjs');

describe('sessions:revoke-all (M2-ISS-12)', () => {
  jest.setTimeout(180_000);

  let owner: Client;
  let e2e: E2eApp;
  let actors: Actors;
  const env = () => ({ STAGE: 'prod', MIGRATION_DATABASE_URL: e2eDatabase.ownerUrl });

  beforeAll(async () => {
    owner = await connectAsOwner();
    await new Factories(owner).reset();
    e2e = await startE2eApp();
    actors = await createActors(e2e, owner);
  });

  afterAll(async () => {
    await e2e.close();
    await new Factories(owner).reset();
    await owner.end();
  });

  it('refuses without --yes, and does nothing', async () => {
    const result = await runNode([REVOKE, '--organisation', actors.a.organisation.id], {
      env: env(),
    });
    expect(result.exitCode).toBe(2);
    expect((await as(e2e, actors.sessions.adminA, 'get', '/api/v1/session')).status).toBe(200);
  });

  it('ends every session and unused link of the organisation, and only of it', async () => {
    const token = await mintLink(e2e, {
      organisationId: actors.a.organisation.id,
      purpose: 'password_reset',
      userId: actors.a.reviewer.id,
      recipient: actors.a.reviewer.email,
    });
    expect((await e2e.admin(linkPath('password_reset', token))).status).toBe(200);
    const result = await runNode([REVOKE, '--yes', '--organisation', actors.a.organisation.id], {
      env: env(),
    });
    expect({ code: result.exitCode, out: result.stdout }).toEqual({
      code: 0,
      out: expect.stringMatching(/ended \d+ sessions, 1 secure links/) as unknown,
    });
    expect((await as(e2e, actors.sessions.adminA, 'get', '/api/v1/session')).status).toBe(401);
    expect((await as(e2e, actors.sessions.reviewerA, 'get', '/api/v1/session')).status).toBe(401);
    expect((await e2e.admin(linkPath('password_reset', token))).status).toBe(404);
    expect((await as(e2e, actors.sessions.adminB, 'get', '/api/v1/session')).status).toBe(200);
    const audit = await inOrganisation<{ action: string }>(
      owner,
      actors.a.organisation.id,
      "SELECT action FROM audit_entries WHERE action = 'instance.global_revoke'",
    );
    expect(audit).toHaveLength(1);
  });
});
