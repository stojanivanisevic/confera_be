import { CONDITIONS, LANGUAGES, PLACEHOLDERS, TEMPLATE_TYPES } from '../../templates/placeholders';
import {
  ALT_LIMIT,
  DOCUMENT_LIMIT_BYTES,
  MARKS,
  MAX_DEPTH,
  MAX_IMAGES,
  SUBJECT_LIMIT,
} from '../../templates/document';
import { MULTILINE_PLACEHOLDERS } from '../../templates/placeholders';
import { RENDERED_LIMIT_BYTES } from '../../templates/render';
import { REFUSED_VECTORS, RENDERED_VECTORS } from './template-vectors';

/**
 * The template document format as a contract (ADR-12): the schema in words, the catalogue
 * per type, and the vectors both repositories run. Written by `pnpm openapi:generate` as
 * contracts/template-vectors.json, held current by `pnpm openapi:check`.
 */
export const TEMPLATE_VECTORS_FILE = 'template-vectors.json';

export function templateVectorsDocument(): Record<string, unknown> {
  return {
    $comment:
      'Generated from src/modules/templates and src/modules/dev-tools/contracts/template-vectors.ts by `pnpm openapi:generate`; do not edit. The template document format (ADR-12): what the server refuses and what it renders. The editor of the web application must refuse the same documents (with the same code) and render the same HTML and text.',
    version: 1,
    nodes: {
      doc: { children: 'block[]' },
      paragraph: { children: 'inline[]' },
      heading: { level: [1, 2, 3], children: 'inline[]' },
      bulletList: { items: 'listItem[]' },
      numberedList: { items: 'listItem[]' },
      listItem: { children: 'inline[]' },
      conditional: { key: 'a condition of the type', children: 'block[]' },
      text: { text: 'string without control characters', marks: MARKS },
      hardBreak: {},
      link: { href: 'https: or mailto: address, or { placeholder: "link" }', children: 'text[]' },
      placeholder: {
        key: 'a placeholder of the type; a multi-line one keeps its line breaks as <br>',
      },
      image: {
        fileId: 'the id of an email image of the organisation (a UUID); never an address',
        alt: 'string without control characters or line breaks',
      },
      subject: { children: '(text | placeholder)[]; one line' },
    },
    limits: {
      documentBytes: DOCUMENT_LIMIT_BYTES,
      depth: MAX_DEPTH,
      subjectCharacters: SUBJECT_LIMIT,
      images: MAX_IMAGES,
      altCharacters: ALT_LIMIT,
      renderedBodyBytes: RENDERED_LIMIT_BYTES,
    },
    multilinePlaceholders: [...MULTILINE_PLACEHOLDERS],
    types: Object.fromEntries(
      TEMPLATE_TYPES.map((type) => [
        type,
        { placeholders: PLACEHOLDERS[type], conditions: CONDITIONS[type] },
      ]),
    ),
    languages: LANGUAGES,
    refused: REFUSED_VECTORS,
    rendered: RENDERED_VECTORS,
  };
}
