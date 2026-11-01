// Original MIT-licensed 8086 DOS .COM game generator, not an emulator.
// Reproducible machine code; DOS interrupt services provide console/file I/O.
export function buildDosCoin() {
  const code = [], labels = new Map(), fixups = [];
  const emit = (...b) => code.push(...b);
  const word = n => emit(n & 255, (n >> 8) & 255);
  const label = n => labels.set(n, code.length);
  const address = n => { fixups.push({ offset: code.length, label: n, absolute: true }); word(0); };
  const jump = (n, opcode = 0xE9) => { emit(opcode); fixups.push({ offset: code.length, label: n }); word(0); };
  // 8086 has short conditional jumps: invert the condition over a near jump.
  const branch = (opcode, n) => { emit(opcode ^ 1, 3); jump(n); };
  const dx = n => { emit(0xBA); address(n); };
  const dos = ah => emit(0xB4, ah, 0xCD, 0x21);
  const print = n => { dx(n); dos(9); };
  const loadAl = n => { emit(0xA0); address(n); };
  const storeAl = n => { emit(0xA2); address(n); };
  const byteOp = (n, op) => { emit(0xFE, op); address(n); };
  const digit = n => { loadAl(n); emit(0x04, 48, 0x88, 0xC2); dos(2); };
  jump("load", 0xE8);
  print("title");
  label("render"); print("status"); digit("score"); print("position"); digit("player"); print("newline");
  label("key"); dos(8); emit(0x0C, 0x20); // fold ASCII letters to lowercase
  emit(0x3C, 113); branch(0x74, "quit");
  emit(0x3C, 32); branch(0x74, "collect");
  emit(0x3C, 97); branch(0x74, "left");
  emit(0x3C, 100); branch(0x74, "right"); jump("key");
  label("left"); loadAl("player"); emit(0x3C, 0); branch(0x74, "render"); byteOp("player", 0x0E); jump("render");
  label("right"); loadAl("player"); emit(0x3C, 9); branch(0x74, "render"); byteOp("player", 0x06); jump("render");
  label("collect"); loadAl("score"); emit(0x3C, 9); branch(0x73, "render");
  byteOp("score", 0x06); emit(0xB2, 7); dos(2); jump("save", 0xE8); jump("render");
  label("quit"); jump("save", 0xE8); emit(0xB8, 0, 0x4C, 0xCD, 0x21);
  label("load"); dx("filename"); emit(0xB8, 0, 0x3D, 0xCD, 0x21); branch(0x72, "loadend");
  emit(0x89, 0xC3, 0xB9, 2, 0); dx("score"); dos(0x3F); dos(0x3E);
  loadAl("score"); emit(0x3C, 9); branch(0x76, "checkplayer"); emit(0xB0, 0); storeAl("score");
  label("checkplayer"); loadAl("player"); emit(0x3C, 9); branch(0x76, "loadend"); emit(0xB0, 0); storeAl("player");
  label("loadend"); emit(0xC3);
  label("save"); dx("filename"); emit(0x31, 0xC9); dos(0x3C); branch(0x72, "saveerror");
  emit(0x89, 0xC3, 0xB9, 2, 0); dx("score"); dos(0x40); branch(0x72, "writeerror");
  emit(0x3D, 2, 0); branch(0x75, "writeerror"); dos(0x3E); emit(0xC3);
  label("writeerror"); dos(0x3E);
  label("saveerror"); print("error"); emit(0xC3);
  for (const [name, text] of [
    ["title", "ARENA COIN COUNTER - original MIT homebrew\r\nA/D move; Space collects (goal 9); Q saves and quits.\r\n$"],
    ["status", "Coins: $"], ["position", "/9  Position: $"], ["newline", "\r\n$"],
    ["error", "\r\nSAVE FAILED. Check the writable C: profile.\r\n$"], ["filename", "PROGRESS.SAV\0"],
  ]) { label(name); emit(...Buffer.from(text, "ascii")); }
  label("score"); emit(0); label("player"); emit(0);
  for (const f of fixups) {
    if (!labels.has(f.label)) throw new Error("Unresolved original DOS fixture label.");
    const n = f.absolute ? labels.get(f.label) + 0x100 : labels.get(f.label) - f.offset - 2;
    code[f.offset] = n & 255; code[f.offset + 1] = (n >> 8) & 255;
  }
  if (code.length > 0xFF00) throw new Error("COM fixture exceeds its segment.");
  return Buffer.from(code);
}
