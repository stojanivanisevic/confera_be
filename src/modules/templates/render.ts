import {
  type BlockNode,
  type Catalogue,
  checkBody,
  checkSubject,
  type DocNode,
  type InlineNode,
  type SubjectNode,
} from './document';
import { MULTILINE_PLACEHOLDERS } from './placeholders';

/**
 * The server's serialiser (ADR-12): a checked document to HTML and to plain text. Every
 * text is escaped; a placeholder's value is escaped like any text; a link's address is a
 * typed `https:`/`mailto:` address or the secure link made at send time. The document is
 * checked again here, not only when it was saved: an unknown node planted straight into
 * the table is refused at render time (ST-58). The HTML it made is checked once more by an
 * allowlist of its own tags and attributes (`assertSafeHtml`, SEC-A-42 (7), M2-ISS-12).
 *
 * The web application's editor and this serialiser are kept equal by the shared vectors
 * of contracts/template-vectors.json.
 */
export interface RenderedImage {
  /** `cid:<id>` in a message, a `data:` address in the preview (ADR-12): never a remote address. */
  readonly src: string;
  readonly width: number;
  readonly height: number;
}

export interface RenderInput {
  /** The placeholder values, plain text. A key not in the catalogue is refused. */
  readonly values: Readonly<Record<string, string>>;
  /** The conditions that hold. */
  readonly conditions: ReadonlySet<string>;
  /** The secure link of the message, when the type carries one. Minted at send time. */
  readonly link?: string | undefined;
  /**
   * The images that may be shown, by file id (M4-BE-06). An image without an entry (not
   * scanned clean, or gone) is left out of the HTML; its alternative text stays in the text.
   */
  readonly images?: ReadonlyMap<string, RenderedImage> | undefined;
}

export interface Rendered {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** The rendered body must stay under this (ADR-12, P). */
export const RENDERED_LIMIT_BYTES = 100 * 1024;

export class RenderError extends Error {
  constructor(readonly code: 'missing_value' | 'missing_link' | 'too_large' | 'unsafe_html') {
    super(code);
    this.name = 'RenderError';
  }
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A placeholder value as one line of text: no line or control character survives. */
function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]+/gu, ' ').trim();
}

/** A value of several lines (the admin's message): its lines kept, each one made one line. */
function linesOf(text: string): string[] {
  return text
    .replace(/\r\n?/g, '\n')
    .split(/[\n\u2028\u2029]/u)
    .map((line) => oneLine(line));
}

function rawValueOf(key: string, input: RenderInput): string {
  const value = Object.hasOwn(input.values, key) ? input.values[key] : undefined;
  if (value === undefined) {
    throw new RenderError('missing_value');
  }
  return value;
}

function valueOf(key: string, input: RenderInput): string {
  return oneLine(rawValueOf(key, input));
}

function linkOf(input: RenderInput): string {
  if (input.link === undefined) {
    throw new RenderError('missing_link');
  }
  return input.link;
}

function inlineHtml(node: InlineNode, input: RenderInput): string {
  switch (node.type) {
    case 'text': {
      let html = escapeHtml(node.text);
      for (const mark of node.marks ?? []) {
        const tag = { bold: 'strong', italic: 'em', underline: 'u' }[mark];
        html = `<${tag}>${html}</${tag}>`;
      }
      return html;
    }
    case 'hardBreak':
      return '<br>';
    case 'placeholder':
      return MULTILINE_PLACEHOLDERS.has(node.key)
        ? linesOf(rawValueOf(node.key, input))
            .map((line) => escapeHtml(line))
            .join('<br>')
        : escapeHtml(valueOf(node.key, input));
    case 'link': {
      const href = typeof node.href === 'string' ? node.href : linkOf(input);
      return `<a href="${escapeHtml(href)}">${node.children.map((child) => inlineHtml(child, input)).join('')}</a>`;
    }
  }
}

function inlineText(node: InlineNode, input: RenderInput): string {
  switch (node.type) {
    case 'text':
      return node.text;
    case 'hardBreak':
      return '\n';
    case 'placeholder':
      return MULTILINE_PLACEHOLDERS.has(node.key)
        ? linesOf(rawValueOf(node.key, input)).join('\n')
        : valueOf(node.key, input);
    case 'link': {
      const href = typeof node.href === 'string' ? node.href : linkOf(input);
      const label = node.children.map((child) => inlineText(child, input)).join('');
      return label === href ? href : `${label} <${href}>`;
    }
  }
}

function blockHtml(node: BlockNode, input: RenderInput): string {
  switch (node.type) {
    case 'paragraph':
      return `<p>${node.children.map((child) => inlineHtml(child, input)).join('')}</p>`;
    case 'heading':
      return `<h${String(node.level)}>${node.children.map((child) => inlineHtml(child, input)).join('')}</h${String(node.level)}>`;
    case 'bulletList':
    case 'numberedList': {
      const tag = node.type === 'bulletList' ? 'ul' : 'ol';
      const items = node.items.map(
        (item) => `<li>${item.children.map((child) => inlineHtml(child, input)).join('')}</li>`,
      );
      return `<${tag}>${items.join('')}</${tag}>`;
    }
    case 'image': {
      const image = input.images?.get(node.fileId);
      if (image === undefined) {
        // Not clean (yet), or gone: its words in its place, as in the text (UX4-04).
        return node.alt === '' ? '' : `<p>[${escapeHtml(node.alt)}]</p>`;
      }
      // Never wider than the screen of a phone (UX4-04): the width is the most it takes.
      return `<p><img src="${escapeHtml(image.src)}" alt="${escapeHtml(node.alt)}" width="${String(image.width)}" height="${String(image.height)}" style="${IMAGE_STYLE}"></p>`;
    }
    case 'conditional':
      return input.conditions.has(node.key)
        ? node.children.map((child) => blockHtml(child, input)).join('')
        : '';
  }
}

function blockText(node: BlockNode, input: RenderInput): string {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return node.children.map((child) => inlineText(child, input)).join('');
    case 'bulletList':
    case 'numberedList':
      return node.items
        .map(
          (item, index) =>
            `${node.type === 'bulletList' ? '-' : `${String(index + 1)}.`} ${item.children.map((child) => inlineText(child, input)).join('')}`,
        )
        .join('\n');
    case 'image':
      return node.alt === '' ? '' : `[${node.alt}]`;
    case 'conditional':
      return input.conditions.has(node.key)
        ? node.children
            .map((child) => blockText(child, input))
            .filter((part) => part !== '')
            .join('\n\n')
        : '';
  }
}

/** The one style the serialiser writes, on an image only. */
export const IMAGE_STYLE = 'max-width:100%;height:auto';

/** The tags the serialiser writes, and the attributes each may carry. */
const ALLOWED_TAGS: Readonly<Record<string, readonly string[]>> = {
  p: [],
  h1: [],
  h2: [],
  h3: [],
  ul: [],
  ol: [],
  li: [],
  strong: [],
  em: [],
  u: [],
  br: [],
  a: ['href'],
  img: ['src', 'alt', 'width', 'height', 'style'],
};
const TAG = /<(\/?)([a-z0-9]+)((?:\s[a-z]+="[^"<>]*")*)>/g;
const ATTRIBUTE = /\s([a-z]+)="([^"<>]*)"/g;
// The secure-link mark of a stored rendering (mail-composer.ts) holds a control character on purpose.
// eslint-disable-next-line no-control-regex
const SAFE_HREF = /^(https:\/\/|mailto:|\u0001link\u0001$|\[link\]$)/u;
const SAFE_SRC = /^(cid:[A-Za-z0-9@.-]+|data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/=]+)$/;

/**
 * The sanitiser pass on the rendered result (SEC-A-42 (7), M2-ISS-12): the HTML holds the
 * serialiser's own tags and attributes only, a link only to `https:`, `mailto:` or the
 * secure-link mark, an image only from an inline part or the preview's data. Anything
 * else is a fault of the serialiser, and nothing is sent.
 */
export function assertSafeHtml(html: string): void {
  const rest = html.replace(TAG, (_tag, closing: string, name: string, attributes: string) => {
    const allowed = ALLOWED_TAGS[name];
    if (allowed === undefined || (closing === '/' && attributes !== '')) {
      throw new RenderError('unsafe_html');
    }
    for (const [, attribute = '', value = ''] of attributes.matchAll(ATTRIBUTE)) {
      if (!allowed.includes(attribute)) {
        throw new RenderError('unsafe_html');
      }
      const decoded = value.replace(/&amp;/g, '&');
      if (attribute === 'href' && !SAFE_HREF.test(decoded)) {
        throw new RenderError('unsafe_html');
      }
      if (attribute === 'src' && !SAFE_SRC.test(decoded)) {
        throw new RenderError('unsafe_html');
      }
      if ((attribute === 'width' || attribute === 'height') && !/^\d{1,4}$/.test(value)) {
        throw new RenderError('unsafe_html');
      }
      if (attribute === 'style' && value !== IMAGE_STYLE) {
        throw new RenderError('unsafe_html');
      }
    }
    return '';
  });
  if (rest.includes('<') || rest.includes('>')) {
    throw new RenderError('unsafe_html');
  }
}

/** Renders a body: the HTML of the message and its plain-text alternative. */
export function renderBody(document: DocNode, input: RenderInput): { html: string; text: string } {
  const html = document.children.map((block) => blockHtml(block, input)).join('\n');
  const text = document.children
    .map((block) => blockText(block, input))
    .filter((part) => part !== '')
    .join('\n\n');
  if (Buffer.byteLength(html, 'utf8') > RENDERED_LIMIT_BYTES) {
    throw new RenderError('too_large');
  }
  assertSafeHtml(html);
  return { html, text: `${text}\n` };
}

/** Renders a subject: one line, with every placeholder value made one line too. */
export function renderSubject(subject: SubjectNode, input: RenderInput): string {
  return oneLine(
    subject.children
      .map((child) => (child.type === 'text' ? child.text : valueOf(child.key, input)))
      .join(''),
  );
}

/** Checks (again) and renders a stored template: what the sender does with a row of the table. */
export function renderTemplate(
  stored: { subject: unknown; body: unknown },
  catalogue: Catalogue,
  input: RenderInput,
): Rendered {
  const subject = checkSubject(stored.subject, catalogue);
  const body = checkBody(stored.body, catalogue);
  return { subject: renderSubject(subject, input), ...renderBody(body, input) };
}
