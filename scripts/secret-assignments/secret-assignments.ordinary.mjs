// Corpus 2 of secret-assignments.mjs: ordinary lines that must NOT be reported.
//
// Every entry is a small file, as in the other corpus: `file` says how it is read and
// `text` is its content. The scan must find nothing in any of them.
//
// What is ordinary:
//   - a name that only CONTAINS a secret word (a label, a message, a policy, a path)
//   - a type, an interface or an enum: they name kinds, they hold no value
//   - a reference to something else as the whole value, in every syntax
//   - nothing: an empty value, null, a boolean
//   - a placeholder: a literal that starts with invented- or local-only-
//   - a secret word that is a value, an argument or a text, and not a name
//
// `node secret-assignments.mjs --self-test` runs this corpus and the other one.

/** A text of several lines. */
const lines = (...parts) => `${parts.join('\n')}\n`;

export const ORDINARY = [
  // --- a name that only contains a secret word -------------------------------------------
  {
    what: 'labels and hints of a form',
    file: 'src/form.ts',
    text: lines(
      "const passwordLabel = 'Password';",
      "const labels = { passwordLabel: 'Lozinka', tokenHint: 'The token from the e-mail' };",
    ),
  },
  {
    what: 'messages and error codes about a password',
    file: 'src/errors.ts',
    text: lines(
      "const message = 'The password is too short';",
      "export const PASSWORD_TOO_SHORT = 'password_too_short';",
      "throw new Error('The token has expired');",
    ),
  },
  {
    what: 'the names of a policy and its settings',
    file: 'src/policy.ts',
    text: lines(
      "const passwordPolicy = 'strong';",
      'const PASSWORD_MIN_LENGTH = 12;',
      "const settings = { passwordMinLength: 12, tokenTtlSeconds: 3600, secretRotation: 'weekly' };",
    ),
  },
  {
    what: 'settings about a secret in an environment file',
    file: '.env.example',
    text: lines(
      'PASSWORD_MIN_LENGTH=12',
      'TOKEN_TTL_SECONDS=3600',
      'SESSION_SECRET_FILE=/run/secrets/session',
      'CREDENTIALS_PATH=./secrets/service-account.json',
    ),
  },
  {
    what: 'names that say what kind of secret, where it is or how many',
    file: 'src/kinds.ts',
    text: lines(
      "const tokenType = 'Bearer';",
      "const secretName = 'smtp-password';",
      "const row = { passwordHash: 'x', tokenExpiresAt: '2026-01-01' };",
      "const passwords = ['a', 'b'];",
      'const tokens = 3;',
      "const secretsManager = 'vault';",
    ),
  },
  // --- types hold no value --------------------------------------------------------------
  {
    what: 'a type, an interface and an enum whose names are secret words',
    file: 'src/types.ts',
    text: lines(
      "type Token = 'access' | 'refresh';",
      'interface Credentials { username: string; password: string }',
      "type Login = { password: string; token: 'none' | 'present' };",
      "enum Field { Password = 'password', Token = 'token' }",
      "export type Secret = 'smtp' | 'session'",
      "const field: Password = 'abc';",
    ),
  },
  {
    what: 'types of parameters and of casts',
    file: 'src/signatures.ts',
    text: lines(
      'function login(password: string, token?: string): void {}',
      'function check(input: { password: string } = empty): void {}',
      "const shape = value as { token: 'none' };",
      'let token: string;',
      "class Input { kind: 'password' | 'token' = 'password'; password!: string; }",
    ),
  },
  // --- a reference as the whole value -----------------------------------------------------
  {
    what: 'references in JavaScript: the environment, a call, another variable',
    file: 'src/references.ts',
    text: lines(
      'const password = process.env.SMTP_PASSWORD;',
      "const token = config.get('token');",
      "const secret = await vault.read('smtp');",
      'this.password = password;',
      'const { apiKey } = options;',
      'const clientSecret = options.clientSecret ?? defaults.clientSecret;',
      'const sessionSecret = String(input);',
    ),
  },
  {
    what: 'a text that starts with a reference, and values put together by a call',
    file: 'src/derived.ts',
    text: lines(
      'const token = `${scheme} ${value}`;',
      'const password = prefix + suffix;',
      "const apiKey = randomBytes(32).toString('hex');",
      "const secret = ['a', 'b'].join('');",
    ),
  },
  {
    what: 'references in an environment file and in a shell script',
    file: 'deploy/server.env',
    text: lines(
      'SMTP_PASSWORD=${SMTP_PASSWORD}',
      'API_TOKEN=$API_TOKEN',
      'export DB_PASSWORD="$(cat /run/secrets/db)"',
      'DB_PASSWORD=$DB_PASSWORD pg_dump --host db app',
      'SESSION_SECRET=${SESSION_SECRET:?set it on the server}',
    ),
  },
  {
    what: 'references in a compose file',
    file: 'compose.yml',
    text: lines(
      'services:',
      '  api:',
      '    environment:',
      '      - SMTP_PASSWORD',
      '      - API_TOKEN=${API_TOKEN}',
      '  worker:',
      '    environment:',
      '      SMTP_PASSWORD: ${SMTP_PASSWORD}',
      '      DB_PASSWORD: "${DB_PASSWORD:?set it}"',
    ),
  },
  {
    what: 'references in a workflow file, and a flag whose name ends with a secret word',
    file: '.github/workflows/ci.yml',
    text: lines(
      'steps:',
      '  - uses: actions/checkout@v4',
      '    with:',
      '      token: ${{ secrets.GITHUB_TOKEN }}',
      '      persist-credentials: false',
      '  - run: echo "ok"',
      '    env:',
      '      NPM_TOKEN: ${{ secrets.NPM_TOKEN }}',
    ),
  },
  {
    what: 'references of YAML: an alias, a tagged value, a template',
    file: 'deploy/values.yaml',
    text: lines(
      'defaults: &defaults',
      '  retries: 3',
      'token: *shared_token',
      'api_key: !vault smtp/api-key',
      'password: {{ .Values.smtp.password | quote }}',
      'secret:',
      '  secretName: mail',
      '  key: password',
    ),
  },
  {
    what: 'a reference on the line below its name, and what follows a name without a value',
    file: 'deploy/next-line.yml',
    text: lines(
      'token:',
      '  # the reference follows',
      '  ${{ secrets.TOKEN }}',
      'secret:',
      '  name: mail',
      'credentials:',
      '  - one',
      'password:',
      'other: value',
    ),
  },
  {
    what: 'references and paths in a Makefile, commands in a pipeline file',
    file: 'Makefile',
    text: lines(
      'PASSWORD_FILE := /run/secrets/db',
      'TOKEN ?= $(shell cat token.txt)',
      'API_KEY := $(API_KEY)',
    ),
  },
  {
    what: 'commands with a colon in a pipeline file',
    file: '.gitlab-ci.yml',
    text: lines(
      'deploy:',
      '  script:',
      '    - echo "password: see the vault"',
      '    - curl -H "Accept: text/plain" https://example.test/token',
      '    - test "$API_TOKEN" != ""',
    ),
  },
  // --- nothing --------------------------------------------------------------------------
  {
    what: 'empty values in files without types',
    file: 'deploy/api.env.example',
    text: lines(
      'SMTP_PASSWORD=',
      'API_TOKEN=""',
      "SESSION_SECRET=''",
      'DATA_KEY=   # set on the server',
    ),
  },
  {
    what: 'no value in YAML and JSON',
    file: 'config/empty.yml',
    text: lines('password:', 'credentials: null', 'secret: ~', 'token: ""', 'api_key: false'),
  },
  {
    what: 'no value in JSON, and names that only contain a secret word',
    file: 'config/app.json',
    text: lines(
      '{ "password": "", "token": null, "apiKey": "${API_KEY}", "passwordPolicy": "strong",',
      '  "credentials": { "user": "app" }, "secrets": ["a", "b"], "sendToken": true }',
    ),
  },
  {
    what: 'no value in JavaScript',
    file: 'src/empty.ts',
    text: lines(
      "const password = '';",
      'const secret = null;',
      'let token = undefined;',
      'const state = { token: null, password: undefined, credentials: false };',
      'const select = { password: true, token: false };',
      "const shown = password ? 'set' : 'missing';",
    ),
  },
  // --- placeholders -----------------------------------------------------------------------
  {
    what: 'placeholders in an environment file',
    file: '.env.example',
    text: lines(
      'SMTP_PASSWORD=invented-mail-password',
      'export API_TOKEN="local-only-token"',
      "SESSION_SECRET='invented-session-secret'",
    ),
  },
  {
    what: 'placeholders in YAML, JSON and a Dockerfile',
    file: 'compose.yaml',
    text: lines(
      'services:',
      '  db:',
      '    environment:',
      '      POSTGRES_PASSWORD: local-only-owner',
      '      - API_TOKEN=invented-token',
      '    labels: { password: "invented-x" }',
    ),
  },
  {
    what: 'placeholders in JavaScript, also a short one and one that is put together',
    file: 'test/login.spec.ts',
    text: lines(
      "const password = 'invented-correct-horse';",
      "const tooShort = { email: 'a@example.test', password: 'invented-x' };",
      'const token = `invented-${suffix}`;',
      "const secret = 'local-only-' + name;",
      "const apiKey = process.env.API_KEY ?? 'invented-api-key';",
    ),
  },
  // --- a secret word that is not a name ---------------------------------------------------
  {
    what: 'packages whose names end with a secret word, in a package.json',
    file: 'package.json',
    text: lines(
      '{',
      '  "dependencies": { "generate-password": "1.7.1", "csrf-token": "2.0.0" },',
      '  "devDependencies": { "pbkdf2-password": "1.2.1" },',
      '  "pnpm": { "overrides": { "csrf-token": "2.0.0" } }',
      '}',
    ),
  },
  {
    what: 'secret words as values, arguments and texts',
    file: 'src/fields.ts',
    text: lines(
      "const type = 'password';",
      "const field = { name: 'password', type: 'password', label: 'Password' };",
      "const REDACTED = ['password', 'secret', 'token', 'authorization'];",
      'const pattern = /password=(.*)&token=/;',
      "url.searchParams.set('token', value);",
      "if (kind === 'token') { count = 1; }",
      'expect(response.body.password).toBeUndefined();',
    ),
  },
  {
    what: 'a schema, a class with decorators and methods named like a secret',
    file: 'src/login.dto.ts',
    text: lines(
      'const schema = z.object({ password: z.string().min(12), token: z.string() });',
      'class LoginDto {',
      '  @IsString()',
      '  password!: string;',
      '  @IsOptional()',
      '  token?: string;',
      '  secret() { return read(); }',
      '}',
      'const handleToken = (value: string) => value;',
      "const hasPassword = password !== '';",
    ),
  },
  {
    what: 'a form in JSX',
    file: 'app/login.tsx',
    text: lines(
      'export function Login() {',
      '  return (',
      '    <form>',
      '      <label htmlFor="password">Don\'t share your password</label>',
      '      <input id="password" type="password" name="password" autoComplete="current-password" />',
      '      <Field label="Token" value={token} onChange={setToken} />',
      '    </form>',
      '  );',
      '}',
    ),
  },
  {
    what: 'text of a README, a style sheet and a page',
    file: 'README.md',
    text: lines(
      '# Password rules',
      '',
      'The password = the one you chose at sign-up; `SMTP_PASSWORD=` stays empty in git.',
      '',
      '| Variable | Meaning |',
      '| `API_TOKEN` | the token of the mail provider |',
      '',
      '```',
      'node app.js --token-file ./secrets/token',
      'if [ "$PASSWORD" = "" ]; then exit 1; fi',
      '```',
    ),
  },
];
