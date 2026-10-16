import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * E2-16 (ADR-19: the OpenAPI document is the contract the web application is generated from;
 * FR-USR-04): `DELETE /api/v1/users/{id}` refuses a request without `?version=` (400
 * `validation_failed`, `RemoveUserQueryDto`), and the document does not say so: the class is
 * declared in the controller file, and the swagger plugin reads only `*.dto.ts` files. The
 * drift check compares the document with itself, so it cannot see it. The web application,
 * generated from the document, sends no version, and its button "Remove" never succeeds.
 */
interface Parameter {
  readonly name: string;
  readonly in: string;
  readonly required?: boolean;
}
interface Operation {
  readonly parameters?: readonly Parameter[];
}

const document = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', '..', 'openapi', 'openapi.json'), 'utf8'),
) as { paths: Record<string, Record<string, Operation>> };

describe('the contract of the routes that need a version in the query (E2-16)', () => {
  it.each([
    ['DELETE /api/v1/users/{id}', '/api/v1/users/{id}'],
    ['DELETE /api/v1/mail-servers/{id}', '/api/v1/mail-servers/{id}'],
  ])('%s names `version` as a required query parameter', (_name, path) => {
    const parameters = document.paths[path]?.delete?.parameters ?? [];
    expect(parameters).toContainEqual(
      expect.objectContaining({ name: 'version', in: 'query', required: true }),
    );
  });
});
