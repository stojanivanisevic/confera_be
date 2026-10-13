import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { PROBLEM_CONTENT_TYPE } from '../../../common/http/problem';
import { FieldErrorDto, ProblemDto } from '../../../common/http/problem.dto';
import { SURFACE_PREFIX } from '../../../common/http/surface';
import { APP_VERSION } from '../../../common/version';

/**
 * Builds the two OpenAPI documents of Confera from the running code (ADR-19):
 * the admin API (`/api/v1`) and the public API (`/public/v1`).
 *
 * The documents are a contract: `openapi/openapi.json` and `openapi/openapi.public.json`
 * are committed, the frontend vendors a copy, and `pnpm openapi:check` fails when the
 * code and the committed files differ.
 */
export interface ConferaDocuments {
  readonly admin: OpenAPIObject;
  readonly public: OpenAPIObject;
}

type JsonObject = Record<string, unknown>;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

const PROBLEM_REF = '#/components/schemas/Problem';

const PROBLEM_RESPONSE = {
  description:
    'Any error, in the one error format of the API (RFC 9457 problem details). An unexpected error carries `code` and `traceId` only.',
  content: { [PROBLEM_CONTENT_TYPE]: { schema: { $ref: PROBLEM_REF } } },
};

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sortedByKey<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** Every `#/components/schemas/<name>` that `value` refers to, at any depth. */
function referencedSchemas(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      referencedSchemas(item, found);
    }
  } else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      if (key === '$ref' && typeof item === 'string') {
        const name = /^#\/components\/schemas\/(.+)$/.exec(item)?.[1];
        if (name !== undefined) {
          found.add(name);
        }
      } else {
        referencedSchemas(item, found);
      }
    }
  }
  return found;
}

function operationsOf(paths: JsonObject): JsonObject[] {
  return Object.values(paths).flatMap((item) =>
    isObject(item) ? HTTP_METHODS.map((method) => item[method]).filter(isObject) : [],
  );
}

function slice(
  full: OpenAPIObject,
  prefix: string,
  title: string,
  description: string,
): OpenAPIObject {
  const paths = sortedByKey(
    Object.fromEntries(
      Object.entries(full.paths).filter(([path]) => path.startsWith(`/${prefix}/`)),
    ),
  ) as JsonObject;

  // Every operation documents the error format, so that generated clients know its type.
  for (const operation of operationsOf(paths)) {
    const responses = isObject(operation.responses) ? operation.responses : {};
    operation.responses = { ...responses, default: responses.default ?? PROBLEM_RESPONSE };
  }

  // Keep only the schemas this document uses, directly or through another schema.
  const all = (full.components?.schemas ?? {}) as JsonObject;
  const used = referencedSchemas(paths);
  for (let before = -1; before !== used.size;) {
    before = used.size;
    for (const name of [...used]) {
      referencedSchemas(all[name], used);
    }
  }
  const schemas = sortedByKey(
    Object.fromEntries(Object.entries(all).filter(([name]) => used.has(name))),
  );

  return {
    openapi: full.openapi,
    info: { title, description, version: APP_VERSION },
    paths: paths as OpenAPIObject['paths'],
    components: { schemas: schemas as NonNullable<OpenAPIObject['components']>['schemas'] },
  };
}

function assertUniqueOperationIds(document: OpenAPIObject): void {
  const seen = new Set<string>();
  for (const operation of operationsOf(document.paths)) {
    const id = operation.operationId;
    if (typeof id !== 'string' || id === '') {
      throw new Error('An operation has no operationId.');
    }
    if (seen.has(id)) {
      throw new Error(
        `operationId "${id}" is used twice. Operation ids are the method names of the controllers and must be unique in a document.`,
      );
    }
    seen.add(id);
  }
}

export function buildDocuments(app: INestApplication): ConferaDocuments {
  const full = SwaggerModule.createDocument(
    app,
    new DocumentBuilder().setTitle('Confera').setVersion(APP_VERSION).build(),
    {
      // Stable operation ids: the method name of the controller, without the class name.
      operationIdFactory: (_controllerKey: string, methodKey: string) => methodKey,
      extraModels: [ProblemDto, FieldErrorDto],
    },
  );

  const documents: ConferaDocuments = {
    admin: slice(
      full,
      SURFACE_PREFIX.admin,
      'Confera admin API',
      'The API of the admin surface. It answers only under the admin host name.',
    ),
    public: slice(
      full,
      SURFACE_PREFIX.public,
      'Confera public API',
      'The API of the public surface (forms, secure links). It answers only under the public host name and only ever gains things.',
    ),
  };
  assertUniqueOperationIds(documents.admin);
  assertUniqueOperationIds(documents.public);
  return documents;
}
