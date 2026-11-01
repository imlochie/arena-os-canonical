import assert from "node:assert/strict";
import { test } from "node:test";
import { Chip8Runtime } from "./chip8Runtime";
import { createChip8ProgressBackup, inspectChip8ProgressBackup, validateChip8Progress, chip8StateKey, MAX_CHIP8_BACKUP_BYTES, type Chip8ProgressTarget } from "./chip8ProgressBackup";

const program = new Uint8Array([0xc0, 0xff, 0x12, 0x00]);
const target: Chip8ProgressTarget = { gameId: "original", name: "original.ch8", rom: program.buffer, dialect: "chip8" };
async function fixture() {
  const runtime = new Chip8Runtime(program);
  runtime.step();
  return { runtime, backup: await createChip8ProgressBackup(target, runtime.snapshot()) };
}
test("classic snapshot round-trips locally with ROM fingerprint and compatible version", async () => {
  const { runtime, backup } = await fixture();
  const inspected = await inspectChip8ProgressBackup(JSON.stringify(backup), target);
  assert.equal(inspected.sameIdentity, true);
  assert.equal(backup.runtimeVersion, 1);
  assert.match(backup.romSha256, /^[a-f0-9]{64}$/);
  const restored = new Chip8Runtime(program, inspected.backup.snapshot);
  for (let i = 0; i < 20; i++) {
    runtime.step(); restored.step();
    assert.deepEqual(restored.registers, runtime.registers, "random sequence must resume, not restart");
  }
});
test("new imported identity is eligible only for the same ROM and profile", async () => {
  const { backup } = await fixture();
  assert.equal((await inspectChip8ProgressBackup(JSON.stringify(backup), { ...target, gameId: "copy" })).sameIdentity, false);
  await assert.rejects(inspectChip8ProgressBackup(JSON.stringify(backup), { ...target, rom: new Uint8Array([0x60, 0]).buffer }), /different program/);
  await assert.rejects(inspectChip8ProgressBackup(JSON.stringify(backup), { ...target, dialect: "schip" }), /runtime profile/);
});
test("Super-CHIP retains high resolution, RPL flags, display and halt state", async () => {
  const rom = new Uint8Array([0x00, 0xff, 0x00, 0xfd]);
  const extended: Chip8ProgressTarget = { ...target, rom: rom.buffer, dialect: "schip" };
  const runtime = new Chip8Runtime(rom, undefined, "schip");
  runtime.step(); runtime.step();
  runtime.rpl[4] = 91; runtime.display[7000] = 1;
  const backup = await createChip8ProgressBackup(extended, runtime.snapshot());
  const restored = new Chip8Runtime(rom, (await inspectChip8ProgressBackup(JSON.stringify(backup), extended)).backup.snapshot, "schip");
  assert.equal(backup.runtimeVersion, 2);
  assert.equal(restored.highResolution, true);
  assert.equal(restored.halted, true);
  assert.equal(restored.rpl[4], 91);
  assert.equal(restored.display[7000], 1);
  assert.notEqual(chip8StateKey("same", "chip8"), chip8StateKey("same", "schip"));
});
test("Super-CHIP waiting-key continuation is preserved without copying a held host key", async () => {
  const rom = new Uint8Array([0xf0, 0x0a, 0x00, 0xfd]);
  const extended: Chip8ProgressTarget = { ...target, rom: rom.buffer, dialect: "schip" };
  const runtime = new Chip8Runtime(rom, undefined, "schip");
  runtime.setKey(5, true); runtime.step();
  const backup = await createChip8ProgressBackup(extended, runtime.snapshot());
  const restored = new Chip8Runtime(rom, backup.snapshot, "schip");
  assert.equal(restored.keys[5], 0);
  restored.step();
  assert.equal(restored.registers[0], 5);
});
test("malformed or unsupported snapshots are rejected before changing the running machine", async () => {
  const { runtime, backup } = await fixture();
  const unchanged = runtime.snapshot();
  for (const text of ["bad JSON", "null", "[]", JSON.stringify({ ...backup, version: 2 }),
    JSON.stringify({ ...backup, runtimeVersion: 99 }), JSON.stringify({ ...backup, snapshot: null }),
    JSON.stringify({ ...backup, romSha256: "bad" }), JSON.stringify({ ...backup, snapshot: { ...backup.snapshot, version: 99 } }),
    JSON.stringify({ ...backup, snapshot: { ...backup.snapshot, memory: [] } }),
    JSON.stringify({ ...backup, snapshot: { ...backup.snapshot, registers: Array(16).fill(256) } }),
    JSON.stringify({ ...backup, snapshot: { ...backup.snapshot, pc: 1 } }),
    JSON.stringify({ ...backup, snapshot: { ...backup.snapshot, delayTimer: 256 } })]) {
    await assert.rejects(inspectChip8ProgressBackup(text, target));
    assert.deepEqual(runtime.snapshot(), unchanged);
  }
  await assert.rejects(inspectChip8ProgressBackup(" ".repeat(MAX_CHIP8_BACKUP_BYTES + 1), target), /256 KiB/);
  assert.throws(() => validateChip8Progress(target, undefined), /missing/);
});
test("validated state is detached from the parsed file and live emulator", async () => {
  const { runtime, backup } = await fixture();
  const checked = validateChip8Progress(target, backup.snapshot);
  checked.memory[0] = 99;
  assert.notEqual(backup.snapshot.memory[0], 99);
  assert.notEqual(runtime.memory[0], 99);
});
