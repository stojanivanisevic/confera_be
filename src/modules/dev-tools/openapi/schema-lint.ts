/**
 * The schema lint over an OpenAPI document (ADR-19, finding SEC-A-28, test ST-29):
 * no response has a property named like a password, secret, token, hash or key.
 *
 * It walks every response of every operation, follows `$ref`, arrays, `allOf`, `anyOf`,
 * `oneOf` and `additionalProperties`, and reports each property whose name contains one
 * of the words. A response must never be able to carry such a value, so there is no way
 * to switch the lint off for a single field: a legitimate name goes on the reviewed list
 * below, with the reason, in a change that a reviewer sees.
 */

export const SECRET_LIKE_NAME = /password|passwd|secret|token|hash|key/i;

/** Reviewed exceptions: property names that match the pattern and are not secrets. */
export const REVIEWED_RESPONSE_PROPERTIES: ReadonlySet<string> = new Set<string>([]);

export interface SchemaLintFinding {
  /** For example `GET /api/v1/users/{id}`. */
  readonly operation: string;
  /** HTTP status or `default`. */
  readonly response: string;
  /** Path of the property inside the response, for example `items[].passwordHash`. */
  readonly property: string;
}

type JsonObject = Record<string, unknown>;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'];

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function resolve(
  document: JsonObject,
  schema: unknown,
): { schema: JsonObject; ref?: string } | undefined {
  if (!isObject(schema)) {
    return undefined;
  }
  if (typeof schema.$ref !== 'string') {
    return { schema };
  }
  const name = /^#\/components\/schemas\/(.+)$/.exec(schema.$ref)?.[1];
  const components = isObject(document.components) ? document.components : {};
  const schemas = isObject(components.schemas) ? components.schemas : {};
  const target = name === undefined ? undefined : schemas[name];
  return isObject(target) ? { schema: target, ref: schema.$ref } : undefined;
}

function secretLikeProperties(
  document: JsonObject,
  schema: unknown,
  path: string,
  visiting: Set<string>,
  found: string[],
): void {
  const resolved = resolve(document, schema);
  if (resolved === undefined) {
    return;
  }
  if (resolved.ref !== undefined) {
    if (visiting.has(resolved.ref)) {
      return;
    }
    visiting.add(resolved.ref);
  }
  const node = resolved.schema;

  if (isObject(node.properties)) {
    for (const [name, child] of Object.entries(node.properties)) {
      const childPath = path === '' ? name : `${path}.${name}`;
      if (SECRET_LIKE_NAME.test(name) && !REVIEWED_RESPONSE_PROPERTIES.has(name)) {
        found.push(childPath);
      }
      secretLikeProperties(document, child, childPath, visiting, found);
    }
  }
  secretLikeProperties(document, node.items, `${path}[]`, visiting, found);
  secretLikeProperties(document, node.additionalProperties, `${path}{}`, visiting, found);
  secretLikeProperties(document, node.not, path, visiting, found);
  for (const keyword of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    const parts = node[keyword];
    if (Array.isArray(parts)) {
      for (const part of parts) {
        secretLikeProperties(document, part, path, visiting, found);
      }
    }
  }

  if (resolved.ref !== undefined) {
    visiting.delete(resolved.ref);
  }
}

export function lintResponseSchemas(document: unknown): SchemaLintFinding[] {
  const findings: SchemaLintFinding[] = [];
  if (!isObject(document) || !isObject(document.paths)) {
    return findings;
  }
  for (const [path, item] of Object.entries(document.paths)) {
    if (!isObject(item)) {
      continue;
    }
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!isObject(operation) || !isObject(operation.responses)) {
        continue;
      }
      for (const [status, response] of Object.entries(operation.responses)) {
        const content = isObject(response) && isObject(response.content) ? response.content : {};
        for (const media of Object.values(content)) {
          const properties: string[] = [];
          secretLikeProperties(
            document,
            isObject(media) ? media.schema : undefined,
            '',
            new Set(),
            properties,
          );
          for (const property of new Set(properties)) {
            findings.push({
              operation: `${method.toUpperCase()} ${path}`,
              response: status,
              property,
            });
          }
        }
        const headers = isObject(response) && isObject(response.headers) ? response.headers : {};
        for (const name of Object.keys(headers)) {
          if (SECRET_LIKE_NAME.test(name)) {
            findings.push({
              operation: `${method.toUpperCase()} ${path}`,
              response: status,
              property: `header ${name}`,
            });
          }
        }
      }
    }
  }
  return findings;
}

export function formatFindings(file: string, findings: readonly SchemaLintFinding[]): string {
  return findings
    .map(
      ({ operation, response, property }) =>
        `  ${file}: ${operation} -> ${response}: property "${property}" is named like a secret`,
    )
    .join('\n');
}
