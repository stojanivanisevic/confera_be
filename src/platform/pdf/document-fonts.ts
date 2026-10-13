import { PRIMARY_FONT } from './fonts';
import type { GlyphCoverage } from './glyph-coverage';

/**
 * Prepares a pdfmake document definition for rendering (ADR-16): every piece of text is
 * checked against the embedded fonts and gets its font, and what cannot be checked is
 * refused.
 *
 * The renderer runs this on every document, so a layout cannot forget the check, and the
 * check covers EVERY place where text can enter a document:
 *
 *   content, header, footer, page background   strings, `text`, lists, columns, stacks,
 *                                              table cells, the title of a table of contents
 *   watermark                                  one text in one font
 *   numbered lists                             the separator after the number
 *
 * The walk is an allowlist. It knows the kinds of node that pdfmake 0.3.11 has (a test
 * compares the list with pdfmake's own source) and the top-level properties of a
 * definition. A kind or property it does not know is refused with
 * `UnsupportedPdfFeatureError`, so that a later version of pdfmake cannot open a new door
 * for unchecked text. Some known ones are refused as well, each with its reason: see
 * `REFUSED_NODE_KINDS` and `REFUSED_DEFINITION_KEYS`.
 *
 * Every text leaf leaves here as `{ text, font }` with its font written out. Nothing a
 * layout says about fonts (a `font` property, a style) can then draw a character with a
 * font that lacks it, and a copy that pdfmake makes of a text (a table of contents)
 * carries the fonts along.
 */

export class UnsupportedPdfFeatureError extends Error {
  constructor(
    readonly feature: string,
    reason: string,
  ) {
    super(`The PDF cannot be made: ${feature} is not supported by the PDF renderer. ${reason}`);
    this.name = 'UnsupportedPdfFeatureError';
  }
}

/** The kinds of content node the renderer accepts. The key names the kind, as in pdfmake. */
export const SUPPORTED_NODE_KINDS = [
  'text',
  'stack',
  'columns',
  'ul',
  'ol',
  'table',
  'toc',
  'image',
  'canvas',
  'qr',
  'pageReference',
] as const;

/** Kinds that pdfmake has and the renderer refuses, each with the reason. */
export const REFUSED_NODE_KINDS: Readonly<Record<string, string>> = {
  svg: 'The SVG library reads any file that an <image> element names, outside the access policy of the renderer, and draws text with fonts of its own choice. Use a PNG or JPEG image, or the canvas node for lines and shapes.',
  section:
    'A section brings its own header, footer, background and watermark; none is needed yet. Add it to the document walk, with tests, before using it.',
  attachment: 'A PDF with files inside is not something Confera issues.',
  textReference:
    'It copies the text of another node into this one; use the text itself, or pageReference for a page number.',
};

/** The properties of a document definition the renderer accepts (pdfmake 0.3.11, Printer.js). */
export const SUPPORTED_DEFINITION_KEYS = [
  'content',
  'header',
  'footer',
  'background',
  'watermark',
  'info',
  'styles',
  'defaultStyle',
  'pageSize',
  'pageOrientation',
  'pageMargins',
  'pageBreakBefore',
  'images',
  'language',
  'compress',
  'displayTitle',
  'maxPagesNumber',
  'subset',
  'tagged',
  'version',
  'userPassword',
  'ownerPassword',
  'permissions',
] as const;

/** Properties of a definition that pdfmake has and the renderer refuses. */
export const REFUSED_DEFINITION_KEYS: Readonly<Record<string, string>> = {
  attachments: 'A PDF with files inside is not something Confera issues.',
  files: 'A PDF with files inside is not something Confera issues.',
  patterns:
    'A fill pattern is raw PDF drawing code, which the renderer cannot read. Add it to the document walk, with tests, before using it.',
};

type Node = unknown;
type NodeObject = Record<string, unknown>;

/** What a character reference beyond the end of Unicode stands for: nothing printable. */
const NOT_A_CHARACTER = String.fromCodePoint(0xffff);

const CONTAINERS = ['stack', 'columns', 'ul', 'ol'] as const;

function isObject(value: unknown): value is NodeObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPrimitive(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isEmpty(value: unknown): boolean {
  return (
    value === null || value === undefined || (isObject(value) && Object.keys(value).length === 0)
  );
}

/**
 * The characters of an SVG image that could be drawn as text: all of its source, and
 * what its character references (`&#20013;`, `&#x4E2D;`) stand for.
 */
function svgCharacters(svg: string): string {
  const referenced = [...svg.matchAll(/&#(x[0-9a-fA-F]+|[0-9]+);?/g)].map(([, reference = '']) => {
    const codePoint = reference.startsWith('x')
      ? Number.parseInt(reference.slice(1), 16)
      : Number.parseInt(reference, 10);
    return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : NOT_A_CHARACTER;
  });
  // Tabs and line breaks lay the source out; they are not text.
  return `${svg}${referenced.join('')}`.replace(/[\t\r\n]/g, ' ');
}

class DocumentWalk {
  constructor(private readonly coverage: GlyphCoverage) {}

  /** A string in a text position: runs with their fonts written out. */
  private runs(value: string | number | boolean): NodeObject[] {
    return this.coverage.split(String(value)).map((run) => ({ text: run.text, font: run.font }));
  }

  private refuseKinds(node: NodeObject): void {
    if (node.svg !== undefined) {
      // The text inside is checked first, so that a character without a font is reported
      // as what it is. The image is refused either way.
      if (typeof node.svg === 'string') {
        this.coverage.require(svgCharacters(node.svg), 'every');
      }
    }
    for (const [kind, reason] of Object.entries(REFUSED_NODE_KINDS)) {
      if (node[kind] !== undefined) {
        throw new UnsupportedPdfFeatureError(`a "${kind}" node`, reason);
      }
    }
  }

  /** One piece of a `text`: a value, or an object that is itself a text or a page reference. */
  private textPiece(piece: Node): Node[] {
    if (isPrimitive(piece)) {
      return this.runs(piece);
    }
    if (isEmpty(piece)) {
      return [];
    }
    if (!isObject(piece)) {
      throw new UnsupportedPdfFeatureError('this text', 'A text holds strings and text objects.');
    }
    this.refuseKinds(piece);
    if ('text' in piece) {
      return [{ ...piece, text: this.text(piece.text) }];
    }
    if (piece.pageReference !== undefined) {
      return [piece];
    }
    throw new UnsupportedPdfFeatureError(
      'a node of another kind inside a text',
      'A text holds strings and text objects only.',
    );
  }

  /** The value of a `text` property. */
  private text(value: Node): Node[] {
    return Array.isArray(value)
      ? value.flatMap((piece: Node) => this.textPiece(piece))
      : this.textPiece(value);
  }

  /** Content: a value, a list of content (a stack), or a node object. */
  content(node: Node): Node {
    if (isPrimitive(node)) {
      return { text: this.runs(node) };
    }
    if (isEmpty(node)) {
      return node;
    }
    if (Array.isArray(node)) {
      return node.map((item: Node) => this.content(item));
    }
    if (!isObject(node)) {
      throw new UnsupportedPdfFeatureError('this content', 'Content is text, a list or a node.');
    }
    return this.node(node);
  }

  private node(node: NodeObject): NodeObject {
    this.refuseKinds(node);
    if (
      !SUPPORTED_NODE_KINDS.some((kind) => (kind === 'text' ? 'text' in node : Boolean(node[kind])))
    ) {
      throw new UnsupportedPdfFeatureError(
        `a node with the properties ${Object.keys(node).join(', ')}`,
        'It is not one of the kinds of node the renderer knows.',
      );
    }

    const result: NodeObject = { ...node };
    if ('text' in node) {
      result.text = this.text(node.text);
    }
    for (const key of CONTAINERS) {
      const items = node[key];
      if (items === undefined) {
        continue;
      }
      if (!Array.isArray(items)) {
        throw new UnsupportedPdfFeatureError(`"${key}"`, 'It must be a list.');
      }
      result[key] = items.map((item: Node) => this.content(item));
    }
    if (node.ol !== undefined && node.separator !== undefined) {
      result.separator = this.separator(node.separator);
    }
    if (node.table !== undefined) {
      result.table = this.table(node.table);
    }
    if (node.toc !== undefined) {
      result.toc = this.tableOfContents(node.toc);
    }
    return result;
  }

  /**
   * What pdfmake puts after (or around) the number of a list item. pdfmake draws it with
   * the font of the styles around the list, so every family must have its characters.
   */
  private separator(separator: Node): Node {
    const parts: Node[] = Array.isArray(separator) ? separator : [separator];
    const checked = parts.map((part) =>
      typeof part === 'string' ? this.coverage.require(part, 'every') : part,
    );
    return Array.isArray(separator) ? checked : checked[0];
  }

  private table(table: Node): Node {
    if (!isObject(table) || !Array.isArray(table.body)) {
      throw new UnsupportedPdfFeatureError('this table', 'A table has a body of rows.');
    }
    return {
      ...table,
      body: table.body.map((row: Node) => {
        if (!Array.isArray(row)) {
          throw new UnsupportedPdfFeatureError(
            'this table',
            'A row of a table is a list of cells.',
          );
        }
        return row.map((cell: Node) => this.content(cell));
      }),
    };
  }

  private tableOfContents(toc: Node): Node {
    if (!isObject(toc)) {
      throw new UnsupportedPdfFeatureError('this table of contents', 'It must be an object.');
    }
    if (toc.sortBy !== undefined) {
      throw new UnsupportedPdfFeatureError(
        'sorting a table of contents',
        'pdfmake sorts by comparing texts as plain strings, which they no longer are once every run has its font.',
      );
    }
    return toc.title === undefined ? toc : { ...toc, title: this.content(toc.title) };
  }

  /** Header, footer and background: content, or a function that returns content for a page. */
  pageContent(value: Node): Node {
    if (typeof value === 'function') {
      const original = value as (...args: unknown[]) => Node;
      return (...args: unknown[]) => this.content(original(...args));
    }
    return this.content(value);
  }

  /** A watermark is one text drawn in one font: the primary font must have all of it. */
  watermark(value: Node): Node {
    if (isEmpty(value)) {
      return value;
    }
    const text = isObject(value) ? value.text : value;
    if (!isPrimitive(text)) {
      throw new UnsupportedPdfFeatureError('this watermark', 'A watermark is a text.');
    }
    const checked = this.coverage.require(String(text), 'primary');
    return { ...(isObject(value) ? value : {}), text: checked, font: PRIMARY_FONT };
  }
}

/**
 * Returns a copy of the definition in which all text is checked and has its font, and
 * whose default font is the primary one. Never changes its argument.
 */
export function withFonts<T extends object>(definition: T, coverage: GlyphCoverage): T {
  const source = definition as NodeObject;
  for (const key of Object.keys(source)) {
    const refused = REFUSED_DEFINITION_KEYS[key];
    if (refused !== undefined) {
      throw new UnsupportedPdfFeatureError(`"${key}" in a document definition`, refused);
    }
    if (!(SUPPORTED_DEFINITION_KEYS as readonly string[]).includes(key)) {
      throw new UnsupportedPdfFeatureError(
        `"${key}" in a document definition`,
        'It is not a property the renderer knows.',
      );
    }
  }

  const walk = new DocumentWalk(coverage);
  const result: NodeObject = { ...source };
  result.content = walk.content(source.content);
  for (const key of ['header', 'footer', 'background'] as const) {
    if (source[key] !== undefined) {
      result[key] = walk.pageContent(source[key]);
    }
  }
  if (source.watermark !== undefined) {
    result.watermark = walk.watermark(source.watermark);
  }
  const defaultStyle = isObject(source.defaultStyle) ? source.defaultStyle : {};
  result.defaultStyle = { ...defaultStyle, font: PRIMARY_FONT };
  return result as T;
}
