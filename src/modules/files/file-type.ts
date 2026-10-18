import { open } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import type { FileType } from '../forms/catalogue';

/**
 * The type of an uploaded file, read from its content, never from its name (ADR-10,
 * NFR-SEC-06), and the macro policy of Gate 2 (G2-22):
 *
 * - PDF by `%PDF-`, PNG and JPEG by their signatures;
 * - a `.docx` is a ZIP whose central directory names `[Content_Types].xml` and a part under
 *   `word/`; it holds macros when it has a VBA project (`vbaProject.bin`): refused;
 *   A `.docx` whose relationships reach outside it (a remote template, a UNC path) is
 *   accepted and flagged `external_links` (SEC-M3-06);
 * - an old `.doc` is a compound file (CFB) with a `WordDocument` stream; it holds macros when
 *   it has a `Macros` or `_VBA_PROJECT_CUR` storage, in any casing: accepted and flagged for
 *   the office.
 *
 * Only directories are read (the end of a ZIP, the directory sectors of a CFB), and of a ZIP
 * the few small parts that name a VBA project, in bounded steps: one budget of inflated bytes,
 * of parts and of time per file (SEC-M3-01), so a file of many entries or an archive bomb
 * costs bounded time and memory. What is none of these is `null`, and refused.
 */
export interface DetectedType {
  readonly type: FileType | null;
  /** The file holds macros (a VBA project). */
  readonly macros: boolean;
  /**
   * The file is built as no document is (SEC-M3-01): ZIP entries that repeat a name or
   * overlap, or more inspection than any document needs. It is refused, and the upload counts
   * as an act of a script.
   */
  readonly crafted?: true;
  /**
   * A `.docx` that links to something outside itself that reaches a reader (SEC-M3-06): a
   * remote template, frame or object, or a UNC or `file:` target. Kept and flagged.
   */
  readonly externalLinks?: true;
}

const UNKNOWN: DetectedType = { type: null, macros: false };
const CRAFTED: DetectedType = { type: null, macros: false, crafted: true };

/** The most entries a central directory or a CFB directory may have before the file is refused. */
const MAX_ENTRIES = 10_000;
const MAX_CENTRAL_DIRECTORY = 4 * 1024 * 1024;

type Handle = Awaited<ReturnType<typeof open>>;

async function readAt(handle: Handle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/** An entry of a ZIP's central directory: where its data begins and how it is stored. */
interface ZipEntry {
  readonly name: string;
  readonly nameLength: number;
  readonly method: number;
  readonly compressedSize: number;
  readonly uncompressedSize: number;
  readonly localOffset: number;
}

/** The most of one small part (content types, relationships) that is read and inflated. */
const MAX_PART_BYTES = 1024 * 1024;
/** The most a file's parts may inflate to in all (SEC-M3-01): a document's are a few KB. */
export const MAX_INFLATED_BYTES = 2 * 1024 * 1024;
/** The most parts of a file that are read and inflated (SEC-M3-01). */
export const MAX_PARTS_READ = 64;
/** The most time the inspection of one file's parts may take (SEC-M3-01). */
export const MAX_INSPECTION_MS = 1_000;

/**
 * The entries of a ZIP, from its central directory; null when it is not a plain ZIP, and
 * `'crafted'` when its entries repeat a name or overlap (SEC-M3-01): in a real archive every
 * entry has a name and bytes of its own, so one compressed block is never read twice.
 */
async function zipEntries(handle: Handle, size: number): Promise<ZipEntry[] | 'crafted' | null> {
  const tail = Math.min(size, 65_557);
  const end = await readAt(handle, size - tail, tail);
  let at = -1;
  for (let index = end.length - 22; index >= 0; index -= 1) {
    if (end.readUInt32LE(index) === 0x06054b50) {
      at = index;
      break;
    }
  }
  if (at < 0) {
    return null;
  }
  const entries = end.readUInt16LE(at + 10);
  const directorySize = end.readUInt32LE(at + 12);
  const directoryOffset = end.readUInt32LE(at + 16);
  // ZIP64 and directories larger than any document needs are not read.
  if (
    entries === 0xffff ||
    directoryOffset === 0xffffffff ||
    entries > MAX_ENTRIES ||
    directorySize > MAX_CENTRAL_DIRECTORY ||
    directoryOffset + directorySize > size
  ) {
    return null;
  }
  const directory = await readAt(handle, directoryOffset, directorySize);
  const names: ZipEntry[] = [];
  let position = 0;
  for (let entry = 0; entry < entries; entry += 1) {
    if (position + 46 > directory.length || directory.readUInt32LE(position) !== 0x02014b50) {
      return null;
    }
    const nameLength = directory.readUInt16LE(position + 28);
    const extraLength = directory.readUInt16LE(position + 30);
    const commentLength = directory.readUInt16LE(position + 32);
    names.push({
      name: directory.subarray(position + 46, position + 46 + nameLength).toString('utf8'),
      nameLength,
      method: directory.readUInt16LE(position + 10),
      compressedSize: directory.readUInt32LE(position + 20),
      uncompressedSize: directory.readUInt32LE(position + 24),
      localOffset: directory.readUInt32LE(position + 42),
    });
    position += 46 + nameLength + extraLength + commentLength;
  }
  const seen = new Set<string>();
  for (const entry of names) {
    const lower = entry.name.toLowerCase();
    if (seen.has(lower)) {
      return 'crafted';
    }
    seen.add(lower);
  }
  // Each entry's local header, name and data end before the next entry and the directory.
  const ordered = [...names].sort((a, b) => a.localOffset - b.localOffset);
  let free = 0;
  for (const entry of ordered) {
    if (entry.localOffset < free) {
      return 'crafted';
    }
    free = entry.localOffset + 30 + entry.nameLength + entry.compressedSize;
    if (free > directoryOffset) {
      return 'crafted';
    }
  }
  return names;
}

/** What is left of the inspection of one file (SEC-M3-01). */
interface Budget {
  bytes: number;
  parts: number;
  readonly until: number;
}

/**
 * The bytes of a small part of a ZIP (stored or deflated), or null when it is larger than a
 * part of its kind ever is or than what is left of the budget, or cannot be read: bounded in
 * what is read and in what it inflates to.
 */
async function zipPart(
  handle: Handle,
  size: number,
  entry: ZipEntry,
  budget: Budget,
): Promise<Buffer | null> {
  const most = Math.min(MAX_PART_BYTES, budget.bytes);
  if (entry.compressedSize > most || entry.uncompressedSize > most) {
    return null;
  }
  const local = await readAt(handle, entry.localOffset, 30);
  if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) {
    return null;
  }
  const start = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  if (start + entry.compressedSize > size) {
    return null;
  }
  const data = await readAt(handle, start, entry.compressedSize);
  try {
    if (entry.method === 0) {
      budget.bytes -= data.length;
      return data;
    }
    if (entry.method === 8) {
      const inflated = inflateRawSync(data, { maxOutputLength: most });
      budget.bytes -= inflated.length;
      return inflated;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * The text of an XML part as Word reads it (SEC-M3-06): UTF-8, or UTF-16 by its byte order
 * mark or its first `<`, with the character references and the five named entities decoded,
 * so that `vba&#80;roject` or a part in UTF-16 is matched like plain text. Null when it is
 * none of these (a NUL is left, as in UTF-32): such a part cannot be judged.
 */
export function xmlPartText(bytes: Buffer): string | null {
  let text: string;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    text = bytes.subarray(2).toString('utf16le');
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    text = Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  } else if (bytes[0] === 0x3c && bytes[1] === 0x00) {
    text = bytes.toString('utf16le');
  } else if (bytes[0] === 0x00 && bytes[1] === 0x3c) {
    text = Buffer.from(bytes.subarray(0, bytes.length - (bytes.length % 2)))
      .swap16()
      .toString('utf16le');
  } else {
    const start = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    text = bytes.subarray(start).toString('utf8');
  }
  if (text.includes('\0')) {
    return null;
  }
  const named: Readonly<Record<string, string>> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
  };
  return text.replace(
    /&(?:#(\d{1,7})|#x([0-9a-f]{1,6})|(amp|lt|gt|quot|apos));/giu,
    (whole, decimal?: string, hex?: string, name?: string) => {
      if (name !== undefined) {
        return named[name.toLowerCase()] ?? whole;
      }
      const code = decimal !== undefined ? Number(decimal) : Number.parseInt(hex ?? '', 16);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    },
  );
}

/**
 * Whether a relationship part points outside the document in a way that reaches a reader
 * (SEC-M3-06): a remote template, frame or object (`TargetMode="External"`, other than a
 * hyperlink, which the reader must click), or a UNC or `file:` target of any kind, which
 * Windows may open by itself and hand the user's credentials to.
 */
function hasExternalLink(text: string): boolean {
  for (const element of text.matchAll(/<(?:[\w.-]+:)?Relationship\b([^>]*)>/giu)) {
    const attributes = new Map<string, string>();
    for (const attribute of (element[1] ?? '').matchAll(
      /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu,
    )) {
      attributes.set((attribute[1] ?? '').toLowerCase(), attribute[2] ?? attribute[3] ?? '');
    }
    const target = (attributes.get('target') ?? '').trim();
    if (/^(?:\\\\|\/\/|file:)/iu.test(target)) {
      return true;
    }
    if (
      (attributes.get('targetmode') ?? '').trim().toLowerCase() === 'external' &&
      !/\/hyperlink$/iu.test((attributes.get('type') ?? '').trim())
    ) {
      return true;
    }
  }
  return false;
}

interface DocxInspection {
  /** True for a VBA project; `'crafted'` beyond the budget. */
  readonly macros: boolean | 'crafted';
  readonly externalLinks: boolean;
}

/**
 * Whether a `.docx` holds a VBA project (G2-22, Q3-11): Word finds it by its content type
 * and its relationship, whatever the part is called. So a part named like one, a content
 * type of a VBA project or of a macro-enabled document, or a relationship of the type
 * vbaProject each count. A part that cannot be read counts as macros (fail closed), and so
 * does a file whose parts would take more than the budget (SEC-M3-01): `'crafted'`. And
 * whether it links to something outside itself that reaches a reader (SEC-M3-06).
 */
async function inspectDocx(
  handle: Handle,
  size: number,
  entries: ZipEntry[],
): Promise<DocxInspection> {
  const budget: Budget = {
    bytes: MAX_INFLATED_BYTES,
    parts: MAX_PARTS_READ,
    until: Date.now() + MAX_INSPECTION_MS,
  };
  let externalLinks = false;
  for (const entry of entries) {
    const lower = entry.name.toLowerCase();
    if (lower.endsWith('vbaproject.bin') || lower.endsWith('vbadata.xml')) {
      return { macros: true, externalLinks };
    }
    const contentTypes = lower === '[content_types].xml';
    const relationships = lower.endsWith('.rels');
    if (!contentTypes && !relationships) {
      continue;
    }
    if (budget.parts === 0 || entry.uncompressedSize > budget.bytes || Date.now() > budget.until) {
      return { macros: 'crafted', externalLinks };
    }
    budget.parts -= 1;
    const part = await zipPart(handle, size, entry, budget);
    const text = part === null ? null : xmlPartText(part);
    if (text === null) {
      return { macros: true, externalLinks };
    }
    if (
      (contentTypes && /vbaProject|macroEnabled|vbaData/i.test(text)) ||
      (relationships && /relationships\/(?:vbaProject|wordVbaData)/i.test(text))
    ) {
      return { macros: true, externalLinks };
    }
    externalLinks ||= relationships && hasExternalLink(text);
  }
  return { macros: false, externalLinks };
}

/** The names in a compound file's directory (CFB, the old Office format); null when it is not one. */
async function compoundNames(handle: Handle, size: number): Promise<string[] | null> {
  const header = await readAt(handle, 0, 512);
  if (header.length < 512) {
    return null;
  }
  const shift = header.readUInt16LE(0x1e);
  if (shift !== 9 && shift !== 12) {
    return null;
  }
  const sectorSize = 1 << shift;
  const perSector = sectorSize / 4;
  const sectorAt = (sector: number) => (sector + 1) * sectorSize;

  // The sectors of the allocation table: 109 in the header, the rest in the DIFAT chain.
  const fatSectors: number[] = [];
  for (let index = 0; index < 109; index += 1) {
    const sector = header.readUInt32LE(0x4c + index * 4);
    if (sector < 0xfffffffa) {
      fatSectors.push(sector);
    }
  }
  let difat = header.readUInt32LE(0x44);
  for (let step = 0; difat < 0xfffffffa && step < 1000; step += 1) {
    const block = await readAt(handle, sectorAt(difat), sectorSize);
    if (block.length < sectorSize) {
      return null;
    }
    for (let index = 0; index < perSector - 1; index += 1) {
      const sector = block.readUInt32LE(index * 4);
      if (sector < 0xfffffffa) {
        fatSectors.push(sector);
      }
    }
    difat = block.readUInt32LE((perSector - 1) * 4);
  }
  const fatCache = new Map<number, Buffer>();
  const next = async (sector: number): Promise<number> => {
    const fatIndex = Math.floor(sector / perSector);
    const fatSector = fatSectors[fatIndex];
    if (fatSector === undefined) {
      return 0xfffffffe;
    }
    let block = fatCache.get(fatSector);
    if (block === undefined) {
      block = await readAt(handle, sectorAt(fatSector), sectorSize);
      fatCache.set(fatSector, block);
    }
    const offset = (sector % perSector) * 4;
    return offset + 4 <= block.length ? block.readUInt32LE(offset) : 0xfffffffe;
  };

  const names: string[] = [];
  const seen = new Set<number>();
  let sector = header.readUInt32LE(0x30);
  while (sector < 0xfffffffa) {
    if (seen.has(sector) || seen.size > 1000 || sectorAt(sector) >= size) {
      return null;
    }
    seen.add(sector);
    const block = await readAt(handle, sectorAt(sector), sectorSize);
    for (let offset = 0; offset + 128 <= block.length; offset += 128) {
      const nameBytes = Math.min(block.readUInt16LE(offset + 0x40), 64);
      const kind = block[offset + 0x42];
      if (nameBytes >= 2 && (kind === 1 || kind === 2 || kind === 5)) {
        names.push(block.subarray(offset, offset + nameBytes - 2).toString('utf16le'));
      }
      if (names.length > MAX_ENTRIES) {
        return null;
      }
    }
    sector = await next(sector);
  }
  return names;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CFB = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);

/** What a stored file is, by its content. */
export async function detectFileType(path: string): Promise<DetectedType> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const head = await readAt(handle, 0, 8);
    if (head.length < 4) {
      return UNKNOWN;
    }
    if (head.subarray(0, 5).toString('latin1') === '%PDF-') {
      return { type: 'pdf', macros: false };
    }
    if (head.length === 8 && head.equals(PNG)) {
      return { type: 'png', macros: false };
    }
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
      return { type: 'jpeg', macros: false };
    }
    if (head.readUInt32LE(0) === 0x04034b50) {
      const entries = await zipEntries(handle, size);
      if (entries === 'crafted') {
        return CRAFTED;
      }
      if (entries === null) {
        return UNKNOWN;
      }
      const lower = entries.map((entry) => entry.name.toLowerCase());
      if (
        !lower.includes('[content_types].xml') ||
        !lower.some((name) => name.startsWith('word/'))
      ) {
        return UNKNOWN;
      }
      const { macros, externalLinks } = await inspectDocx(handle, size, entries);
      // More work than any document needs: refused as holding macros (fail closed), and counted.
      if (macros === 'crafted') {
        return { type: 'docx', macros: true, crafted: true };
      }
      return externalLinks ? { type: 'docx', macros, externalLinks } : { type: 'docx', macros };
    }
    if (head.length === 8 && head.equals(CFB)) {
      // The names of a compound file are compared without regard to case (SEC-M3-06).
      const names = (await compoundNames(handle, size))?.map((name) => name.toLowerCase());
      if (!names?.includes('worddocument')) {
        return UNKNOWN;
      }
      return {
        type: 'doc',
        macros: names.some(
          (name) => name === 'macros' || name === '_vba_project_cur' || name === 'vba',
        ),
      };
    }
    return UNKNOWN;
  } finally {
    await handle.close();
  }
}

/** The media type a detected type is sent with (always as an attachment). */
export const MEDIA_TYPES: Readonly<Record<FileType, string>> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

/** The file-name extension of a detected type. */
export const EXTENSIONS: Readonly<Record<FileType, string>> = {
  pdf: 'pdf',
  docx: 'docx',
  doc: 'doc',
  jpeg: 'jpg',
  png: 'png',
};
