import { deflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';
import { GifWriter } from 'omggif';
import { PNG } from 'pngjs';
import {
  ImageError,
  MAX_PIXELS,
  OUTPUT_MAX_BYTES,
  processEmailImage,
  readHeader,
  reencode,
} from './email-images';

/**
 * Email images (M4-BE-06; ST-60, ST-67): the type by content, the size from the header
 * before any decode, the decoding in a worker within its limits, the re-encoding that
 * leaves no metadata behind, and the other work of the process going on meanwhile.
 */
function pngOf(width: number, height: number, extraChunks: Buffer[] = []): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = (i / 4) % 256;
    png.data[i + 1] = 120;
    png.data[i + 2] = 200;
    png.data[i + 3] = 255;
  }
  const encoded = PNG.sync.write(png);
  if (extraChunks.length === 0) {
    return encoded;
  }
  // Behind IHDR (8 + 25 bytes): the chunks a camera or an editor leaves.
  return Buffer.concat([encoded.subarray(0, 33), ...extraChunks, encoded.subarray(33)]);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  // A chunk with a wrong CRC is refused by the decoder; this one is ancillary and checked.
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function jpegOf(width: number, height: number, exif?: string): Buffer {
  const data = Buffer.alloc(width * height * 4, 180);
  const encoded = jpeg.encode({ data, width, height }, 90).data;
  if (exif === undefined) {
    return encoded;
  }
  const payload = Buffer.from(`Exif\u0000\u0000${exif}`, 'latin1');
  const segment = Buffer.alloc(4);
  segment.writeUInt16BE(0xffe1, 0);
  segment.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([encoded.subarray(0, 2), segment, payload, encoded.subarray(2)]);
}

function gifOf(width: number, height: number, frames: number): Buffer {
  const buffer = Buffer.alloc(width * height * frames + 4096);
  const writer = new GifWriter(buffer, width, height, { palette: [0x000000, 0xffffff] });
  for (let n = 0; n < frames; n += 1) {
    writer.addFrame(0, 0, width, height, new Array<number>(width * height).fill(n % 2));
  }
  return buffer.subarray(0, writer.end());
}

/**
 * A GIF whose logical screen is `screen` pixels but whose one frame's descriptor claims
 * `frame` (at `left`, `top`), with a valid LZW stream of one pixel (SEC-M4-01).
 */
function gifWithFrame(
  screen: { w: number; h: number },
  frame: { w: number; h: number; left?: number; top?: number },
): Buffer {
  const header = Buffer.alloc(13);
  header.write('GIF89a', 0, 'latin1');
  header.writeUInt16LE(screen.w, 6);
  header.writeUInt16LE(screen.h, 8);
  header[10] = 0x80;
  const descriptor = Buffer.alloc(10);
  descriptor[0] = 0x2c;
  descriptor.writeUInt16LE(frame.left ?? 0, 1);
  descriptor.writeUInt16LE(frame.top ?? 0, 3);
  descriptor.writeUInt16LE(frame.w, 5);
  descriptor.writeUInt16LE(frame.h, 7);
  return Buffer.concat([
    header,
    Buffer.from([0, 0, 0, 255, 255, 255]),
    descriptor,
    Buffer.from([0x02, 0x02, 0x44, 0x01, 0x00, 0x3b]),
  ]);
}

/** A PNG whose header claims a size its data never has: the shape of a pixel bomb. */
function pixelBomb(side: number, inflated = 1024 * 1024): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(side, 0);
  ihdr.writeUInt32BE(side, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    // Zeros compress to almost nothing and would inflate to side * side * 4 bytes.
    chunk('IDAT', deflateSync(Buffer.alloc(inflated))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof ImageError ? error.code : `other: ${String(error)}`;
  }
  return 'accepted';
}

describe('email images (M4-BE-06, ST-60, ST-67)', () => {
  jest.setTimeout(180_000);

  it('re-encodes a PNG at most 600 pixels wide, and leaves its metadata behind', async () => {
    const input = pngOf(1200, 300, [
      chunk('tEXt', Buffer.from('Author\u0000Mila Petrovic, GPS 44.81 20.46', 'latin1')),
    ]);
    expect(input.toString('latin1')).toContain('GPS 44.81');
    const output = await processEmailImage(input);
    expect(output).toEqual(expect.objectContaining({ type: 'png', width: 600, height: 150 }));
    expect(output.bytes.toString('latin1')).not.toContain('GPS');
    expect(output.bytes.toString('latin1')).not.toContain('tEXt');
    expect(output.bytes.length).toBeLessThanOrEqual(OUTPUT_MAX_BYTES);
  });

  it('re-encodes a JPEG as a JPEG without its EXIF block', async () => {
    const input = jpegOf(800, 400, 'GPS camera serial 12345');
    const output = await processEmailImage(input);
    expect(output).toEqual(expect.objectContaining({ type: 'jpeg', width: 600, height: 300 }));
    expect(output.bytes.toString('latin1')).not.toContain('camera serial');
  });

  it('makes a GIF a PNG of its first frame', async () => {
    const output = await processEmailImage(gifOf(40, 20, 3));
    expect(output).toEqual(expect.objectContaining({ type: 'png', width: 40, height: 20 }));
  });

  it.each([
    ['an SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')],
    ['a text named .png', Buffer.from('this is not an image at all')],
    [
      'a WebP',
      Buffer.concat([
        Buffer.from('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ', 'latin1'),
        Buffer.alloc(32),
      ]),
    ],
    ['an HTML page', Buffer.from('<!doctype html><script>alert(1)</script>')],
    ['a PDF', Buffer.from('%PDF-1.7\n')],
  ])('refuses %s by its content', async (_name, bytes) => {
    expect(await refusal(processEmailImage(bytes))).toBe('image_type_refused');
  });

  it('ST-67: refuses a pixel bomb from its header, before any decode, at once', async () => {
    const started = performance.now();
    expect(await refusal(processEmailImage(pixelBomb(30_000)))).toBe('image_too_many_pixels');
    expect(performance.now() - started).toBeLessThan(100);
    expect(() => readHeader(pixelBomb(4_001 + Math.ceil(Math.sqrt(MAX_PIXELS))))).toThrow(
      ImageError,
    );
    expect(await refusal(processEmailImage(gifOf(4, 4, 101)))).toBe('image_too_many_pixels');
  });

  it('ST-67, SEC-M4-01: a GIF whose small screen hides an oversized frame is refused before any decode', async () => {
    const cases = [
      gifWithFrame({ w: 1, h: 1 }, { w: 65_535, h: 65_535 }),
      gifWithFrame({ w: 10, h: 10 }, { w: 11, h: 10 }),
      gifWithFrame({ w: 10, h: 10 }, { w: 10, h: 10, top: 1 }),
      gifWithFrame({ w: 8_000, h: 2_000 }, { w: 8_000, h: 2_001 }),
    ];
    for (const bytes of cases) {
      const started = performance.now();
      expect(() => readHeader(bytes)).toThrow(ImageError);
      expect(await refusal(processEmailImage(bytes))).toBe('image_too_many_pixels');
      expect(performance.now() - started).toBeLessThan(100);
    }
    // A frame that fits its screen is decoded as before.
    expect(readHeader(gifWithFrame({ w: 10, h: 10 }, { w: 1, h: 1, left: 9, top: 9 })).frames).toBe(
      1,
    );
  });

  it('ST-67, SEC-M4-01: the worker checks the first frame itself before it allocates anything', async () => {
    // Past the header check (as a header that lied would be): the worker refuses, at once.
    const bytes = gifWithFrame({ w: 1, h: 1 }, { w: 65_535, h: 65_535 });
    const started = performance.now();
    const outcome = await reencode(bytes, { type: 'gif', width: 1, height: 1, frames: 1 }).then(
      () => 'accepted',
      (error: unknown) => (error instanceof ImageError ? error.code : 'other'),
    );
    expect(outcome).toBe('image_too_many_pixels');
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it('ST-67: a malformed image ends in bounded time as unreadable', async () => {
    const valid = pngOf(64, 64);
    const cases = [
      valid.subarray(0, 60),
      Buffer.concat([valid.subarray(0, 41), Buffer.alloc(200, 0xab)]),
      jpegOf(64, 64).subarray(0, 300),
      Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x40, 0x03]),
      Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([8, 0, 8, 0, 0, 0, 0, 0x2c])]),
    ];
    for (const bytes of cases) {
      const started = performance.now();
      expect(await refusal(processEmailImage(bytes))).toBe('image_unreadable');
      expect(performance.now() - started).toBeLessThan(6_000);
    }
  });

  it('ST-67: a compression bomb inside the limits ends in bounded time, whatever it holds', async () => {
    // 100 x 100 pixels claimed, 64 MB of zeros behind them in 64 KB of file.
    const bomb = pixelBomb(100, 64 * 1024 * 1024);
    expect(bomb.length).toBeLessThan(200 * 1024);
    const started = performance.now();
    const outcome = await refusal(processEmailImage(bomb));
    expect(['image_unreadable', 'accepted']).toContain(outcome);
    expect(performance.now() - started).toBeLessThan(6_000);
  });

  it('ST-67: a decode beyond its time is ended, and the process goes on meanwhile', async () => {
    // A large image that compresses well: a short file, a long decode.
    const side = 2_000;
    const big = pixelBomb(side, (side * 4 + 1) * side);
    const small = pngOf(800, 300);
    expect(big.length).toBeLessThan(5 * 1024 * 1024);
    let ticks = 0;
    let longest = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
      ticks += 1;
    }, 10);
    try {
      expect(await refusal(processEmailImage(big, { timeoutMs: 50 }))).toBe('image_unreadable');
      // The worker of a later image starts afresh.
      const output = await processEmailImage(small);
      expect(output.width).toBe(600);
    } finally {
      clearInterval(timer);
    }
    // The event loop of the API was never held for long: the decoding ran elsewhere.
    expect(ticks).toBeGreaterThan(5);
    expect(longest).toBeLessThan(1_000);
  });
});
