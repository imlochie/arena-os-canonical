import assert from "node:assert/strict";
import { test } from "node:test";
import { Chip8Runtime, CHIP8_MAX_ROM_BYTES, chip8DialectForFile, type Chip8Dialect } from "./chip8Runtime";

const program = (...words: number[]) => Uint8Array.from(words.flatMap(word => [word >> 8, word & 255]));
const machine = (words: number[], dialect: Chip8Dialect = "schip") => new Chip8Runtime(program(...words), undefined, dialect);
const run = (runtime: Chip8Runtime, count: number) => { for (let i = 0; i < count; i++) runtime.step(); };

test("extensions identify Super-CHIP explicitly, while legacy filenames default to classic", () => {
  assert.equal(chip8DialectForFile("demo.SC8"), "schip");
  assert.equal(chip8DialectForFile("demo.sch8"), "schip");
  assert.equal(chip8DialectForFile("demo.ch8"), "chip8");
  assert.equal(chip8DialectForFile("demo.c8", "schip"), "schip");
  assert.equal(chip8DialectForFile("demo.exe", "schip"), null);
  assert.throws(() => new Chip8Runtime(new Uint8Array(CHIP8_MAX_ROM_BYTES + 1), undefined, "schip"), /between/);
  assert.throws(() => new Chip8Runtime(new Uint8Array(3)), /even-sized/);
  const odd = new Chip8Runtime(Uint8Array.of(0, 0xfd, 0x99), undefined, "schip");
  odd.step();
  assert.equal(odd.halted, true, "sprite/data bytes need not make a ROM's total length even");
});

test("mode switches expose 128×64 and 64×32, clearing old pixels", () => {
  const r = machine([0x00ff, 0x00fe, 0x00ff]);
  assert.equal(r.width, 64);
  r.step();
  assert.deepEqual([r.width, r.height], [128, 64]);
  r.display[8191] = 1;
  r.step();
  assert.deepEqual([r.width, r.height], [64, 32]);
  assert.equal(r.display.some(Boolean), false);
  r.step();
  assert.equal(r.display.some(Boolean), false);
});

test("16×16 sprites draw both bytes per row in both modes, XOR and flag collisions", () => {
  for (const hires of [false, true]) {
    const r = machine([hires ? 0x00ff : 0x00fe, 0xa300, 0xd010, 0xd010]);
    r.memory.fill(255, 0x300, 0x320);
    run(r, 3);
    assert.equal(r.display.reduce((a, b) => a + b, 0), 256);
    assert.equal(r.display[15 * r.width + 15], 1);
    assert.equal(r.registers[15], 0);
    r.step();
    assert.equal(r.display.some(Boolean), false);
    assert.equal(r.registers[15], 1);
  }
});

test("Super-CHIP clips at screen edges; classic CHIP-8 still wraps", () => {
  const modern = machine([0x00ff, 0xafff, 0xd011]);
  modern.registers[0] = 127; modern.registers[1] = 63;
  modern.memory[0xfff] = 255;
  run(modern, 3);
  assert.equal(modern.display.reduce((a, b) => a + b, 0), 1);
  const classic = machine([0xafff, 0xd011], "chip8");
  classic.registers[0] = 63; classic.registers[1] = 31;
  classic.memory[0xfff] = 255;
  run(classic, 2);
  assert.equal(classic.display.reduce((a, b) => a + b, 0), 8);
  assert.equal(classic.display[31 * 64], 1);
  const overflow = machine([0xafe1, 0xd010]);
  overflow.step();
  assert.throws(() => overflow.step(), /sprite data/);
});

test("scrolls shift four logical pixels sideways, n down, and zero-fill rather than wrap", () => {
  for (const mode of [0x00fe, 0x00ff]) {
    const r = machine([mode, 0x00fb, 0x00fc, 0x00c2, 0x00c0]);
    r.step();
    r.display[0] = 1;
    r.display[r.width - 1] = 1;
    r.step();
    assert.equal(r.display[4], 1);
    assert.equal(r.display.reduce((a, b) => a + b, 0), 1);
    r.step();
    assert.equal(r.display[0], 1);
    r.step();
    assert.equal(r.display[2 * r.width], 1);
    assert.equal(r.display[0], 0);
    const before = Array.from(r.display);
    r.step();
    assert.deepEqual(Array.from(r.display), before);
  }
});

test("large hexadecimal font provides sixteen 8×10 glyphs", () => {
  const r = machine([0x60fa, 0xf030, 0xd01a]);
  run(r, 2);
  assert.equal(r.index, 80 + 10 * 10);
  assert.equal(r.memory[r.index], r.memory[r.index + 1]);
  r.step();
  assert.ok(r.display.some(Boolean));
});

test("Super-CHIP shifts Vx; classic still shifts Vy", () => {
  for (const dialect of ["chip8", "schip"] as const) {
    const r = machine([0x6003, 0x6108, 0x8016, 0x801e], dialect);
    run(r, 3);
    assert.equal(r.registers[0], dialect === "schip" ? 1 : 4);
    assert.equal(r.registers[15], dialect === "schip" ? 1 : 0);
    r.step();
    assert.equal(r.registers[0], dialect === "schip" ? 2 : 16);
  }
});

test("Super-CHIP transfers leave I unchanged; classic still increments it", () => {
  for (const dialect of ["chip8", "schip"] as const) {
    const r = machine([0xa300, 0x6009, 0x6107, 0xf155, 0xa300, 0x6000, 0x6100, 0xf165], dialect);
    run(r, 4);
    assert.equal(r.index, dialect === "schip" ? 0x300 : 0x302);
    assert.deepEqual(Array.from(r.memory.slice(0x300, 0x302)), [9, 7]);
    run(r, 4);
    assert.deepEqual(Array.from(r.registers.slice(0, 2)), [9, 7]);
    assert.equal(r.index, dialect === "schip" ? 0x300 : 0x302);
  }
});

test("dialects use their own jump offsets and Super-CHIP keeps arithmetic VF last", () => {
  for (const dialect of ["chip8", "schip"] as const) {
    const r = machine([0xb234], dialect);
    r.registers[0] = 3; r.registers[2] = 7;
    r.step();
    assert.equal(r.pc, dialect === "schip" ? 0x23b : 0x237);
  }
  const r = machine([0x8f14]);
  r.registers[15] = 255; r.registers[1] = 2;
  r.step();
  assert.equal(r.registers[15], 1);
});

test("RPL flags, mode, pixels, timer and input wait survive versioned save/reload", () => {
  const rom = program(0x00ff, 0x6009, 0xf075, 0x6000, 0xf085, 0xf10a, 0x00fd);
  const r = new Chip8Runtime(rom, undefined, "schip");
  run(r, 5);
  assert.equal(r.registers[0], 9);
  r.display[8191] = 1;
  r.delayTimer = 12;
  r.setKey(2, true);
  r.step();
  const saved = JSON.parse(JSON.stringify(r.snapshot()));
  const restored = new Chip8Runtime(rom, saved, "schip");
  assert.equal(restored.width, 128);
  assert.equal(restored.display[8191], 1);
  assert.equal(restored.rpl[0], 9);
  assert.equal(restored.delayTimer, 12);
  restored.step();
  assert.equal(restored.registers[1], 2);
  restored.step();
  assert.equal(restored.halted, true);
  const exited = new Chip8Runtime(rom, restored.snapshot(), "schip");
  exited.step();
  assert.equal(exited.halted, true);
  assert.equal(exited.pc, restored.pc);
  assert.throws(() => new Chip8Runtime(rom, saved, "chip8"), /saved CHIP-8 progress/);
  assert.throws(() => new Chip8Runtime(rom, { ...saved, rpl: [999] }, "schip"), /saved CHIP-8 progress/);
  assert.throws(() => new Chip8Runtime(rom, { ...saved, display: saved.display.map(() => 2) }, "schip"), /saved CHIP-8 progress/);
  const badFlags = machine([0xf875]);
  assert.throws(() => badFlags.step(), /eight RPL flags/);
});

test("key-release wait accepts one input rather than repeating a held key", () => {
  const r = machine([0xf00a, 0x6107]);
  r.step();
  assert.equal(r.pc, 0x200);
  r.setKey(12, true);
  run(r, 5);
  assert.equal(r.pc, 0x200);
  r.setKey(12, false);
  r.step();
  assert.equal(r.registers[0], 12);
  r.step();
  assert.equal(r.registers[1], 7);
});

test("classic snapshots retain version 1 and all Super-CHIP-only instructions remain explicit refusals", () => {
  const rom = program(0x600a, 0xf029, 0xd015, 0x1206);
  const r = new Chip8Runtime(rom);
  run(r, 3);
  const saved = r.snapshot();
  assert.equal(saved.version, 1);
  assert.equal("dialect" in saved, false);
  const restored = new Chip8Runtime(rom, JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(restored.snapshot(), saved);
  for (const opcode of [0x00ff, 0x00fe, 0x00fb, 0x00fc, 0x00c1, 0x00fd, 0xf030, 0xf075, 0xf085]) {
    const classic = machine([opcode], "chip8");
    assert.throws(() => classic.step(), /Unsupported classic CHIP-8/);
  }
});
