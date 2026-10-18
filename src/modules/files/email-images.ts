import { Worker } from 'node:worker_threads';

/**
 * Email images (M4-BE-06; ADR-10, ADR-12; ST-60, ST-67): an image an admin uploads for the
 * templates is a private file of its own kind, re-encoded on the server.
 *
 * - **Type by content**: PNG, JPEG or GIF by their signatures; SVG, WebP, a text renamed
 *   `.png`, anything else is refused before anything is decoded.
 * - **Size from the header, before any decode**: at most 8,000 pixels a side and 16
 *   megapixels; an animated GIF at most 100 frames. A pixel bomb (a small file that claims
 *   30,000 x 30,000 pixels) ends here, in microseconds and without memory.
 * - **Decoded in a worker thread of its own**, with a time limit (5 s) and a heap limit,
 *   with pure JavaScript decoders (no native code beside the keys, SEC-A-52): only the PNG,
 *   JPEG and GIF decoders exist. A malformed image ends the worker with an error, a slow one
 *   is terminated; the API and the other jobs go on meanwhile.
 * - **Re-encoded** at most 600 pixels wide: a PNG or a GIF (its first frame) as PNG, a JPEG
 *   as JPEG; the new file holds pixels only, so every metadata block of the upload is gone.
 *   A result above 200 KB is made a JPEG of lower quality, or refused.
 */
export type ImageType = 'png' | 'jpeg' | 'gif';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_SIDE = 8_000;
export const MAX_PIXELS = 16_000_000;
export const MAX_GIF_FRAMES = 100;
export const OUTPUT_MAX_WIDTH = 600;
export const OUTPUT_MAX_BYTES = 200 * 1024;
export const DECODE_TIMEOUT_MS = 5_000;
/** The heap of the decoding worker; the pixel buffers are bounded by the header check. */
const WORKER_HEAP_MB = 96;

export type ImageRefusal =
  /** Not a PNG, JPEG or GIF by its content (an SVG, a renamed file, ...). */
  | 'image_type_refused'
  /** The header claims more pixels or frames than allowed: refused without decoding. */
  | 'image_too_many_pixels'
  /** Broken, truncated, or not decodable within the time limit. */
  | 'image_unreadable'
  /** Above 200 KB even after re-encoding. */
  | 'image_too_large';

export class ImageError extends Error {
  constructor(readonly code: ImageRefusal) {
    super(code);
    this.name = 'ImageError';
  }
}

export interface ImageHeader {
  readonly type: ImageType;
  readonly width: number;
  readonly height: number;
  /** GIF only: the frames the file holds (counted from its blocks, nothing decoded). */
  readonly frames: number;
}

export interface EncodedImage {
  readonly type: 'png' | 'jpeg';
  readonly width: number;
  readonly height: number;
  readonly bytes: Buffer;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The frames of a GIF, by walking its blocks; -1 when the structure is broken. */
function gifFrames(bytes: Buffer): number {
  let at = 13;
  const flags = bytes[10] ?? 0;
  if ((flags & 0x80) !== 0) {
    at += 3 * 2 ** ((flags & 0x07) + 1);
  }
  let frames = 0;
  while (at < bytes.length) {
    const block = bytes[at];
    if (block === 0x3b) {
      return frames;
    }
    if (block === 0x21) {
      // An extension: its label, then sub-blocks until a zero length.
      at += 2;
    } else if (block === 0x2c) {
      frames += 1;
      if (frames > MAX_GIF_FRAMES) {
        return frames;
      }
      const local = bytes[at + 9] ?? 0;
      at += 10;
      if ((local & 0x80) !== 0) {
        at += 3 * 2 ** ((local & 0x07) + 1);
      }
      at += 1; // the minimum code size of the LZW data
    } else {
      return -1;
    }
    for (;;) {
      const size = bytes[at];
      if (size === undefined) {
        return -1;
      }
      at += 1 + size;
      if (size === 0) {
        break;
      }
    }
  }
  return frames;
}

/** The JPEG frame header: walks the markers to the first SOFn. Null when there is none. */
function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  let at = 2;
  while (at + 9 < bytes.length) {
    if (bytes[at] !== 0xff) {
      return null;
    }
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    const length = bytes.readUInt16BE(at + 2);
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    if (marker === 0xd9 || marker === 0xda || length < 2) {
      return null;
    }
    at += 2 + length;
  }
  return null;
}

/** The type and size of an image from its header alone, or a refusal. Decodes nothing. */
export function readHeader(bytes: Buffer): ImageHeader {
  let header: ImageHeader | null = null;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    if (bytes.toString('latin1', 12, 16) !== 'IHDR') {
      throw new ImageError('image_unreadable');
    }
    header = {
      type: 'png',
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
      frames: 1,
    };
  } else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    const size = jpegSize(bytes);
    if (size === null) {
      throw new ImageError('image_unreadable');
    }
    header = { type: 'jpeg', ...size, frames: 1 };
  } else if (
    bytes.length >= 13 &&
    (bytes.toString('latin1', 0, 6) === 'GIF87a' || bytes.toString('latin1', 0, 6) === 'GIF89a')
  ) {
    const frames = gifFrames(bytes);
    if (frames < 1) {
      throw new ImageError('image_unreadable');
    }
    header = { type: 'gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), frames };
  }
  if (header === null) {
    throw new ImageError('image_type_refused');
  }
  if (header.width < 1 || header.height < 1) {
    throw new ImageError('image_unreadable');
  }
  if (
    header.width > MAX_SIDE ||
    header.height > MAX_SIDE ||
    header.width * header.height > MAX_PIXELS ||
    header.frames > MAX_GIF_FRAMES
  ) {
    throw new ImageError('image_too_many_pixels');
  }
  return header;
}

/**
 * The code of the worker: decode, scale down by area averaging, encode. Plain JavaScript,
 * run with `eval`, so that it is the same in the build and in the tests; the decoders are
 * the modules whose paths the parent resolved.
 */
const WORKER_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
const { PNG } = require(workerData.modules.pngjs);
const jpeg = require(workerData.modules.jpeg);
const { GifReader } = require(workerData.modules.gif);
const { type, maxWidth, maxBytes, maxPixels } = workerData;
const input = Buffer.from(workerData.bytes);

function decode() {
  if (type === 'png') {
    const png = PNG.sync.read(input, { checkCRC: true });
    return { width: png.width, height: png.height, data: png.data };
  }
  if (type === 'jpeg') {
    const image = jpeg.decode(input, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: maxPixels / 1e6,
      maxMemoryUsageInMB: 128,
      tolerantDecoding: false,
    });
    return { width: image.width, height: image.height, data: image.data };
  }
  const reader = new GifReader(new Uint8Array(input));
  const data = new Uint8Array(reader.width * reader.height * 4);
  reader.decodeAndBlitFrameRGBA(0, data);
  return { width: reader.width, height: reader.height, data };
}

function scale(image) {
  if (image.width <= maxWidth) return image;
  const width = maxWidth;
  const height = Math.max(1, Math.round((image.height * width) / image.width));
  const out = new Uint8Array(width * height * 4);
  const fx = image.width / width;
  const fy = image.height / height;
  for (let y = 0; y < height; y += 1) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < width; x += 1) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const i = (sy * image.width + sx) * 4;
          r += image.data[i]; g += image.data[i + 1]; b += image.data[i + 2]; a += image.data[i + 3];
          n += 1;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { width, height, data: out };
}

function encodePng(image) {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data.buffer, image.data.byteOffset, image.data.byteLength);
  return PNG.sync.write(png, { colorType: 6 });
}

function encodeJpeg(image, quality) {
  // A JPEG has no transparency: transparent pixels are laid on white.
  const data = Buffer.alloc(image.width * image.height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const alpha = image.data[i + 3] / 255;
    data[i] = image.data[i] * alpha + 255 * (1 - alpha);
    data[i + 1] = image.data[i + 1] * alpha + 255 * (1 - alpha);
    data[i + 2] = image.data[i + 2] * alpha + 255 * (1 - alpha);
    data[i + 3] = 255;
  }
  return jpeg.encode({ data, width: image.width, height: image.height }, quality).data;
}

try {
  const image = scale(decode());
  let result = null;
  if (type !== 'jpeg') {
    const png = encodePng(image);
    if (png.length <= maxBytes) result = { type: 'png', bytes: png };
  }
  for (const quality of [85, 70, 55]) {
    if (result !== null) break;
    const encoded = encodeJpeg(image, quality);
    if (encoded.length <= maxBytes) result = { type: 'jpeg', bytes: encoded };
  }
  if (result === null) {
    parentPort.postMessage({ refusal: 'image_too_large' });
  } else {
    parentPort.postMessage({ type: result.type, width: image.width, height: image.height, bytes: result.bytes });
  }
} catch (error) {
  parentPort.postMessage({ refusal: 'image_unreadable' });
}
`;

/** The decoders, resolved by the parent: the worker loads exactly these files. */
function decoderModules(): { pngjs: string; jpeg: string; gif: string } {
  return {
    pngjs: require.resolve('pngjs'),
    jpeg: require.resolve('jpeg-js'),
    gif: require.resolve('omggif'),
  };
}

/**
 * Decodes, scales and encodes an image in a worker thread of its own, within the time limit
 * (ST-67). The header has been checked; anything the worker cannot do ends as a refusal.
 */
export function reencode(
  bytes: Buffer,
  header: ImageHeader,
  options: { timeoutMs?: number } = {},
): Promise<EncodedImage> {
  return new Promise<EncodedImage>((resolve, reject) => {
    const worker = new Worker(WORKER_CODE, {
      eval: true,
      workerData: {
        modules: decoderModules(),
        type: header.type,
        bytes,
        maxWidth: OUTPUT_MAX_WIDTH,
        maxBytes: OUTPUT_MAX_BYTES,
        maxPixels: MAX_PIXELS,
      },
      // No environment: the worker has nothing of the parent's (no key, no address).
      env: {},
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB, maxYoungGenerationSizeMb: 16 },
      stdout: true,
      stderr: true,
    });
    let settled = false;
    const finish = (outcome: () => void): void => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        outcome();
      }
    };
    const timer = setTimeout(() => {
      finish(() => {
        reject(new ImageError('image_unreadable'));
      });
    }, options.timeoutMs ?? DECODE_TIMEOUT_MS);
    worker.once(
      'message',
      (message: {
        refusal?: ImageRefusal;
        type?: 'png' | 'jpeg';
        width?: number;
        height?: number;
        bytes?: Uint8Array;
      }) => {
        finish(() => {
          if (
            message.refusal !== undefined ||
            message.type === undefined ||
            message.bytes === undefined
          ) {
            reject(new ImageError(message.refusal ?? 'image_unreadable'));
            return;
          }
          resolve({
            type: message.type,
            width: message.width ?? 0,
            height: message.height ?? 0,
            bytes: Buffer.from(message.bytes),
          });
        });
      },
    );
    worker.once('error', () => {
      finish(() => {
        reject(new ImageError('image_unreadable'));
      });
    });
    worker.once('exit', () => {
      finish(() => {
        reject(new ImageError('image_unreadable'));
      });
    });
  });
}

/** The whole of it: the header first, then the worker. */
export async function processEmailImage(
  bytes: Buffer,
  options: { timeoutMs?: number } = {},
): Promise<EncodedImage> {
  if (bytes.length > MAX_UPLOAD_BYTES) {
    throw new ImageError('image_too_large');
  }
  const header = readHeader(bytes);
  const encoded = await reencode(bytes, header, options);
  // The result is read again as any upload would be: what is stored is what it says.
  const check = readHeader(encoded.bytes);
  if (check.type !== encoded.type || check.width !== encoded.width) {
    throw new ImageError('image_unreadable');
  }
  return encoded;
}
