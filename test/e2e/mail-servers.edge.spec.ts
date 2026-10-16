import type { Client } from 'pg';
import {
  type Actors,
  as,
  confirmPassword,
  createActors,
  type SignedIn,
  signIn,
} from './support/actors';
import { type E2eApp, startE2eApp } from './support/e2e-app';
import { connectAsOwner } from './support/e2e-database';
import { Factories } from './support/factories';

/**
 * E2-09 (ADR-11, FR-SMTP-02: "servers belong to the organisation, with default and fallback
 * marks"; the README: "one may be the default and one the fallback"): marking a server
 * takes the mark from the others, in the same transaction, and nothing in the database
 * keeps it to one. Two admins (or one admin in two tabs) who mark a server at the same
 * moment leave two defaults; `chooseServers` then takes whichever was made first and the
 * screen shows two.
 */
describe('one default and one fallback mail server', () => {
  jest.setTimeout(240_000);

  let owner: Client;
  let e2e: E2eApp;
  let actors: Actors;
  let admin: SignedIn;

  beforeAll(async () => {
    owner = await connectAsOwner();
    await new Factories(owner).reset();
    e2e = await startE2eApp();
    actors = await createActors(e2e, owner);
    admin = await signIn(e2e, actors.a.admin);
    await confirmPassword(e2e, admin);
  });

  afterAll(async () => {
    await e2e.close();
    await owner.end();
  });

  const create = (name: string, marks: { isDefault?: boolean; isFallback?: boolean }) =>
    as(e2e, admin, 'post', '/api/v1/mail-servers').send({
      name,
      host: 'smtp.a.example.test',
      port: 587,
      tlsMode: 'starttls',
      fromAddress: 'office@a.example.test',
      fromName: 'Ured',
      ...marks,
    });

  it('four servers created as the default at the same moment leave one default', async () => {
    await Promise.all(['R1', 'R2', 'R3', 'R4'].map((name) => create(name, { isDefault: true })));
    const list = (await as(e2e, admin, 'get', '/api/v1/mail-servers')).body as {
      items: { name: string; isDefault: boolean }[];
    };
    expect(list.items.filter((server) => server.isDefault)).toHaveLength(1);
  });

  it('four servers created as the fallback at the same moment leave one fallback', async () => {
    await Promise.all(['F1', 'F2', 'F3', 'F4'].map((name) => create(name, { isFallback: true })));
    const list = (await as(e2e, admin, 'get', '/api/v1/mail-servers')).body as {
      items: { name: string; isFallback: boolean }[];
    };
    expect(list.items.filter((server) => server.isFallback)).toHaveLength(1);
  });
});
