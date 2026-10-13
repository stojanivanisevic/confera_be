import { PRIMARY_FONT } from './fonts';
import { type GlyphCoverage, MissingGlyphError, normaliseText } from './glyph-coverage';

/**
 * Walks a pdfmake document definition and gives every piece of text its font
 * (ADR-16): what Manrope has stays as it is, what only the fallback has is marked with
 * the fallback font, and a character that no font has throws MissingGlyphError.
 *
 * The renderer runs this on every document, so a layout cannot forget the check.
 *
 * Only values in a text position are touched: bare strings in the content, `text`, list
 * items, columns, stacks and table cells. Names of styles, colours, alignments, image
 * references and the like are left alone.
 */

type Node = unknown;
type NodeObject = Record<string, unknown>;

const CONTAINERS = ['stack', 'columns', 'ul', 'ol'] as const;

/**
 * Ligatures are switched off: "fi" is drawn as "f" and "i", not as one joined glyph.
 * With a joined glyph some PDF readers copy and search only its first letter
 * ("digrafima" becomes "digrafma"), and a document about money must read back exactly
 * as it was written, in every reader.
 */
export const NO_LIGATURES = Object.freeze({ liga: false, clig: false, dlig: false, hlig: false });

function isObject(value: unknown): value is NodeObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A string in a text position: itself when Manrope draws all of it, else a list of runs. */
function textOf(value: string, coverage: GlyphCoverage): Node {
  const runs = coverage.split(value);
  if (runs.every((run) => run.font === PRIMARY_FONT)) {
    return normaliseText(value);
  }
  return runs.map((run) =>
    run.font === PRIMARY_FONT ? run.text : { text: run.text, font: run.font },
  );
}

/** The value of a `text` property: a string, a list of pieces, or a nested text node. */
function textValue(value: Node, coverage: GlyphCoverage): Node {
  if (typeof value === 'string') {
    return textOf(value, coverage);
  }
  if (Array.isArray(value)) {
    const pieces: Node[] = [];
    for (const piece of value as Node[]) {
      const converted = textValue(piece, coverage);
      if (typeof piece === 'string' && Array.isArray(converted)) {
        pieces.push(...(converted as Node[]));
      } else {
        pieces.push(converted);
      }
    }
    return pieces;
  }
  if (isObject(value) && 'text' in value) {
    return { ...value, text: textValue(value.text, coverage) };
  }
  return value;
}

function contentNode(node: Node, coverage: GlyphCoverage): Node {
  if (typeof node === 'string') {
    const converted = textOf(node, coverage);
    return Array.isArray(converted) ? { text: converted } : converted;
  }
  if (Array.isArray(node)) {
    return node.map((item: Node) => contentNode(item, coverage));
  }
  if (!isObject(node)) {
    return node;
  }
  const result: NodeObject = { ...node };
  if ('text' in result) {
    result.text = textValue(result.text, coverage);
  }
  for (const key of CONTAINERS) {
    if (Array.isArray(result[key])) {
      result[key] = (result[key] as Node[]).map((item) => contentNode(item, coverage));
    }
  }
  if (isObject(result.table) && Array.isArray(result.table.body)) {
    result.table = {
      ...result.table,
      body: (result.table.body as Node[]).map((row) =>
        Array.isArray(row) ? row.map((cell: Node) => contentNode(cell, coverage)) : row,
      ),
    };
  }
  return result;
}

/** Header and footer are content, or a function that returns content for a page. */
function pageContent(value: Node, coverage: GlyphCoverage): Node {
  if (typeof value === 'function') {
    const original = value as (...args: unknown[]) => Node;
    return (...args: unknown[]) => contentNode(original(...args), coverage);
  }
  return value === undefined ? undefined : contentNode(value, coverage);
}

/** A watermark is one text in one font, so every character must be in the primary font. */
function watermark(value: Node, coverage: GlyphCoverage): Node {
  const text = typeof value === 'string' ? value : isObject(value) ? value.text : undefined;
  if (typeof text !== 'string') {
    return value;
  }
  const outside = coverage
    .split(text)
    .filter((run) => run.font !== PRIMARY_FONT)
    .flatMap((run) => Array.from(run.text.trim()))
    .map((character) => ({
      character,
      codePoint: `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`,
    }));
  if (outside.length > 0) {
    throw new MissingGlyphError(outside);
  }
  return isObject(value) ? { ...value, text: normaliseText(text) } : normaliseText(text);
}

/**
 * Returns a copy of the definition in which all text is checked and has its font, and
 * whose default font is the primary one. Never changes its argument.
 */
export function withFonts<T extends object>(definition: T, coverage: GlyphCoverage): T {
  const source = definition as NodeObject;
  const result: NodeObject = { ...source };
  result.content = contentNode(source.content, coverage);
  for (const key of ['header', 'footer'] as const) {
    if (key in source) {
      result[key] = pageContent(source[key], coverage);
    }
  }
  if ('watermark' in source) {
    result.watermark = watermark(source.watermark, coverage);
  }
  const defaultStyle = isObject(source.defaultStyle) ? source.defaultStyle : {};
  // A fresh copy: the layout engine writes its own defaults into the object it is given.
  result.defaultStyle = { fontFeatures: { ...NO_LIGATURES }, ...defaultStyle, font: PRIMARY_FONT };
  return result as T;
}
