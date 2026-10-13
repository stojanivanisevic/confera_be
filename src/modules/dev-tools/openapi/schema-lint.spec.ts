import { lintResponseSchemas, SECRET_LIKE_NAME } from './schema-lint';

/** ST-29: no response has a property named like password, secret, token, hash or key. */

type Schema = Record<string, unknown>;

function documentWith(response: Schema, schemas: Record<string, Schema> = {}, status = '200') {
  return {
    openapi: '3.0.0',
    info: { title: 'sample', version: '0.0.0' },
    paths: {
      '/api/v1/users/{id}': {
        get: {
          operationId: 'getUser',
          responses: {
            [status]: { description: '', content: { 'application/json': { schema: response } } },
          },
        },
      },
    },
    components: { schemas },
  };
}

function properties(...names: string[]): Schema {
  return {
    type: 'object',
    properties: Object.fromEntries(names.map((n) => [n, { type: 'string' }])),
  };
}

describe('OpenAPI schema lint (ST-29)', () => {
  it('passes a response without secret-like names', () => {
    expect(
      lintResponseSchemas(documentWith(properties('id', 'email', 'displayName', 'traceId'))),
    ).toEqual([]);
  });

  it.each([
    'password',
    'passwordHash',
    'password_hash',
    'newPassword',
    'secret',
    'clientSecret',
    'token',
    'resetToken',
    'csrfToken',
    'tokenHash',
    'hash',
    'sha256Hash',
    'key',
    'apiKey',
    'dataKey',
    'publicKey',
    'KEY_ID',
    'Passwd',
  ])('refuses a property named %s', (name) => {
    expect(SECRET_LIKE_NAME.test(name)).toBe(true);
    expect(lintResponseSchemas(documentWith(properties('id', name)))).toEqual([
      { operation: 'GET /api/v1/users/{id}', response: '200', property: name },
    ]);
  });

  it('follows a reference', () => {
    const findings = lintResponseSchemas(
      documentWith(
        { $ref: '#/components/schemas/User' },
        { User: properties('id', 'passwordHash') },
      ),
    );
    expect(findings.map((f) => f.property)).toEqual(['passwordHash']);
  });

  it('follows nested objects, arrays and references of references', () => {
    const findings = lintResponseSchemas(
      documentWith(
        {
          type: 'object',
          properties: {
            items: { type: 'array', items: { $ref: '#/components/schemas/User' } },
            page: { type: 'object', properties: { nextToken: { type: 'string' } } },
          },
        },
        {
          User: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              session: { $ref: '#/components/schemas/Session' },
            },
          },
          Session: properties('id', 'tokenHash'),
        },
      ),
    );
    expect(findings.map((f) => f.property).sort()).toEqual([
      'items[].session.tokenHash',
      'page.nextToken',
    ]);
  });

  it.each(['allOf', 'anyOf', 'oneOf'])('follows %s', (keyword) => {
    const findings = lintResponseSchemas(
      documentWith(
        { [keyword]: [properties('id'), { $ref: '#/components/schemas/Secret' }] },
        { Secret: properties('apiKey') },
      ),
    );
    expect(findings.map((f) => f.property)).toEqual(['apiKey']);
  });

  it('follows additionalProperties', () => {
    const findings = lintResponseSchemas(
      documentWith({ type: 'object', additionalProperties: properties('secret') }),
    );
    expect(findings.map((f) => f.property)).toEqual(['{}.secret']);
  });

  it('checks error responses and the default response too', () => {
    for (const status of ['400', '500', 'default']) {
      expect(lintResponseSchemas(documentWith(properties('token'), {}, status))).toEqual([
        { operation: 'GET /api/v1/users/{id}', response: status, property: 'token' },
      ]);
    }
  });

  it('checks every media type and every method', () => {
    const document = {
      paths: {
        '/a': {
          post: {
            responses: {
              '201': {
                content: {
                  'application/json': { schema: properties('id') },
                  'application/problem+json': { schema: properties('secretReason') },
                },
              },
            },
          },
          delete: {
            responses: {
              '200': { content: { 'application/json': { schema: properties('hash') } } },
            },
          },
        },
      },
    };
    expect(
      lintResponseSchemas(document)
        .map((f) => `${f.operation} ${f.property}`)
        .sort(),
    ).toEqual(['DELETE /a hash', 'POST /a secretReason']);
  });

  it('checks response headers', () => {
    const document = {
      paths: { '/a': { get: { responses: { '200': { headers: { 'X-Session-Token': {} } } } } } },
    };
    expect(lintResponseSchemas(document).map((f) => f.property)).toEqual([
      'header X-Session-Token',
    ]);
  });

  it('survives a schema that refers to itself', () => {
    const findings = lintResponseSchemas(
      documentWith(
        { $ref: '#/components/schemas/Node' },
        {
          Node: {
            type: 'object',
            properties: {
              children: { type: 'array', items: { $ref: '#/components/schemas/Node' } },
              secret: {},
            },
          },
        },
      ),
    );
    expect(findings.map((f) => f.property)).toEqual(['secret']);
  });

  it('does not look at request bodies: a sign-in request may carry a password', () => {
    const document = {
      paths: {
        '/api/v1/auth/sign-in': {
          post: {
            requestBody: {
              content: { 'application/json': { schema: properties('email', 'password') } },
            },
            parameters: [{ name: 'token', in: 'path' }],
            responses: { '204': { description: '' } },
          },
        },
      },
    };
    expect(lintResponseSchemas(document)).toEqual([]);
  });

  it('accepts an empty or malformed document without throwing', () => {
    expect(lintResponseSchemas({})).toEqual([]);
    expect(lintResponseSchemas(null)).toEqual([]);
    expect(lintResponseSchemas({ paths: { '/a': null } })).toEqual([]);
  });
});
