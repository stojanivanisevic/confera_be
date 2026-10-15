import {
  type BlockNode,
  type Catalogue,
  checkBody,
  checkSubject,
  type DocNode,
  type InlineNode,
  type SubjectNode,
} from './document';

/**
 * The server's serialiser (ADR-12): a checked document to HTML and to plain text. Every
 * text is escaped; a placeholder's value is escaped like any text; a link's address is a
 * typed `https:`/`mailto:` address or the secure link made at send time. The document is
 * checked again here, not only when it was saved: an unknown node planted straight into
 * the table is refused at render time (ST-58).
 *
 * The web application's editor and this serialiser are kept equal by the shared vectors
 * of contracts/template-vectors.json.
 */
export interface RenderInput {
  /** The placeholder values, plain text. A key not in the catalogue is refused. */
  readonly values: Readonly<Record<string, string>>;
  /** The conditions that hold. */
  readonly conditions: ReadonlySet<string>;
  /** The secure link of the message, when the type carries one. Minted at send time. */
  readonly link?: string | undefined;
}

export interface Rendered {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/** The rendered body must stay under this (ADR-12, P). */
export const RENDERED_LIMIT_BYTES = 100 * 1024;

export class RenderError extends Error {
  constructor(readonly code: 'missing_value' | 'missing_link' | 'too_large') {
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

function valueOf(key: string, input: RenderInput): string {
  const value = Object.hasOwn(input.values, key) ? input.values[key] : undefined;
  if (value === undefined) {
    throw new RenderError('missing_value');
  }
  return oneLine(value);
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
      return escapeHtml(valueOf(node.key, input));
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
      return valueOf(node.key, input);
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
    case 'conditional':
      return input.conditions.has(node.key)
        ? node.children
            .map((child) => blockText(child, input))
            .filter((part) => part !== '')
            .join('\n\n')
        : '';
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
