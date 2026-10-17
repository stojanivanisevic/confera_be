import { open } from 'node:fs/promises';
import type { FileType } from '../forms/catalogue';

/**
 * The type of an uploaded file, read from its content, never from its name (ADR-10,
 * NFR-SEC-06), and the macro policy of Gate 2 (G2-22):
 *
 * - PDF by `%PDF-`, PNG and JPEG by their signatures;
 * - a `.docx` is a ZIP whose central directory names `[Content_Types].xml` and a part under
 *   `word/`; it holds macros when it has a VBA project (`vbaProject.bin`): refused;
 * - an old `.doc` is a compound file (CFB) with a `WordDocument` stream; it holds macros when
 *   it has a `Macros` or `_VBA_PROJECT_CUR` storage: accepted and flagged for the office.
 *
 * Only directories are read (the end of a ZIP, the directory sectors of a CFB), in bounded
 * steps, so a file of many entries or an archive bomb costs bounded time and memory. What is
 * none of these is `null`, and refused.
 */
export interface DetectedType {
  readonly type: FileType | null;
  /** The file holds macros (a VBA project). */
  readonly macros: boolean;
}

const UNKNOWN: DetectedType = { type: null, macros: false };

/** The most entries a central directory or a CFB directory may have before the file is refused. */
const MAX_ENTRIES = 10_000;
const MAX_CENTRAL_DIRECTORY = 4 * 1024 * 1024;

type Handle = Awaited<ReturnType<typeof open>>;

async function readAt(handle: Handle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

/** The names of a ZIP's entries, from its central directory; null when it is not a plain ZIP. */
async function zipNames(handle: Handle, size: number): Promise<string[] | null> {
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
  const names: string[] = [];
  let position = 0;
  for (let entry = 0; entry < entries; entry += 1) {
    if (position + 46 > directory.length || directory.readUInt32LE(position) !== 0x02014b50) {
      return null;
    }
    const nameLength = directory.readUInt16LE(position + 28);
    const extraLength = directory.readUInt16LE(position + 30);
    const commentLength = directory.readUInt16LE(position + 32);
    names.push(directory.subarray(position + 46, position + 46 + nameLength).toString('utf8'));
    position += 46 + nameLength + extraLength + commentLength;
  }
  return names;
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
      const names = await zipNames(handle, size);
      if (names === null) {
        return UNKNOWN;
      }
      const lower = names.map((name) => name.toLowerCase());
      if (
        !lower.includes('[content_types].xml') ||
        !lower.some((name) => name.startsWith('word/'))
      ) {
        return UNKNOWN;
      }
      return {
        type: 'docx',
        macros: lower.some(
          (name) => name.endsWith('vbaproject.bin') || name.endsWith('vbadata.xml'),
        ),
      };
    }
    if (head.length === 8 && head.equals(CFB)) {
      const names = await compoundNames(handle, size);
      if (!names?.includes('WordDocument')) {
        return UNKNOWN;
      }
      return {
        type: 'doc',
        macros: names.some(
          (name) => name === 'Macros' || name === '_VBA_PROJECT_CUR' || name === 'VBA',
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
