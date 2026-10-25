// The production topology on this machine (M4-BE-07, M3-ISS-06): ST-02, ST-04 and ST-53 on the real
// images and the real compose file, before any server exists.
//
//   node deploy/checks/topology.mjs [--web-image <image>] [--no-build] [--without-clamav] [--keep]
//   node deploy/checks/topology.mjs --images-only [--no-build]      ST-02 and ST-04 without starting
//
// It builds the runtime and jobs images of this repository (unless --no-build), takes the web image
// of confera_fe (default confera-m4-infra-web:check, built from ../confera_fe when it is missing),
// and starts deploy/compose.yml as a staging instance under the project name confera-m4-infra, with
// host names under .localhost (Caddy's own local CA), random secrets in files under .artifacts/, and
// free ports instead of 80 and 443. Then it proves:
//
//   ST-02  the runtime image holds no dev-tools code, no source, no test, no development dependency
//          and no package manager; the jobs image holds no source, no build and no test tool;
//   ST-04  the resolved compose configuration and its environment hold no development key;
//   ST-53  every container runs as a non-root user, read-only, without capabilities, without new
//          privileges, with memory, CPU and process limits, no Docker socket, and no published port
//          but the proxy's;
//   and    two networks: the web container cannot reach Postgres or ClamAV, by name or by address;
//          secrets per service: the web container and the proxy have none, no secret is in any
//          container's configuration; the API and the worker run the same image;
//   M3-ISS-06  the proxy sends /public/v1 straight to the API: a 20 MB upload reaches the API, a
//          body above 51 MB and a large body on another route are refused by the proxy; /api/v1 is
//          answered by the API on the admin host only; the staging gate asks for its password.
//
// Everything it creates is named confera-m4-infra* and removed at the end (unless --keep).
// Log: .artifacts/deploy-checks/topology.log. Needs Docker and about 3 GB of memory (1 GB without ClamAV).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import {
  CHECK_PREFIX,
  artifactsDir,
  createLog,
  createResults,
  docker,
  dockerOk,
  repoRoot,
  run,
} from './lib.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const PROJECT = CHECK_PREFIX;
const API_IMAGE = `${CHECK_PREFIX}-api:check`;
const JOBS_IMAGE = `${CHECK_PREFIX}-jobs:check`;
const WEB_IMAGE = option('--web-image', `${CHECK_PREFIX}-web:check`);
const ADMIN_HOST = 'admin.confera-check.localhost';
const PUBLIC_HOST = 'forms.confera-check.localhost';
const DEVELOPMENT_KEY_PREFIX = ['DEV', ''].join('_');
const withClamav = !flag('--without-clamav');
// The images and the resolved configuration only, without starting anything (the pipeline: it
// has no web image of the other repository).
const imagesOnly = flag('--images-only');

const log = createLog('topology');
const results = createResults(log);
const { check } = results;
const work = path.join(artifactsDir, 'topology');

function freePort() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const secret = (bytes = 24) => randomBytes(bytes).toString('base64url');

function databaseAddress(role, password) {
  const url = new URL('postgresql://postgres:5432/confera');
  url.username = role;
  url.password = password;
  return url.href;
}

// ---- The server's files, as an operator would write them -------------------------------------
async function prepare() {
  rmSync(work, { recursive: true, force: true });
  for (const dir of ['config', 'secrets', 'proxy-data'])
    mkdirSync(path.join(work, dir), { recursive: true });
  const ports = { http: await freePort(), https: await freePort() };
  const origin = (host) => `https://${host}:${String(ports.https)}`;

  const roles = { owner: secret(), app: secret(), system: secret() };
  const files = {
    postgres_password: secret(),
    migration_database_url: databaseAddress('confera_owner', roles.owner),
    database_url: databaseAddress('confera_app', roles.app),
    system_database_url: databaseAddress('confera_system', roles.system),
    data_key: secret(32),
  };
  for (const [name, value] of Object.entries(files))
    writeFileSync(path.join(work, 'secrets', name), `${value}\n`);

  const gateUser = 'gate';
  const gateWord = secret(18);
  // bcrypt cost 10: the gate checks the password on every request, on the proxy's one CPU.
  const hash = dockerOk([
    'run',
    '--rm',
    '--network',
    'none',
    proxyImage(),
    'caddy',
    'hash-password',
    '--bcrypt-cost',
    '10',
    '--plaintext',
    gateWord,
  ]).trim();
  // For a look by hand after --keep; the folder is removed otherwise, and .artifacts/ is never in git.
  writeFileSync(path.join(work, 'gate-word'), `${gateWord}\n`);

  const lines = (entries) => `${entries.map(([name, value]) => `${name}=${value}`).join('\n')}\n`;
  writeFileSync(
    path.join(work, 'compose.env'),
    lines([
      ['CONFERA_INSTANCE', 'staging'],
      ['CONFERA_ADMIN_HOST', ADMIN_HOST],
      ['CONFERA_PUBLIC_HOST', PUBLIC_HOST],
      ['CONFERA_CONFIG_DIR', path.join(work, 'config')],
      ['CONFERA_SECRETS_DIR', path.join(work, 'secrets')],
      ['CONFERA_PROXY_DATA_DIR', path.join(work, 'proxy-data')],
      ['CONFERA_HTTP_PORT', String(ports.http)],
      ['CONFERA_HTTPS_PORT', String(ports.https)],
    ]),
  );
  writeFileSync(
    path.join(work, 'images.env'),
    lines([
      ['CONFERA_API_IMAGE', API_IMAGE],
      ['CONFERA_JOBS_IMAGE', JOBS_IMAGE],
      ['CONFERA_WEB_IMAGE', WEB_IMAGE],
    ]),
  );
  const template = (name) => readFileSync(path.join(repoRoot, 'deploy', name), 'utf8');
  writeFileSync(
    path.join(work, 'config', 'api.env'),
    template('api.env.example')
      .replace(/^ADMIN_ORIGIN=$/m, `ADMIN_ORIGIN=${origin(ADMIN_HOST)}`)
      .replace(/^PUBLIC_ORIGIN=$/m, `PUBLIC_ORIGIN=${origin(PUBLIC_HOST)}`),
  );
  writeFileSync(
    path.join(work, 'config', 'web.env'),
    template('web.env.example')
      .replace(/^CONFERA_ADMIN_ORIGIN=$/m, `CONFERA_ADMIN_ORIGIN=${origin(ADMIN_HOST)}`)
      .replace(/^CONFERA_PUBLIC_ORIGIN=$/m, `CONFERA_PUBLIC_ORIGIN=${origin(PUBLIC_HOST)}`),
  );
  writeFileSync(
    path.join(work, 'config', 'proxy.env'),
    template('proxy.env.example')
      .replace(/^CONFERA_ACME_EMAIL=$/m, 'CONFERA_ACME_EMAIL=ops@example.org')
      .replace(/^CONFERA_GATE_USER=$/m, `CONFERA_GATE_USER=${gateUser}`)
      .replace(/^CONFERA_GATE_PASSWORD_HASH=$/m, `CONFERA_GATE_PASSWORD_HASH='${hash}'`),
  );
  return {
    ports,
    gate: `Basic ${Buffer.from(`${gateUser}:${gateWord}`).toString('base64')}`,
    files,
  };
}

function proxyImage() {
  const compose = readFileSync(path.join(repoRoot, 'deploy', 'compose.yml'), 'utf8');
  return /^\s+image: (caddy:\S+)$/m.exec(compose)?.[1] ?? 'caddy-image-not-found';
}

const composeArgs = () => [
  'compose',
  '--project-name',
  PROJECT,
  '--env-file',
  path.join(work, 'compose.env'),
  '--env-file',
  path.join(work, 'images.env'),
  '--file',
  path.join(repoRoot, 'deploy', 'compose.yml'),
];
const compose = (more, options) => docker([...composeArgs(), ...more], options);

// ---- HTTP through the proxy -------------------------------------------------------------------
function call(ports, { host, pathname, method = 'GET', headers = {}, body, plain = false }) {
  return new Promise((resolve) => {
    const send = plain ? httpRequest : httpsRequest;
    const req = send(
      {
        host: '127.0.0.1',
        port: plain ? ports.http : ports.https,
        servername: plain ? undefined : host,
        rejectUnauthorized: false,
        path: pathname,
        method,
        headers: { host: plain ? host : `${host}:${String(ports.https)}`, ...headers },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
        res.on('error', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
      },
    );
    req.on('error', (error) => resolve({ status: 0, headers: {}, error: String(error) }));
    req.setTimeout(60_000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * POSTs `bytes` random bytes (as a multipart file when `asFile`) to https://proxy:8443 from a client
 * container on the edge network, under the given host name, through the gate. Returns the status
 * and whether the API answered (it alone sets X-Trace-Id).
 */
function bodyThroughProxy(gate, host, pathname, bytes, asFile) {
  const script = `
const https = require('node:https'), crypto = require('node:crypto');
const bytes = Number(process.env.BYTES), boundary = 'confera-check-' + crypto.randomBytes(6).toString('hex');
const head = Buffer.from(process.env.AS_FILE === '1' ? '--' + boundary + '\\r\\nContent-Disposition: form-data; name="file"; filename="paper.pdf"\\r\\nContent-Type: application/pdf\\r\\n\\r\\n' : '');
const tail = Buffer.from(process.env.AS_FILE === '1' ? '\\r\\n--' + boundary + '--\\r\\n' : '');
const done = (result) => { process.stdout.write(JSON.stringify(result)); process.exit(0); };
const req = https.request({ host: 'proxy', port: 8443, servername: process.env.HOST_NAME, rejectUnauthorized: false, path: process.env.PATH_NAME, method: 'POST',
  headers: { host: process.env.HOST_NAME, authorization: process.env.GATE, 'content-length': String(head.length + bytes + tail.length),
    'content-type': process.env.AS_FILE === '1' ? 'multipart/form-data; boundary=' + boundary : 'application/json' } },
  (res) => { res.resume(); done({ status: res.statusCode, trace: res.headers['x-trace-id'] !== undefined }); });
req.on('error', (error) => done({ status: 0, error: error.code }));
setTimeout(() => done({ status: 0, error: 'timeout' }), 90000);
const chunk = crypto.randomBytes(1 << 20); let sent = 0;
req.write(head);
(function pump() { while (sent < bytes) { const n = Math.min(chunk.length, bytes - sent); sent += n; if (!req.write(chunk.subarray(0, n))) return req.once('drain', pump); } req.end(tail); })();
`;
  const result = docker([
    'run',
    '--rm',
    '--network',
    `${PROJECT}_edge`,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--user',
    '1000:1000',
    '--env',
    `HOST_NAME=${host}`,
    '--env',
    `PATH_NAME=${pathname}`,
    '--env',
    `BYTES=${String(bytes)}`,
    '--env',
    `AS_FILE=${asFile ? '1' : '0'}`,
    '--env',
    `GATE=${gate}`,
    WEB_IMAGE,
    'node',
    '-e',
    script,
  ]);
  try {
    return JSON.parse(result.stdout);
  } catch {
    return { status: 0, error: result.stderr.slice(-300) };
  }
}

// ---- The checks -------------------------------------------------------------------------------
function inspect(name) {
  return JSON.parse(dockerOk(['inspect', name]))[0];
}

function imageFiles(image) {
  const out = docker([
    'run',
    '--rm',
    '--network',
    'none',
    '--entrypoint',
    'sh',
    image,
    '-c',
    'find / -xdev \\( -path /proc -o -path /sys \\) -prune -o -print 2>/dev/null',
  ]);
  return out.stdout.split('\n').filter(Boolean);
}

function checkImages() {
  const runtime = imageFiles(API_IMAGE);
  const app = runtime.filter((file) => file.startsWith('/app/'));
  const absent = (what, pattern, files = app, image = 'runtime') => {
    const found = files.filter((file) => pattern.test(file));
    check(
      `ST-02: the ${image} image holds no ${what}`,
      found.length === 0,
      found.slice(0, 5).join(', '),
    );
  };
  check('ST-02: the runtime image holds the production build', app.includes('/app/dist/main.js'));
  absent('dev-tools module', /dev-tools|main\.dev/);
  absent('development build', /^\/app\/dist-dev/);
  absent('source', /^\/app\/(src|test)\//);
  absent('script of the repository', /^\/app\/scripts\//);
  absent('environment file', /\/\.env(\.|$)/);
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const development = Object.keys(manifest.devDependencies ?? {});
  const present = development.filter((name) => app.includes(`/app/node_modules/${name}`));
  check(
    'ST-02: the runtime image holds no development dependency',
    present.length === 0,
    present.join(', '),
  );
  absent('package manager', /\/bin\/(npm|npx|corepack|pnpm|yarn)$/, runtime);

  const routes = readFileSync(
    path.join(repoRoot, 'src', 'modules', 'dev-tools', 'dev-tools.routes.ts'),
    'utf8',
  );
  const texts = [...routes.matchAll(/:\s*'(dev\/[^']+)'/g)].map((match) => match[1]);
  check('ST-02: the dev-tools routes are known to the check', texts.length > 0);
  for (const text of [
    ...texts,
    'dev-tools',
    'DevTools',
    'DevInfo',
    'SwaggerModule',
    'swagger-ui',
  ]) {
    const grep = docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--entrypoint',
      'grep',
      API_IMAGE,
      '-rlF',
      text,
      '/app/dist',
    ]);
    check(
      `ST-02: no file of the image's dist/ contains "${text}"`,
      grep.code === 1,
      grep.stdout.trim(),
    );
  }

  const jobs = imageFiles(JOBS_IMAGE).filter((file) => file.startsWith('/app/'));
  absent('source, build or test', /^\/app\/(src|dist|dist-dev|test)\//, jobs, 'jobs');
  absent(
    'test tool (seed:e2e, stubs)',
    /^\/app\/scripts\/(seed-e2e|stubs|dev)\.mjs$/,
    jobs,
    'jobs',
  );
  check(
    'the jobs image holds the migrations and the Prisma command line',
    jobs.includes('/app/prisma/migrations/migration_lock.toml') &&
      jobs.includes('/app/node_modules/.bin/prisma'),
  );
}

function checkComposeConfig() {
  const config = compose([
    '--profile',
    'jobs',
    '--profile',
    'provision',
    'config',
    '--format',
    'json',
  ]);
  check('the compose file resolves with the templates filled in', config.code === 0, config.stderr);
  const text = config.stdout;
  check(
    `ST-04: the resolved configuration holds no ${DEVELOPMENT_KEY_PREFIX} key`,
    !text.includes(DEVELOPMENT_KEY_PREFIX),
  );
  const parsed = JSON.parse(text);
  const services = parsed.services;
  const expectedSecrets = {
    proxy: [],
    web: [],
    api: ['data_key', 'database_url', 'system_database_url'],
    worker: ['data_key', 'database_url', 'system_database_url'],
    postgres: ['postgres_password'],
    clamav: [],
    migrate: ['migration_database_url'],
    provision: [
      'database_url',
      'migration_database_url',
      'postgres_password',
      'system_database_url',
    ],
  };
  check(
    'the topology has exactly its services',
    Object.keys(services).sort().join() === Object.keys(expectedSecrets).sort().join(),
    Object.keys(services).join(),
  );
  for (const [name, expected] of Object.entries(expectedSecrets)) {
    const actual = (services[name]?.secrets ?? []).map((entry) => entry.source).sort();
    check(
      `secrets per service: ${name} is given ${expected.length === 0 ? 'no secret' : expected.join(', ')}`,
      actual.join() === expected.join(),
      actual.join(),
    );
  }
  const expectedNetworks = {
    proxy: ['edge'],
    web: ['edge'],
    api: ['backend', 'edge'],
    worker: ['backend'],
    postgres: ['backend'],
    clamav: ['backend'],
    migrate: ['backend'],
    provision: ['backend'],
  };
  for (const [name, expected] of Object.entries(expectedNetworks)) {
    const actual = Object.keys(services[name]?.networks ?? {}).sort();
    check(
      `two networks: ${name} is on ${expected.join(' and ')}`,
      actual.join() === expected.join(),
      actual.join(),
    );
  }
  for (const [name, service] of Object.entries(services)) {
    const problems = [];
    if (service.read_only !== true) problems.push('not read-only');
    if (!(service.cap_drop ?? []).includes('ALL')) problems.push('capabilities not dropped');
    // The proxy keeps NET_BIND_SERVICE in its bounding set only (see deploy/compose.yml); the runtime
    // check below proves that no process of any container holds a capability.
    const added = (service.cap_add ?? []).filter(
      (cap) => !(name === 'proxy' && cap === 'NET_BIND_SERVICE'),
    );
    if (added.length > 0) problems.push(`adds ${added.join(',')}`);
    if (!(service.security_opt ?? []).some((opt) => /no-new-privileges(:true)?$/.test(opt)))
      problems.push('new privileges allowed');
    if (service.privileged) problems.push('privileged');
    if (!service.mem_limit) problems.push('no memory limit');
    if (!service.cpus) problems.push('no CPU limit');
    if (!service.pids_limit) problems.push('no process limit');
    if ((service.volumes ?? []).some((volume) => String(volume.source).includes('docker.sock')))
      problems.push('mounts the Docker socket');
    if (name !== 'proxy' && (service.ports ?? []).length > 0) problems.push('publishes a port');
    if (
      ['proxy', 'web'].includes(name) &&
      (service.volumes ?? []).some(
        (volume) =>
          volume.source === 'files' || String(volume.target).includes('/var/lib/confera/files'),
      )
    )
      problems.push('mounts the file volume');
    if (service.network_mode === 'host') problems.push('host network');
    check(`ST-53 (configuration): ${name} is hardened`, problems.length === 0, problems.join('; '));
  }
  const published = (services.proxy?.ports ?? []).map((port) => Number(port.target)).sort();
  check(
    'only the proxy publishes ports, 8080 and 8443 inside (80 and 443 on a server)',
    published.join() === '8080,8443',
    published.join(),
  );
  check(
    'the API and the worker use the same image',
    services.api?.image === services.worker?.image && services.api?.image === API_IMAGE,
  );
  // The fake clamd of the development stack (scripts/fake-clamd.mjs) finds everything clean.
  check(
    'the antivirus is the real ClamAV: the clamav image, at clamav:3310 for the API and the worker',
    /^clamav\/clamav:[0-9.]+@sha256:[0-9a-f]{64}$/.test(String(services.clamav?.image)) &&
      services.api?.environment?.CLAMAV_ADDRESS === 'clamav:3310' &&
      services.worker?.environment?.CLAMAV_ADDRESS === 'clamav:3310',
    `${String(services.clamav?.image)} ${String(services.worker?.environment?.CLAMAV_ADDRESS)}`,
  );
  check(
    'no service is the fake clamd of the development stack',
    !/fake-clamd|FAKE_CLAMD/i.test(text),
  );
}

function containerOf(service) {
  return dockerOk([...composeArgs(), 'ps', '--all', '--quiet', service])
    .trim()
    .split('\n')[0];
}

function checkContainers(running) {
  for (const service of running) {
    const id = containerOf(service);
    const info = inspect(id);
    const problems = [];
    const user = info.Config.User;
    if (!user || /^(root|0)(:|$)/.test(user)) problems.push(`user "${user}"`);
    const uid = docker(['exec', id, 'id', '-u']).stdout.trim();
    if (uid === '' || uid === '0') problems.push(`process uid ${uid}`);
    if (!info.HostConfig.ReadonlyRootfs) problems.push('root file system writable');
    if (!(info.HostConfig.CapDrop ?? []).includes('ALL')) problems.push('capabilities kept');
    const added = (info.HostConfig.CapAdd ?? []).filter(
      (cap) => !(service === 'proxy' && /NET_BIND_SERVICE$/.test(cap)),
    );
    if (added.length > 0) problems.push('capabilities added');
    // Every process of the container: no permitted and no effective capability.
    const held = docker([
      'exec',
      id,
      'sh',
      '-c',
      'grep -h -E "^Cap(Prm|Eff):" /proc/[0-9]*/status | sort -u',
    ])
      .stdout.trim()
      .split('\n');
    if (held.length === 0 || held.some((line) => !/:\s+0+$/.test(line)))
      problems.push(`a process holds a capability: ${held.join(' ')}`);
    if (!(info.HostConfig.SecurityOpt ?? []).some((opt) => opt.startsWith('no-new-privileges')))
      problems.push('new privileges');
    if (info.HostConfig.Privileged) problems.push('privileged');
    if (!(info.HostConfig.Memory > 0)) problems.push('no memory limit');
    if (!(info.HostConfig.NanoCpus > 0)) problems.push('no CPU limit');
    if (!(info.HostConfig.PidsLimit > 0)) problems.push('no process limit');
    if (info.Mounts.some((mount) => String(mount.Source).includes('docker.sock')))
      problems.push('Docker socket');
    const bound = Object.values(info.HostConfig.PortBindings ?? {})
      .flat()
      .filter(Boolean);
    if (service !== 'proxy' && bound.length > 0) problems.push('published port');
    const probe = docker([
      'exec',
      id,
      'sh',
      '-c',
      'touch /confera-probe 2>/dev/null || touch /etc/confera-probe 2>/dev/null',
    ]);
    if (probe.code === 0) problems.push('wrote into the root file system');
    check(
      `ST-53: ${service} runs non-root (uid ${uid}), read-only, without capabilities or new privileges, with limits`,
      problems.length === 0,
      problems.join('; '),
    );

    const env = (info.Config.Env ?? []).map((entry) => entry.split('=')[0]);
    const secretLike = env.filter((name) => /DATABASE|PASSWORD$|SECRET|TOKEN|_KEY$/.test(name));
    check(
      `no secret in the configuration of ${service} (docker inspect)`,
      secretLike.length === 0,
      secretLike.join(', '),
    );
    check(
      `no ${DEVELOPMENT_KEY_PREFIX} key in the environment of ${service}`,
      !env.some((name) => name.startsWith(DEVELOPMENT_KEY_PREFIX)),
    );
  }

  const web = containerOf('web');
  const webMounts = inspect(web).Mounts.map((mount) => mount.Destination);
  check(
    'the web container has no secret file and no file volume',
    !webMounts.some(
      (target) => target.startsWith('/run/secrets') || target.includes('/var/lib/confera'),
    ),
    webMounts.join(', '),
  );
  const proxyMounts = inspect(containerOf('proxy')).Mounts.map((mount) => mount.Destination);
  check(
    'the proxy has no secret file and no file volume',
    !proxyMounts.some(
      (target) => target.startsWith('/run/secrets') || target.includes('/var/lib/confera'),
    ),
    proxyMounts.join(', '),
  );
  check(
    'the API and the worker run the same image',
    inspect(containerOf('api')).Image === inspect(containerOf('worker')).Image,
  );

  // Reachability, from inside the containers.
  const reach = (container, host, port) =>
    docker([
      'exec',
      container,
      'node',
      '-e',
      `const s=require('net').connect({host:'${host}',port:${String(port)},timeout:3000});s.on('connect',()=>process.exit(0));s.on('timeout',()=>process.exit(3));s.on('error',(e)=>{console.log(e.code);process.exit(2)})`,
    ]);
  const postgresId = containerOf('postgres');
  const backendAddress = Object.entries(inspect(postgresId).NetworkSettings.Networks).find(
    ([name]) => name.endsWith('_backend'),
  )?.[1]?.IPAddress;
  check(
    'control: the API reaches Postgres',
    reach(containerOf('api'), 'postgres', 5432).code === 0,
  );
  check('the web container cannot reach Postgres by name', reach(web, 'postgres', 5432).code !== 0);
  check(
    `the web container cannot reach Postgres by address (${String(backendAddress)})`,
    backendAddress !== undefined && reach(web, backendAddress, 5432).code !== 0,
  );
  if (running.includes('clamav')) {
    check(
      'control: the worker reaches ClamAV',
      reach(containerOf('worker'), 'clamav', 3310).code === 0,
    );
    check('the web container cannot reach ClamAV', reach(web, 'clamav', 3310).code !== 0);
    // clamd's VERSION, asked by the worker: the real daemon names its signature database; the
    // fake clamd of the development stack names itself, and is refused here.
    const version = docker([
      'exec',
      containerOf('worker'),
      'node',
      '-e',
      "const s=require('net').connect({host:'clamav',port:3310,timeout:5000});let a='';s.on('connect',()=>s.write('zVERSION\\0'));s.on('data',(d)=>a+=d);s.on('end',()=>{console.log(a.replace(/\\0/g,''));process.exit(0)});s.on('timeout',()=>process.exit(3));s.on('error',()=>process.exit(2))",
    ]);
    const answer = version.stdout.trim();
    check(
      'the worker scans with the real ClamAV, not the fake clamd of the development stack',
      version.code === 0 && /^ClamAV \d+\.\d+\.\d+\/\d+\//.test(answer) && !/fake/i.test(answer),
      answer,
    );
  }
  check('the web container cannot reach the worker', reach(web, 'worker', 3001).code !== 0);
  const webEnv = docker(['exec', web, 'env']).stdout;
  check(
    'the environment of the web process holds no database address and no key',
    !/postgres(ql)?:|DATABASE|DATA_KEY|PASSWORD|SECRET/.test(webEnv),
  );
}

async function checkProxy(ports, gate) {
  const auth = { authorization: gate };
  const ungated = await call(ports, { host: ADMIN_HOST, pathname: '/sign-in' });
  check(
    'staging gate: a request without the gate password is refused (401)',
    ungated.status === 401,
    `${String(ungated.status)} ${ungated.error ?? ''}`,
  );
  const ungatedPublic = await call(ports, { host: PUBLIC_HOST, pathname: '/f/some-form' });
  check(
    'staging gate: the public form paths are closed too (401)',
    ungatedPublic.status === 401,
    String(ungatedPublic.status),
  );

  const signIn = await call(ports, { host: ADMIN_HOST, pathname: '/sign-in', headers: auth });
  check(
    'admin host: the sign-in page comes from the web application',
    signIn.status === 200 &&
      String(signIn.headers['content-security-policy']).includes("frame-ancestors 'none'"),
    `${String(signIn.status)}`,
  );
  check(
    'the proxy adds HSTS',
    String(signIn.headers['strict-transport-security']).startsWith('max-age='),
  );
  check(
    'the proxy adds no frame policy and no server name of its own',
    signIn.headers['x-frame-options'] === 'DENY' && signIn.headers.server === undefined,
    `${String(signIn.headers['x-frame-options'])} ${String(signIn.headers.server)}`,
  );
  check(
    'staging: noindex on every answer',
    String(signIn.headers['x-robots-tag']).includes('noindex'),
  );

  const meta = await call(ports, { host: ADMIN_HOST, pathname: '/api/v1/meta', headers: auth });
  check(
    'admin host: /api/v1 goes straight to the API',
    meta.headers['x-trace-id'] !== undefined,
    `${String(meta.status)} ${JSON.stringify(meta.headers)}`,
  );
  const metaOnPublic = await call(ports, {
    host: PUBLIC_HOST,
    pathname: '/api/v1/meta',
    headers: auth,
  });
  check(
    'public host: /api/v1 is not found',
    metaOnPublic.status === 404,
    String(metaOnPublic.status),
  );
  const health = await call(ports, { host: ADMIN_HOST, pathname: '/health', headers: auth });
  check(
    "the API's /health is not reachable through the proxy",
    health.headers['x-trace-id'] === undefined,
    String(health.status),
  );

  // M3-ISS-06: uploads go to the API, never through the web application (10 MB there). Large
  // bodies are sent from a client container on the edge network to the proxy's own port: on a
  // Windows machine the published port passes WSL's localhost relay, which stalls large uploads.
  const MB = 1024 * 1024;
  // The API refuses this upload (no form token) before it reads the body; the proxy then closes
  // the connection while the client still sends, and the client may see the reset instead of the
  // answer. So the API's own request log says whether the request reached it.
  const uploadsInLog = () =>
    docker(['logs', containerOf('api')])
      .stdout.split('\n')
      .filter((line) => line.includes('"route":"/public/v1/forms/:slug/uploads"')).length;
  const before = uploadsInLog();
  const upload = bodyThroughProxy(
    gate,
    PUBLIC_HOST,
    '/public/v1/forms/some-form/uploads',
    20 * MB,
    true,
  );
  const reached = upload.trace === true || uploadsInLog() > before;
  check(
    'M3-ISS-06: a 20 MB upload passes the proxy and is answered by the API (its request log)',
    upload.status !== 413 && reached,
    JSON.stringify(upload),
  );
  const beforeLarge = uploadsInLog();
  const tooLarge = bodyThroughProxy(
    gate,
    PUBLIC_HOST,
    '/public/v1/forms/some-form/uploads',
    60 * MB,
    true,
  );
  check(
    'a body above 51 MB on the upload route is refused by the proxy (413), the API never sees it',
    tooLarge.status === 413 && !tooLarge.trace && uploadsInLog() === beforeLarge,
    JSON.stringify(tooLarge),
  );
  const otherRoute = bodyThroughProxy(
    gate,
    PUBLIC_HOST,
    '/public/v1/forms/some-form/submissions',
    2 * MB,
    false,
  );
  check(
    'a 2 MB body on any other route is refused by the proxy (413)',
    otherRoute.status === 413 && !otherRoute.trace,
    JSON.stringify(otherRoute),
  );
  const toWeb = bodyThroughProxy(gate, ADMIN_HOST, '/sign-in', 2 * MB, false);
  check(
    'a 2 MB body to the web application is refused by the proxy (413)',
    toWeb.status === 413,
    JSON.stringify(toWeb),
  );

  const plain = await call(ports, { host: ADMIN_HOST, pathname: '/sign-in', plain: true });
  check(
    'plain HTTP is redirected to HTTPS (308)',
    plain.status === 308 && String(plain.headers.location).startsWith(`https://${ADMIN_HOST}`),
    `${String(plain.status)} ${String(plain.headers.location)}`,
  );
  const stranger = await call(ports, { host: 'other.confera-check.localhost', pathname: '/' });
  check(
    'another host name gets no answer',
    stranger.status === 0 || stranger.status >= 400,
    String(stranger.status),
  );
}

// Starts the topology from nothing, as on a fresh server, and checks the running containers.
async function startAndCheck(prepared) {
  compose(['down', '--volumes', '--remove-orphans']);
  log.write(compose(['up', '--detach', '--wait', '--wait-timeout', '120', 'postgres']).stderr);
  const provision = compose(['run', '--rm', '--no-TTY', 'provision']);
  log.write(provision.stdout + provision.stderr);
  check(
    'the provision job creates the roles and the database (as uid 1000, read-only)',
    provision.code === 0,
    provision.stderr.slice(-800),
  );
  const migrate = compose(['run', '--rm', '--no-TTY', 'migrate']);
  log.write(migrate.stdout + migrate.stderr);
  check(
    'the migrate job applies every migration as the owner role',
    migrate.code === 0 &&
      /successfully applied|No pending migrations/i.test(migrate.stdout + migrate.stderr),
    migrate.stderr.slice(-800),
  );

  const services = ['api', 'worker', 'web', 'proxy', ...(withClamav ? ['clamav'] : [])];
  const up = compose([
    'up',
    '--detach',
    '--no-deps',
    '--wait',
    '--wait-timeout',
    withClamav ? '420' : '180',
    ...services,
  ]);
  log.write(up.stdout + up.stderr);
  check(
    `the topology starts and every health check passes (${services.join(', ')})`,
    up.code === 0,
    up.stderr.slice(-1500),
  );
  checkContainers(['postgres', ...services]);
  await checkProxy(prepared.ports, prepared.gate);
}

// ---- Run ----------------------------------------------------------------------------------------
try {
  if (!flag('--no-build')) {
    process.stdout.write('Building the jobs and runtime images ...\n');
    log.write(dockerOk(['build', '--quiet', '--target', 'jobs', '--tag', JOBS_IMAGE, '.']));
    log.write(dockerOk(['build', '--quiet', '--target', 'runtime', '--tag', API_IMAGE, '.']));
  }
  if (!imagesOnly && docker(['image', 'inspect', WEB_IMAGE]).code !== 0) {
    const fe = path.resolve(repoRoot, '..', 'confera_fe');
    if (!existsSync(path.join(fe, 'Dockerfile')))
      throw new Error(`no web image ${WEB_IMAGE} and no ../confera_fe/Dockerfile to build it`);
    process.stdout.write(`Building ${WEB_IMAGE} from ${fe} ...\n`);
    log.write(dockerOk(['build', '--quiet', '--tag', WEB_IMAGE, '.'], { cwd: fe }));
  }
  checkImages();
  const prepared = await prepare();
  checkComposeConfig();

  if (!imagesOnly) await startAndCheck(prepared);
} catch (error) {
  check('the check ran to its end', false, String(error?.stack ?? error));
} finally {
  if (work && existsSync(path.join(work, 'compose.env'))) {
    log.write(compose(['logs', '--no-color', '--timestamps']).stdout);
    if (!flag('--keep'))
      compose([
        '--profile',
        'jobs',
        '--profile',
        'provision',
        'down',
        '--volumes',
        '--remove-orphans',
      ]);
  }
  if (!flag('--keep')) {
    rmSync(work, { recursive: true, force: true });
    run('docker', ['image', 'rm', API_IMAGE, JOBS_IMAGE]);
  }
}

process.stdout.write(
  `\n${String(results.count - results.failed)} passed, ${String(results.failed)} failed; log ${log.file}\n`,
);
process.exit(results.failed === 0 ? 0 : 1);
