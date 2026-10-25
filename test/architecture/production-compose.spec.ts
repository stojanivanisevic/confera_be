import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECRET_VARIABLE_NAMES } from '../../src/config/config.schema';
import { repoRoot } from '../support/run-node';

/**
 * deploy/compose.yml, the production topology (M4-BE-07; ADR-26), read without Docker so that
 * every `pnpm check` holds it: secrets per service, two networks, one image for API and worker,
 * hardening on every service, images by digest. ST-53 itself, on the running containers, is
 * deploy/checks/topology.mjs; this test keeps the file from drifting between two such runs.
 *
 * The compose file writes every list of a service in flow style (`secrets: [a, b]`); the test
 * insists on that, so that this small reader cannot miss an entry.
 */

const text = readFileSync(join(repoRoot, 'deploy', 'compose.yml'), 'utf8');
const lines = text.split(/\r?\n/);

/** The lines of each service under `services:`, by name. */
function services(): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let inServices = false;
  let current: string | undefined;
  for (const line of lines) {
    // Comments explain; only what Compose reads counts.
    if (/^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) {
      inServices = line.startsWith('services:');
      current = undefined;
      continue;
    }
    if (!inServices) continue;
    const service = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (service?.[1] !== undefined) {
      current = service[1];
      result.set(current, []);
    } else if (current !== undefined) {
      result.get(current)?.push(line);
    }
  }
  return result;
}

const all = services();

function list(service: string, key: string): string[] {
  const body = all.get(service) ?? [];
  const line = body.find((entry) => new RegExp(`^ {4}${key}:`).test(entry));
  if (line === undefined) return [];
  const flow = /^ {4}[a-z_]+:\s*\[(.*)\]\s*$/.exec(line);
  if (flow?.[1] === undefined) throw new Error(`${service}.${key} is not a flow list`);
  return flow[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
}

function value(service: string, key: string): string | undefined {
  const line = (all.get(service) ?? []).find((entry) => new RegExp(`^ {4}${key}:`).test(entry));
  return line?.replace(new RegExp(`^ {4}${key}:\\s*`), '').trim();
}

const API_SECRETS = SECRET_VARIABLE_NAMES.map((name) => name.toLowerCase()).sort();

describe('deploy/compose.yml, the production topology (M4-BE-07)', () => {
  it('has the services of ADR-26 and the two one-shot jobs', () => {
    expect([...all.keys()].sort()).toEqual(
      ['api', 'clamav', 'migrate', 'postgres', 'provision', 'proxy', 'web', 'worker'].sort(),
    );
  });

  it('gives each service only its own secret files (ADR-26)', () => {
    expect(list('api', 'secrets').sort()).toEqual(API_SECRETS);
    expect(list('worker', 'secrets').sort()).toEqual(API_SECRETS);
    expect(list('migrate', 'secrets')).toEqual(['migration_database_url']);
    expect(list('postgres', 'secrets')).toEqual(['postgres_password']);
    expect(list('provision', 'secrets').sort()).toEqual(
      [
        ...API_SECRETS.filter((name) => name !== 'data_key'),
        'migration_database_url',
        'postgres_password',
      ].sort(),
    );
    for (const service of ['web', 'proxy', 'clamav']) {
      expect(list(service, 'secrets')).toEqual([]);
    }
  });

  it('gives the web container no database address and no key, in any form', () => {
    const web = (all.get('web') ?? []).join('\n');
    expect(web).not.toMatch(/DATABASE|DATA_KEY|PASSWORD|SECRET|secrets|postgres/i);
  });

  it('puts the web container on the edge network only: it cannot reach Postgres (ADR-26)', () => {
    expect(list('proxy', 'networks')).toEqual(['edge']);
    expect(list('web', 'networks')).toEqual(['edge']);
    expect(list('api', 'networks')).toEqual(['edge', 'backend']);
    for (const service of ['worker', 'postgres', 'clamav', 'migrate', 'provision']) {
      expect(list(service, 'networks')).toEqual(['backend']);
    }
  });

  it('runs the API and the worker from one image', () => {
    expect(value('api', 'image')).toMatch(/^\$\{CONFERA_API_IMAGE:\?/);
    expect(value('worker', 'image')).toBe(value('api', 'image'));
  });

  it('lets only the worker run the outbox and the jobs', () => {
    const api = (all.get('api') ?? []).join('\n');
    expect(api).toContain("MAIL_WORKER_INTERVAL_SECONDS: '0'");
    expect(api).toContain("JOBS_INTERVAL_SECONDS: '0'");
    expect((all.get('worker') ?? []).join('\n')).not.toContain('INTERVAL_SECONDS');
  });

  it('pins every other image by digest; the Confera images come from images.env', () => {
    for (const service of all.keys()) {
      const image = value(service, 'image') ?? '';
      expect(
        /@sha256:[0-9a-f]{64}$/.test(image) ||
          /^\$\{CONFERA_(API|JOBS|WEB)_IMAGE:\?[^}]+\}$/.test(image),
      ).toBe(true);
    }
  });

  it('hardens every service: the shared block, read-only, no capability, no new privileges', () => {
    expect(text).toMatch(
      /x-hardened: &hardened\n {2}read_only: true\n {2}cap_drop: \[ALL\]\n {2}security_opt: \['no-new-privileges:true'\]/,
    );
    for (const [service, body] of all) {
      expect([service, body[0]]).toEqual([service, '    <<: *hardened']);
      expect([service, body.some((line) => /^ {4}mem_limit: /.test(line))]).toEqual([
        service,
        true,
      ]);
      expect([service, body.some((line) => /^ {4}cpus: /.test(line))]).toEqual([service, true]);
      expect([service, body.some((line) => /^ {4}pids_limit: /.test(line))]).toEqual([
        service,
        true,
      ]);
      expect([
        service,
        body.some((line) => /read_only: false|privileged|docker\.sock/.test(line)),
      ]).toEqual([service, false]);
    }
  });

  it('runs every service as a user of its own, never as root', () => {
    // web, api, worker and the jobs: the USER of their image (node, uid 1000); the others here.
    expect(value('proxy', 'user')).toBe("'10002:10002'");
    expect(value('postgres', 'user')).toBe("'999:999'");
    expect(value('clamav', 'user')).toBe("'100:101'");
    expect(text).not.toMatch(/user: ['"]?(root|0)\b/);
  });

  it('adds no capability, except the one the proxy binary names (held by no process)', () => {
    for (const service of all.keys()) {
      expect([service, list(service, 'cap_add')]).toEqual([
        service,
        service === 'proxy' ? ['NET_BIND_SERVICE'] : [],
      ]);
    }
  });

  it("publishes no port but the proxy's 80 and 443", () => {
    for (const [service, body] of all) {
      const publishes = body.some((line) => /^ {4}ports:/.test(line));
      expect([service, publishes]).toEqual([service, service === 'proxy']);
    }
    expect(text).toContain("- '${CONFERA_HTTP_PORT:-80}:8080'");
    expect(text).toContain("- '${CONFERA_HTTPS_PORT:-443}:8443'");
  });

  it('scans with the real ClamAV, never with the fake clamd of the development stack', () => {
    expect(value('clamav', 'image')).toMatch(/^clamav\/clamav:[0-9.]+@sha256:[0-9a-f]{64}$/);
    expect(text).toMatch(/^ {2}CLAMAV_ADDRESS: clamav:3310$/m);
    expect([...all.keys()]).not.toContain('fake-clamd');
    for (const [service, body] of all) {
      expect([service, body.some((line) => /fake-clamd|fake_clamd|FAKE_CLAMD/.test(line))]).toEqual(
        [service, false],
      );
    }
  });

  it('mounts the file volume into the API and the worker only', () => {
    for (const [service, body] of all) {
      const mounts = body.some((line) => line.includes('files:/var/lib/confera/files'));
      expect([service, mounts]).toEqual([service, service === 'api' || service === 'worker']);
    }
  });
});
