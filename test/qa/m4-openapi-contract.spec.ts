import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The API contract of 0.4.0 as the web application reads it (Test engineer, M4-QA): every
 * schema a response names describes its fields. The OpenAPI files are made by the
 * @nestjs/swagger compiler plugin, which reads the classes of files named `*.dto.ts` only; a
 * response class declared anywhere else becomes `{ type: object, properties: {} }`, which the
 * web application's generator types as `Record<string, never>` and which the drift check
 * cannot see change. That is how `MailImageDto` and `MailImageListDto` (declared in
 * mail-images.controller.ts) reach confera_fe empty, and why it types them by hand.
 */
interface Schema {
  type?: string;
  properties?: Record<string, unknown>;
  additionalProperties?: unknown;
  allOf?: unknown;
  oneOf?: unknown;
  anyOf?: unknown;
  $ref?: string;
  items?: Schema;
}

const root = join(__dirname, '..', '..', 'openapi');

function emptyObjects(file: string): string[] {
  const document = JSON.parse(readFileSync(join(root, file), 'utf8')) as {
    components: { schemas: Record<string, Schema> };
  };
  return Object.entries(document.components.schemas)
    .filter(
      ([, schema]) =>
        schema.type === 'object' &&
        Object.keys(schema.properties ?? {}).length === 0 &&
        schema.additionalProperties === undefined &&
        schema.allOf === undefined &&
        schema.oneOf === undefined &&
        schema.anyOf === undefined,
    )
    .map(([name]) => name);
}

describe('the committed OpenAPI files describe every response (M4-QA, Q4 contract gap)', () => {
  it.each(['openapi.json', 'openapi.public.json'])(
    '%s has no object schema without properties',
    (file) => {
      expect({ file, empty: emptyObjects(file) }).toEqual({ file, empty: [] });
    },
  );
});
