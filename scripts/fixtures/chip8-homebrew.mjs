// Original, generated programs only. No downloaded/proprietary game bytes.
export function classicFixture() {
  // Wait for keypad input, draw that key's small glyph, and retain the image.
  return Buffer.from([0xf0, 0x0a, 0xf0, 0x29, 0x61, 0, 0x62, 0, 0xd1, 0x25, 0x12, 0x0a]);
}

export function superChipFixture() {
  const bytes = Buffer.alloc(0x80);
  const words = [
    0x662a, 0xf675, 0x00ff, 0x6004, 0x6104, 0xa260, 0xd010,
    0xf20a, 0x4202, 0x00fb, 0x4204, 0x00fc, 0x4208, 0x00c2,
    0x4200, 0x2230, 0x4201, 0x2236, 0x420f, 0x00fd, 0x120e,
  ];
  words.forEach((word, i) => bytes.writeUInt16BE(word, i * 2));
  [0x00fe, 0xd010, 0x00ee, 0x00ff, 0xd010, 0x00ee]
    .forEach((word, i) => bytes.writeUInt16BE(word, 0x30 + i * 2));
  for (let row = 0; row < 16; row++) bytes.writeUInt16BE(row === 0 || row === 15 ? 0xffff : 0x8001, 0x60 + row * 2);
  return bytes;
}
