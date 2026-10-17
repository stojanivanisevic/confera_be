import { crc32 } from 'node:zlib';

/**
 * Small files of the kinds the upload accepts and refuses, made byte by byte for the tests
 * (ADR-10, G2-22): a ZIP (a `.docx` is one) from its entry names, and a compound file (an
 * old `.doc`) from the names of its directory. Nothing here is a real document; only the
 * structure the type detection reads is right.
 */
export function zipOf(entries: Readonly<Record<string, string | Buffer>>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** A `.docx`: a ZIP with the content types and a document part; with macros, a VBA project too. */
export function docxOf(options: { macros?: boolean } = {}): Buffer {
  return zipOf({
    '[Content_Types].xml': '<?xml version="1.0"?><Types/>',
    'word/document.xml': '<?xml version="1.0"?><w:document/>',
    ...(options.macros === true ? { 'word/vbaProject.bin': Buffer.alloc(64, 1) } : {}),
  });
}

/** An old `.doc`: a compound file of 512-byte sectors with these names in its directory. */
export function compoundFileOf(names: readonly string[]): Buffer {
  const sector = 512;
  const header = Buffer.alloc(sector, 0);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header, 0);
  header.writeUInt16LE(0x3e, 0x18);
  header.writeUInt16LE(3, 0x1a);
  header.writeUInt16LE(0xfffe, 0x1c);
  header.writeUInt16LE(9, 0x1e);
  header.writeUInt16LE(6, 0x20);
  header.writeUInt32LE(1, 0x2c);
  header.writeUInt32LE(1, 0x30);
  header.writeUInt32LE(4096, 0x38);
  header.writeUInt32LE(0xfffffffe, 0x3c);
  header.writeUInt32LE(0xfffffffe, 0x44);
  header.writeUInt32LE(0, 0x4c);
  for (let index = 1; index < 109; index += 1) {
    header.writeUInt32LE(0xffffffff, 0x4c + index * 4);
  }
  const fat = Buffer.alloc(sector, 0xff);
  fat.writeUInt32LE(0xfffffffd, 0);
  fat.writeUInt32LE(0xfffffffe, 4);
  const directory = Buffer.alloc(sector, 0);
  const all = ['Root Entry', ...names].slice(0, 4);
  all.forEach((name, index) => {
    const at = index * 128;
    const encoded = Buffer.from(`${name}\0`, 'utf16le');
    encoded.copy(directory, at);
    directory.writeUInt16LE(encoded.length, at + 0x40);
    directory[at + 0x42] = index === 0 ? 5 : name === 'Macros' ? 1 : 2;
  });
  return Buffer.concat([header, fat, directory]);
}

/** A `.doc`, with or without macros. */
export function docOf(options: { macros?: boolean } = {}): Buffer {
  return compoundFileOf(['WordDocument', ...(options.macros === true ? ['Macros'] : [])]);
}

/** A PDF of about `size` bytes (the type detection reads its first bytes only). */
export function pdfOf(size = 1024): Buffer {
  const body = Buffer.alloc(Math.max(size, 16), 0x20);
  Buffer.from('%PDF-1.7\n').copy(body, 0);
  return body;
}

/** The EICAR test string: every antivirus reports it, and it harms nothing. */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';
