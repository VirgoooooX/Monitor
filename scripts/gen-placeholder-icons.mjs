// Generate minimal placeholder icons for development/packaging.
// Run: node scripts/gen-placeholder-icons.mjs
//
// Creates:
//   build/icon.ico       — 256x256 ICO (blue square) for electron-builder
//   build/tray-icon.png  — 16x16 PNG (blue square) for system tray

import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createDeflateRaw } from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const buildDir = resolve(__dirname, '..', 'build');

// CRC-32 for PNG chunks
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[n] = c;
}
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function createPng(width, height, r, g, b) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // Raw scanlines
  const rowSize = 1 + width * 4;
  const raw = Buffer.alloc(height * rowSize);
  for (let y = 0; y < height; y++) {
    raw[y * rowSize] = 0; // filter: None
    for (let x = 0; x < width; x++) {
      const dst = y * rowSize + 1 + x * 4;
      raw[dst + 0] = r;
      raw[dst + 1] = g;
      raw[dst + 2] = b;
      raw[dst + 3] = 0xFF;
    }
  }

  return new Promise((resolve) => {
    const deflate = createDeflateRaw();
    const chunks = [];
    deflate.on('data', (c) => chunks.push(c));
    deflate.on('end', () => {
      const compressed = Buffer.concat(chunks);

      function makeChunk(type, data) {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length, 0);
        const typeB = Buffer.from(type, 'ascii');
        const crcInput = Buffer.concat([typeB, data]);
        const crcB = Buffer.alloc(4);
        crcB.writeUInt32BE(crc32(crcInput) >>> 0, 0);
        return Buffer.concat([len, typeB, data, crcB]);
      }

      const ihdrChunk = makeChunk('IHDR', ihdr);
      const idatChunk = makeChunk('IDAT', compressed);
      const iendChunk = makeChunk('IEND', Buffer.alloc(0));

      resolve(Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]));
    });
    deflate.end(raw);
  });
}

// ICO file with a single PNG-embedded frame (modern ICO format).
// Windows Vista+ supports PNG-compressed ICO entries, which avoids
// needing to write raw BMP data for large sizes.
function createPngIco(pngBuffer, width, height) {
  // ICO header: 6 bytes
  // Directory entry: 16 bytes
  // Then the raw PNG data
  const header = Buffer.alloc(6 + 16);
  let o = 0;
  header.writeUInt16LE(0, o); o += 2; // reserved
  header.writeUInt16LE(1, o); o += 2; // type: ICO
  header.writeUInt16LE(1, o); o += 2; // image count

  // Directory entry
  // For sizes >= 256, the width/height fields are set to 0
  header.writeUInt8(width >= 256 ? 0 : width, o); o += 1;
  header.writeUInt8(height >= 256 ? 0 : height, o); o += 1;
  header.writeUInt8(0, o); o += 1;       // palette
  header.writeUInt8(0, o); o += 1;       // reserved
  header.writeUInt16LE(1, o); o += 2;    // color planes
  header.writeUInt16LE(32, o); o += 2;   // bits per pixel
  header.writeUInt32LE(pngBuffer.length, o); o += 4; // size of PNG data
  header.writeUInt32LE(6 + 16, o); o += 4;          // offset to PNG data

  return Buffer.concat([header, pngBuffer]);
}

// Generate 256x256 icon (R=0x33, G=0x99, B=0xEE — a pleasant blue)
const png256 = await createPng(256, 256, 0xEE, 0x99, 0x33);
const ico = createPngIco(png256, 256, 256);
writeFileSync(resolve(buildDir, 'icon.ico'), ico);

// Generate 16x16 tray icon
const png16 = await createPng(16, 16, 0xEE, 0x99, 0x33);
writeFileSync(resolve(buildDir, 'tray-icon.png'), png16);

console.log('✓ build/icon.ico (256×256 placeholder)');
console.log('✓ build/tray-icon.png (16×16 placeholder)');
