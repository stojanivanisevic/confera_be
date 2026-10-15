import type { Client } from 'pg';
import { SecuritySummary } from '../../src/modules/audit/security-summary';
import { type Actors, as, createActors } from './support/actors';
import { ADMIN_HOST, type E2eApp, startE2eApp } from './support/e2e-app';
import { connectAsOwner, rows } from './support/e2e-database';
import { Factories } from './support/factories';

/**
 * The audit log through the API, and the summary of failed sign-ins for unknown addresses
 * (M2-BE-06; FR-AUD-01 to 03, SA-18; ST-24). What the database refuses to the run-time
 * roles is in test/integration/audit.spec.ts.
 */
describe('the audit log', () => {
  jest.setTimeout(180_000);

  let owner: Client;
  let e2e: E2eApp;
  let actors: Actors;

  beforeAll(async () => {
    owner = await connectAsOwner();
    await new Factories(owner).reset();
    e2e = await startE2eApp();
    actors = await createActors(e2e, owner);
  });

  afterAll(async () => {
    await e2e.close();
    await owner.end();
  });

  it('an admin reads and filters it; a reviewer may not', async () => {
    const page = await as(e2e, actors.sessions.adminA, 'get', '/api/v1/audit?pageSize=50');
    expect(page.status).toBe(200);
    const items = (
      page.body as {
        items: { action: string; actor: { id: string } | null; subjectId: string | null }[];
      }
    ).items;
    expect(items.map(({ action }) => action)).toEqual(
      expect.arrayContaining(['session.signed_in', 'session.signed_out_everywhere']),
    );
    const mine = await as(
      e2e,
      actors.sessions.adminA,
      'get',
      `/api/v1/audit?action=session.signed_in&actorUserId=${actors.a.admin.id}`,
    );
    const filtered = (mine.body as { items: { action: string; actor: { id: string } | null }[] })
      .items;
    expect(filtered.length).toBeGreaterThanOrEqual(1);
    expect(
      filtered.every(
        (item) => item.action === 'session.signed_in' && item.actor?.id === actors.a.admin.id,
      ),
    ).toBe(true);
    expect(
      (await as(e2e, actors.sessions.adminA, 'get', '/api/v1/audit?action=not.an.action')).status,
    ).toBe(400);
    expect((await as(e2e, actors.sessions.reviewerA, 'get', '/api/v1/audit')).status).toBe(403);
  });

  it('holds no password, token or cookie value (FR-AUD-03)', async () => {
    const page = await as(e2e, actors.sessions.adminA, 'get', '/api/v1/audit?pageSize=100');
    const text = JSON.stringify(page.body);
    expect(text).not.toContain('invented-');
    for (const session of Object.values(actors.sessions)) {
      expect(text).not.toContain(session.cookie.split('=')[1] ?? 'never');
      expect(text).not.toContain(session.csrf);
    }
    const everything = await rows<{ value: string }>(
      owner,
      `SELECT string_agg(changes::text || detail::text, ' ') AS value FROM audit_entries`,
    );
    expect(everything[0]?.value ?? '').not.toMatch(/invented-|@/);
  });

  it('a flood of failed sign-ins for unknown addresses adds ONE summed entry to each organisation (ST-24, SA-18)', async () => {
    for (let index = 0; index < 12; index += 1) {
      await e2e
        .http()
        .post('/api/v1/session')
        .set('Host', ADMIN_HOST)
        .set('Origin', e2e.config.origins.admin)
        .set('X-Forwarded-For', `198.51.100.${String(100 + index)}`)
        .send({
          email: `unknown.${String(index)}@nowhere.example.test`,
          password: 'invented-wrong-one-123',
        });
    }
    const summary = e2e.app.get(SecuritySummary);
    expect(await summary.run()).toBe(12);
    expect(await summary.run()).toBe(0);
    for (const signedIn of [actors.sessions.adminA, actors.sessions.adminB]) {
      const page = await as(
        e2e,
        signedIn,
        'get',
        '/api/v1/audit?action=security.unknown_address_sign_ins',
      );
      const items = (
        page.body as { items: { actor: unknown; detail: { count: number }; subjectType: string }[] }
      ).items;
      expect(items).toHaveLength(1);
      expect(items[0]).toEqual(
        expect.objectContaining({
          actor: null,
          subjectType: 'instance',
          detail: expect.objectContaining({ count: 12 }),
        }),
      );
    }
    const summarised = await rows<{ n: string }>(
      owner,
      'SELECT count(*)::text AS n FROM security_events WHERE user_id IS NULL AND summarised_at IS NOT NULL',
    );
    expect(Number(summarised[0]?.n)).toBeGreaterThanOrEqual(12);
  });

  it('every entry carries the trace id of its request', async () => {
    const response = await as(e2e, actors.sessions.adminA, 'delete', '/api/v1/session');
    expect(response.status).toBe(204);
    const [entry] = await rows<{ trace_id: string }>(
      owner,
      `SELECT trace_id FROM audit_entries WHERE action = 'session.signed_out' AND actor_user_id = $1`,
      [actors.a.admin.id],
    ).then(async (found) =>
      found.length > 0
        ? found
        : rows<{ trace_id: string }>(owner, 'SELECT NULL::text AS trace_id WHERE false'),
    );
    // The owner is bound by row-level security outside an organisation: read inside it.
    await owner.query('BEGIN');
    try {
      await owner.query("SELECT set_config('app.org_id', $1, true)", [actors.a.organisation.id]);
      const [inside] = await rows<{ trace_id: string }>(
        owner,
        `SELECT trace_id FROM audit_entries WHERE action = 'session.signed_out' AND actor_user_id = $1`,
        [actors.a.admin.id],
      );
      expect(inside?.trace_id).toBe(response.headers['x-trace-id']);
    } finally {
      await owner.query('COMMIT');
    }
    expect(entry).toBeUndefined();
  });
});
