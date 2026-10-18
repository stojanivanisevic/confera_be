/**
 * The template document format (ADR-12, M2-BE-10; ST-58, ST-22): a template is a document
 * as data, checked against this fixed schema attribute by attribute, and rendered by the
 * server to HTML and plain text. Markup posted by a browser is never stored or sent.
 *
 * NODES OF A BODY
 *   doc            { type: 'doc', children: Block[] }
 *   paragraph      { type: 'paragraph', children: Inline[] }
 *   heading        { type: 'heading', level: 1 | 2 | 3, children: Inline[] }
 *   bulletList     { type: 'bulletList', items: ListItem[] }
 *   numberedList   { type: 'numberedList', items: ListItem[] }
 *   listItem       { type: 'listItem', children: Inline[] }
 *   conditional    { type: 'conditional', key: ConditionKey, children: Block[] }
 *   text           { type: 'text', text: string, marks?: ('bold' | 'italic' | 'underline')[] }
 *   hardBreak      { type: 'hardBreak' }
 *   link           { type: 'link', href: string | { placeholder: 'link' }, children: Text[] }
 *   placeholder    { type: 'placeholder', key: PlaceholderKey }
 *   image          { type: 'image', fileId: uuid, alt: string }        (a block, M4-BE-06)
 * A SUBJECT is one line: { type: 'subject', children: (Text | Placeholder)[] }.
 * Nothing else. An image is an email image of the template's own organisation, named by its
 * file id: never an address, never data in the document (ADR-12, ST-60); the server checks
 * that the file exists when the template is saved, and sends it as an inline part.
 *
 * The keys a placeholder or a condition may use come from the catalogue of the
 * template's type (placeholders.ts). A typed link is `https:` or `mailto:` only; a link
 * to the secure link of the message is the address `{ placeholder: 'link' }` of a link
 * node and exists nowhere else. Whatever an admin types, braces included, is text.
 *
 * Limits (P): a document of 200 KB, 8 levels of nesting, a subject of 300 characters,
 * 5 images, an alternative text of 300 characters.
 */
export const DOCUMENT_LIMIT_BYTES = 200 * 1024;
export const MAX_IMAGES = 5;
export const ALT_LIMIT = 300;
export const MAX_DEPTH = 8;
export const SUBJECT_LIMIT = 300;

export type Mark = 'bold' | 'italic' | 'underline';
export const MARKS: readonly Mark[] = ['bold', 'italic', 'underline'];

export interface TextNode {
  readonly type: 'text';
  readonly text: string;
  readonly marks?: readonly Mark[];
}
export interface HardBreakNode {
  readonly type: 'hardBreak';
}
export interface PlaceholderNode {
  readonly type: 'placeholder';
  readonly key: string;
}
export interface LinkNode {
  readonly type: 'link';
  readonly href: string | { readonly placeholder: 'link' };
  readonly children: readonly TextNode[];
}
export type InlineNode = TextNode | HardBreakNode | PlaceholderNode | LinkNode;

export interface ParagraphNode {
  readonly type: 'paragraph';
  readonly children: readonly InlineNode[];
}
export interface HeadingNode {
  readonly type: 'heading';
  readonly level: 1 | 2 | 3;
  readonly children: readonly InlineNode[];
}
export interface ListItemNode {
  readonly type: 'listItem';
  readonly children: readonly InlineNode[];
}
export interface ListNode {
  readonly type: 'bulletList' | 'numberedList';
  readonly items: readonly ListItemNode[];
}
export interface ConditionalNode {
  readonly type: 'conditional';
  readonly key: string;
  readonly children: readonly BlockNode[];
}
export interface ImageNode {
  readonly type: 'image';
  readonly fileId: string;
  readonly alt: string;
}
export type BlockNode = ParagraphNode | HeadingNode | ListNode | ConditionalNode | ImageNode;

export interface DocNode {
  readonly type: 'doc';
  readonly children: readonly BlockNode[];
}
export interface SubjectNode {
  readonly type: 'subject';
  readonly children: readonly (TextNode | PlaceholderNode)[];
}

/** What a check refuses, as a code the web application can show, and where. */
export class DocumentError extends Error {
  constructor(
    readonly code: DocumentErrorCode,
    readonly path: string,
  ) {
    super(`${code} at ${path}`);
    this.name = 'DocumentError';
  }
}

export type DocumentErrorCode =
  | 'not_a_document'
  | 'too_large'
  | 'too_deep'
  | 'unknown_node'
  | 'unknown_attribute'
  | 'wrong_attribute'
  | 'unknown_placeholder'
  | 'unknown_condition'
  | 'link_scheme'
  | 'link_placeholder'
  | 'text_control_character'
  | 'subject_too_long'
  | 'too_many_images';

export interface Catalogue {
  readonly placeholders: ReadonlySet<string>;
  readonly conditions: ReadonlySet<string>;
}

const SAFE_KEY = /^[a-z][A-Za-z0-9]{0,39}$/;
const FILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// The control characters and the Unicode line separators: never in a text of a template.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u2028\u2029]/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The own attributes of a node, with none of the names a prototype has (`__proto__`, `constructor`). */
function attributes(node: Record<string, unknown>, path: string, allowed: readonly string[]): void {
  for (const name of Object.keys(node)) {
    if (!allowed.includes(name)) {
      throw new DocumentError('unknown_attribute', `${path}.${name}`);
    }
  }
}

function checkKey(
  value: unknown,
  path: string,
  known: ReadonlySet<string>,
  code: DocumentErrorCode,
): string {
  // A key is looked up by name: a name of a prototype member must never pass as one.
  if (typeof value !== 'string' || !SAFE_KEY.test(value) || !known.has(value)) {
    throw new DocumentError(code, path);
  }
  return value;
}

function checkText(node: unknown, path: string): TextNode {
  if (!isRecord(node) || node.type !== 'text') {
    throw new DocumentError('unknown_node', path);
  }
  attributes(node, path, ['type', 'text', 'marks']);
  if (typeof node.text !== 'string') {
    throw new DocumentError('wrong_attribute', `${path}.text`);
  }
  if (CONTROL.test(node.text)) {
    throw new DocumentError('text_control_character', `${path}.text`);
  }
  let marks: Mark[] | undefined;
  if (node.marks !== undefined) {
    if (!Array.isArray(node.marks) || !node.marks.every((mark) => MARKS.includes(mark as Mark))) {
      throw new DocumentError('wrong_attribute', `${path}.marks`);
    }
    marks = [...new Set(node.marks as Mark[])];
  }
  return marks === undefined
    ? { type: 'text', text: node.text }
    : { type: 'text', text: node.text, marks };
}

function checkInline(node: unknown, path: string, catalogue: Catalogue, depth: number): InlineNode {
  if (depth > MAX_DEPTH) {
    throw new DocumentError('too_deep', path);
  }
  if (!isRecord(node) || typeof node.type !== 'string') {
    throw new DocumentError('unknown_node', path);
  }
  switch (node.type) {
    case 'text':
      return checkText(node, path);
    case 'hardBreak':
      attributes(node, path, ['type']);
      return { type: 'hardBreak' };
    case 'placeholder': {
      attributes(node, path, ['type', 'key']);
      // The secure link is the address of a link node, never a text placeholder.
      const key = checkKey(node.key, `${path}.key`, catalogue.placeholders, 'unknown_placeholder');
      if (key === 'link') {
        throw new DocumentError('unknown_placeholder', `${path}.key`);
      }
      return { type: 'placeholder', key };
    }
    case 'link': {
      attributes(node, path, ['type', 'href', 'children']);
      let href: LinkNode['href'];
      if (isRecord(node.href)) {
        attributes(node.href, `${path}.href`, ['placeholder']);
        if (node.href.placeholder !== 'link' || !catalogue.placeholders.has('link')) {
          throw new DocumentError('link_placeholder', `${path}.href`);
        }
        href = { placeholder: 'link' };
      } else if (
        typeof node.href === 'string' &&
        /^(https:\/\/[^\s<>"']+|mailto:[^\s<>"']+)$/u.test(node.href) &&
        !CONTROL.test(node.href)
      ) {
        href = node.href;
      } else {
        throw new DocumentError('link_scheme', `${path}.href`);
      }
      if (!Array.isArray(node.children) || node.children.length === 0) {
        throw new DocumentError('wrong_attribute', `${path}.children`);
      }
      return {
        type: 'link',
        href,
        children: node.children.map((child, index) =>
          checkText(child, `${path}.children[${String(index)}]`),
        ),
      };
    }
    default:
      throw new DocumentError('unknown_node', path);
  }
}

function checkInlines(
  value: unknown,
  path: string,
  catalogue: Catalogue,
  depth: number,
): InlineNode[] {
  if (!Array.isArray(value)) {
    throw new DocumentError('wrong_attribute', path);
  }
  return value.map((child, index) =>
    checkInline(child, `${path}[${String(index)}]`, catalogue, depth + 1),
  );
}

function checkBlock(node: unknown, path: string, catalogue: Catalogue, depth: number): BlockNode {
  if (depth > MAX_DEPTH) {
    throw new DocumentError('too_deep', path);
  }
  if (!isRecord(node) || typeof node.type !== 'string') {
    throw new DocumentError('unknown_node', path);
  }
  switch (node.type) {
    case 'paragraph':
      attributes(node, path, ['type', 'children']);
      return {
        type: 'paragraph',
        children: checkInlines(node.children, `${path}.children`, catalogue, depth),
      };
    case 'heading': {
      attributes(node, path, ['type', 'level', 'children']);
      if (node.level !== 1 && node.level !== 2 && node.level !== 3) {
        throw new DocumentError('wrong_attribute', `${path}.level`);
      }
      return {
        type: 'heading',
        level: node.level,
        children: checkInlines(node.children, `${path}.children`, catalogue, depth),
      };
    }
    case 'bulletList':
    case 'numberedList': {
      attributes(node, path, ['type', 'items']);
      if (!Array.isArray(node.items)) {
        throw new DocumentError('wrong_attribute', `${path}.items`);
      }
      const items = node.items.map((item, index): ListItemNode => {
        const itemPath = `${path}.items[${String(index)}]`;
        if (!isRecord(item) || item.type !== 'listItem') {
          throw new DocumentError('unknown_node', itemPath);
        }
        attributes(item, itemPath, ['type', 'children']);
        return {
          type: 'listItem',
          children: checkInlines(item.children, `${itemPath}.children`, catalogue, depth + 1),
        };
      });
      return { type: node.type, items };
    }
    case 'image': {
      attributes(node, path, ['type', 'fileId', 'alt']);
      if (typeof node.fileId !== 'string' || !FILE_ID.test(node.fileId)) {
        throw new DocumentError('wrong_attribute', `${path}.fileId`);
      }
      if (typeof node.alt !== 'string' || Array.from(node.alt).length > ALT_LIMIT) {
        throw new DocumentError('wrong_attribute', `${path}.alt`);
      }
      if (CONTROL.test(node.alt) || /[\r\n\t]/.test(node.alt)) {
        throw new DocumentError('text_control_character', `${path}.alt`);
      }
      return { type: 'image', fileId: node.fileId.toLowerCase(), alt: node.alt };
    }
    case 'conditional': {
      attributes(node, path, ['type', 'key', 'children']);
      const key = checkKey(node.key, `${path}.key`, catalogue.conditions, 'unknown_condition');
      return {
        type: 'conditional',
        key,
        children: checkBlocks(node.children, `${path}.children`, catalogue, depth),
      };
    }
    default:
      throw new DocumentError('unknown_node', path);
  }
}

function checkBlocks(
  value: unknown,
  path: string,
  catalogue: Catalogue,
  depth: number,
): BlockNode[] {
  if (!Array.isArray(value)) {
    throw new DocumentError('wrong_attribute', path);
  }
  return value.map((child, index) =>
    checkBlock(child, `${path}[${String(index)}]`, catalogue, depth + 1),
  );
}

function sizeOf(value: unknown): number {
  // JSON.stringify gives undefined for undefined, whatever its type says.
  const text = JSON.stringify(value) as string | undefined;
  return Buffer.byteLength(text ?? '', 'utf8');
}

/** Checks a body against the schema and the catalogue; returns the document as data of its own. */
export function checkBody(value: unknown, catalogue: Catalogue): DocNode {
  if (typeof value === 'string' || !isRecord(value) || value.type !== 'doc') {
    throw new DocumentError('not_a_document', '$');
  }
  if (sizeOf(value) > DOCUMENT_LIMIT_BYTES) {
    throw new DocumentError('too_large', '$');
  }
  attributes(value, '$', ['type', 'children']);
  const body: DocNode = {
    type: 'doc',
    children: checkBlocks(value.children, '$.children', catalogue, 1),
  };
  if (imagesOf(body).length > MAX_IMAGES) {
    throw new DocumentError('too_many_images', '$');
  }
  return body;
}

/** The file ids of the images of a checked body, each once, in the order they appear. */
export function imagesOf(body: DocNode): string[] {
  const found: string[] = [];
  const walk = (blocks: readonly BlockNode[]): void => {
    for (const block of blocks) {
      if (block.type === 'image') {
        found.push(block.fileId);
      } else if (block.type === 'conditional') {
        walk(block.children);
      }
    }
  };
  walk(body.children);
  return [...new Set(found)];
}

/** Checks a subject: one line of text and placeholders, without any line or control character. */
export function checkSubject(value: unknown, catalogue: Catalogue): SubjectNode {
  if (typeof value === 'string' || !isRecord(value) || value.type !== 'subject') {
    throw new DocumentError('not_a_document', '$');
  }
  attributes(value, '$', ['type', 'children']);
  if (!Array.isArray(value.children)) {
    throw new DocumentError('wrong_attribute', '$.children');
  }
  const children = value.children.map((child, index): TextNode | PlaceholderNode => {
    const path = `$.children[${String(index)}]`;
    const inline = checkInline(child, path, catalogue, 1);
    if (inline.type !== 'text' && inline.type !== 'placeholder') {
      throw new DocumentError('unknown_node', path);
    }
    if (inline.type === 'text' && /[\r\n\t]/.test(inline.text)) {
      throw new DocumentError('text_control_character', `${path}.text`);
    }
    return inline;
  });
  const length = children.reduce(
    (sum, child) => sum + (child.type === 'text' ? child.text.length : 0),
    0,
  );
  if (length > SUBJECT_LIMIT) {
    throw new DocumentError('subject_too_long', '$');
  }
  return { type: 'subject', children };
}
