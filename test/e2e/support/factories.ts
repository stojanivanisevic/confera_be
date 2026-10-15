import { randomBytes, randomUUID } from 'node:crypto';
import { hash } from '@node-rs/argon2';
import type { Client } from 'pg';
import { HASH_OPTIONS } from '../../../src/modules/access/password-hasher';

/**
 * Factories for the end-to-end tests: invented organisations and invented people
 * (NFR-PRIV-05). No real person, no real address: every email is on `example.test`,
 * a name that can never receive mail, and `assertInvented` refuses anything else.
 *
 * Rows are written as the owner role inside the organisation they belong to
 * (`app.org_id` set for the transaction), so the write check of row-level security
 * applies to fixtures too: a factory cannot put a row into the wrong organisation.
 */

export const INVENTED_DOMAIN = 'example.test';

/**
 * Every tenant table, children first. `Factories.reset` empties them; a test of the
 * harness fails when a migration adds a table that is missing here.
 */
export const TENANT_TABLES = [
  'audit_entries',
  'mail_log',
  'mail_outbox',
  'mail_templates',
  'conferences',
  'mail_servers',
  'secure_links',
  'known_devices',
  'sessions',
  'user_roles',
  'users',
  'organisations',
] as const;

/** Tables of the instance (no organisation): emptied by `reset` too, so a run starts from nothing. */
export const INSTANCE_TABLES = ['security_events'] as const;

/** The password of every invented person who has one (it meets the four rules; none of its words is a name). */
export const INVENTED_PASSWORD = 'invented-Jasen-Kula-Reka-42';

export type Role = 'admin' | 'reviewer';

export interface InventedOrganisation {
  readonly id: string;
  readonly name: string;
}

export interface InventedUser {
  readonly id: string;
  readonly organisationId: string;
  readonly email: string;
  readonly displayName: string;
  readonly role: Role;
  /** invited (no password), active (INVENTED_PASSWORD), deactivated or removed. */
  readonly status: 'invited' | 'active' | 'deactivated' | 'removed';
}

/** Given names and family names with š č ć ž đ, as the real ones will have. */
const GIVEN_NAMES = ['Živana', 'Časlav', 'Đorđe', 'Šana', 'Ćirilo', 'Nađa', 'Željko', 'Mila'];
const FAMILY_NAMES = ['Đorđević', 'Šćepanović', 'Žikić', 'Čolić', 'Ćosić', 'Petrović', 'Nježić'];
const ORGANISATION_NAMES = ['Udruženje ekonomista', 'Društvo istraživača', 'Savez đačkih zadruga'];

const ASCII: Readonly<Record<string, string>> = {
  š: 's',
  č: 'c',
  ć: 'c',
  ž: 'z',
  đ: 'dj',
};

let sequence = 0;

function next(): number {
  sequence += 1;
  return sequence;
}

function pick<T>(values: readonly T[], index: number): T {
  return values[index % values.length] as T;
}

/** Lower case, without diacritics, safe as the local part of an address or a host label. */
export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[šđčćž]/g, (letter) => ASCII[letter] ?? letter)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Throws unless the address is on the invented domain. */
export function assertInvented(email: string): void {
  const domain = email.slice(email.lastIndexOf('@') + 1).toLowerCase();
  if (domain !== INVENTED_DOMAIN && !domain.endsWith(`.${INVENTED_DOMAIN}`)) {
    throw new Error(
      `A test person must live on ${INVENTED_DOMAIN}; this address does not (NFR-PRIV-05).`,
    );
  }
}

/** An organisation that exists only in memory. Its name says "(izmišljeno)": invented. */
export function buildOrganisation(
  overrides: Partial<InventedOrganisation> = {},
): InventedOrganisation {
  const number = next();
  return {
    id: randomUUID(),
    name: `${pick(ORGANISATION_NAMES, number)} ${String(number)} (izmišljeno)`,
    ...overrides,
  };
}

/** A person that exists only in memory, in the given organisation. */
export function buildUser(
  organisation: InventedOrganisation,
  overrides: Partial<Omit<InventedUser, 'organisationId'>> = {},
): InventedUser {
  const number = next();
  const displayName =
    overrides.displayName ?? `${pick(GIVEN_NAMES, number)} ${pick(FAMILY_NAMES, number * 3)}`;
  // The random part keeps addresses unique across test files that share the database.
  const unique = `${String(number)}-${randomBytes(3).toString('hex')}`;
  const user: InventedUser = {
    id: randomUUID(),
    email: `${slug(displayName).replaceAll('-', '.')}.${unique}@${slug(organisation.name).slice(0, 40)}.${INVENTED_DOMAIN}`,
    role: 'reviewer',
    status: 'active',
    ...overrides,
    displayName,
    organisationId: organisation.id,
  };
  assertInvented(user.email);
  return user;
}

async function inOrganisation<T>(
  owner: Client,
  organisationId: string,
  work: () => Promise<T>,
): Promise<T> {
  await owner.query('BEGIN');
  try {
    await owner.query("SELECT set_config('app.org_id', $1, true)", [organisationId]);
    const result = await work();
    await owner.query('COMMIT');
    return result;
  } catch (error) {
    await owner.query('ROLLBACK');
    throw error;
  }
}

/** Writes invented organisations and people into the database, as the owner role. */
export class Factories {
  constructor(private readonly owner: Client) {}

  async organisation(overrides: Partial<InventedOrganisation> = {}): Promise<InventedOrganisation> {
    const organisation = buildOrganisation(overrides);
    await inOrganisation(this.owner, organisation.id, () =>
      this.owner.query('INSERT INTO organisations (id, name) VALUES ($1, $2)', [
        organisation.id,
        organisation.name,
      ]),
    );
    return organisation;
  }

  async user(
    organisation: InventedOrganisation,
    overrides: Partial<Omit<InventedUser, 'organisationId'>> = {},
  ): Promise<InventedUser> {
    const user = buildUser(organisation, overrides);
    // An active person has INVENTED_PASSWORD, hashed as the application hashes it.
    const passwordHash = user.status === 'invited' ? null : await inventedPasswordHash();
    await inOrganisation(this.owner, organisation.id, async () => {
      await this.owner.query(
        'INSERT INTO users (id, organisation_id, email, display_name, status, password_hash) VALUES ($1, $2, $3, $4, $5, $6)',
        [user.id, user.organisationId, user.email, user.displayName, user.status, passwordHash],
      );
      await this.owner.query(
        'INSERT INTO user_roles (organisation_id, user_id, role) VALUES ($1, $2, $3)',
        [user.organisationId, user.id, user.role],
      );
    });
    return user;
  }

  /** An organisation with one admin and `reviewers` reviewers. */
  async organisationWithPeople(
    reviewers = 2,
  ): Promise<{ organisation: InventedOrganisation; users: InventedUser[] }> {
    const organisation = await this.organisation();
    const users = [await this.user(organisation, { role: 'admin' })];
    for (let index = 0; index < reviewers; index += 1) {
      users.push(await this.user(organisation));
    }
    return { organisation, users };
  }

  /** Empties every tenant table and the instance tables. The schema and the roles stay. */
  async reset(): Promise<void> {
    const tables = [...TENANT_TABLES, ...INSTANCE_TABLES].map((table) => `"${table}"`).join(', ');
    await this.owner.query(`TRUNCATE ${tables} CASCADE`);
  }
}

let hashed: Promise<string> | undefined;

/** The argon2id hash of INVENTED_PASSWORD, made once per process with the application's parameters. */
export function inventedPasswordHash(): Promise<string> {
  hashed ??= hash(INVENTED_PASSWORD, HASH_OPTIONS);
  return hashed;
}
