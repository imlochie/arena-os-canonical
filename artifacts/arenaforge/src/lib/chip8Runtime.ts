export const CHIP8_WIDTH = 64;
export const CHIP8_HEIGHT = 32;
export const CHIP8_PROGRAM_START = 0x200;
export const CHIP8_MAX_ROM_BYTES = 0x1000 - CHIP8_PROGRAM_START;

const FONT = new Uint8Array([
  0xf0, 0x90, 0x90, 0x90, 0xf0, 0x20, 0x60, 0x20, 0x20, 0x70,
  0xf0, 0x10, 0xf0, 0x80, 0xf0, 0xf0, 0x10, 0xf0, 0x10, 0xf0,
  0x90, 0x90, 0xf0, 0x10, 0x10, 0xf0, 0x80, 0xf0, 0x10, 0xf0,
  0xf0, 0x80, 0xf0, 0x90, 0xf0, 0xf0, 0x10, 0x20, 0x40, 0x40,
  0xf0, 0x90, 0xf0, 0x90, 0xf0, 0xf0, 0x90, 0xf0, 0x10, 0xf0,
  0xf0, 0x90, 0xf0, 0x90, 0x90, 0xe0, 0x90, 0xe0, 0x90, 0xe0,
  0xf0, 0x80, 0x80, 0x80, 0xf0, 0xe0, 0x90, 0x90, 0x90, 0xe0,
  0xf0, 0x80, 0xf0, 0x80, 0xf0, 0xf0, 0x80, 0xf0, 0x80, 0x80,
]);

export type Chip8Snapshot = {
  version: 1;
  memory: number[];
  registers: number[];
  stack: number[];
  display: number[];
  index: number;
  pc: number;
  stackPointer: number;
  delayTimer: number;
  soundTimer: number;
  randomState: number;
};

const KEY_MAP: Record<string, number> = {
  "1": 0x1, "2": 0x2, "3": 0x3, "4": 0xc,
  q: 0x4, w: 0x5, e: 0x6, r: 0xd,
  a: 0x7, s: 0x8, d: 0x9, f: 0xe,
  z: 0xa, x: 0x0, c: 0xb, v: 0xf,
};

export const CHIP8_KEYS = [
  ["1", "2", "3", "C"],
  ["4", "5", "6", "D"],
  ["7", "8", "9", "E"],
  ["A", "0", "B", "F"],
] as const;

export function chip8KeyFromKeyboard(key: string): number | null {
  return KEY_MAP[key.toLowerCase()] ?? null;
}

export class Chip8Runtime {
  readonly memory = new Uint8Array(4096);
  readonly registers = new Uint8Array(16);
  readonly stack = new Uint16Array(16);
  readonly display = new Uint8Array(CHIP8_WIDTH * CHIP8_HEIGHT);
  readonly keys = new Uint8Array(16);
  index = 0;
  pc = CHIP8_PROGRAM_START;
  stackPointer = 0;
  delayTimer = 0;
  soundTimer = 0;
  private randomState = 0x6d2b79f5;

  constructor(program: Uint8Array, snapshot?: unknown) {
    if (program.length < 2 || program.length > CHIP8_MAX_ROM_BYTES || program.length % 2 !== 0) {
      throw new Error(`Classic CHIP-8 programs must be even-sized and between 2 bytes and ${CHIP8_MAX_ROM_BYTES} bytes.`);
    }
    this.memory.set(FONT, 0);
    this.memory.set(program, CHIP8_PROGRAM_START);
    if (snapshot !== undefined) this.restore(snapshot);
  }

  setKey(key: number, pressed: boolean) {
    if (key >= 0 && key < this.keys.length) this.keys[key] = pressed ? 1 : 0;
  }

  tickTimers() {
    if (this.delayTimer > 0) this.delayTimer -= 1;
    if (this.soundTimer > 0) this.soundTimer -= 1;
  }

  step() {
    if (this.pc < CHIP8_PROGRAM_START || this.pc >= this.memory.length - 1) {
      throw new Error("The CHIP-8 program counter left the available memory.");
    }
    const opcode = (this.memory[this.pc] << 8) | this.memory[this.pc + 1];
    const x = (opcode >> 8) & 0xf;
    const y = (opcode >> 4) & 0xf;
    const n = opcode & 0xf;
    const kk = opcode & 0xff;
    const nnn = opcode & 0xfff;
    this.pc = (this.pc + 2) & 0xfff;

    switch (opcode & 0xf000) {
      case 0x0000:
        if (opcode === 0x00e0) this.display.fill(0);
        else if (opcode === 0x00ee) {
          if (this.stackPointer === 0) throw new Error("CHIP-8 program returned from an empty call stack.");
          this.pc = this.stack[--this.stackPointer];
        } else throw new Error(`Unsupported classic CHIP-8 instruction 0x${opcode.toString(16).padStart(4, "0")}.`);
        break;
      case 0x1000: this.pc = nnn; break;
      case 0x2000:
        if (this.stackPointer >= this.stack.length) throw new Error("CHIP-8 program exceeded its call stack.");
        this.stack[this.stackPointer++] = this.pc;
        this.pc = nnn;
        break;
      case 0x3000: if (this.registers[x] === kk) this.pc += 2; break;
      case 0x4000: if (this.registers[x] !== kk) this.pc += 2; break;
      case 0x5000:
        if (n !== 0) throw new Error(`Unsupported classic CHIP-8 instruction 0x${opcode.toString(16)}.`);
        if (this.registers[x] === this.registers[y]) this.pc += 2;
        break;
      case 0x6000: this.registers[x] = kk; break;
      case 0x7000: this.registers[x] = (this.registers[x] + kk) & 0xff; break;
      case 0x8000: {
        const vx = this.registers[x];
        const vy = this.registers[y];
        switch (n) {
          case 0x0: this.registers[x] = vy; break;
          case 0x1: this.registers[x] = vx | vy; break;
          case 0x2: this.registers[x] = vx & vy; break;
          case 0x3: this.registers[x] = vx ^ vy; break;
          case 0x4: this.registers[0xf] = vx + vy > 0xff ? 1 : 0; this.registers[x] = (vx + vy) & 0xff; break;
          case 0x5: this.registers[0xf] = vx >= vy ? 1 : 0; this.registers[x] = (vx - vy) & 0xff; break;
          case 0x6: this.registers[0xf] = vy & 1; this.registers[x] = vy >>> 1; break;
          case 0x7: this.registers[0xf] = vy >= vx ? 1 : 0; this.registers[x] = (vy - vx) & 0xff; break;
          case 0xe: this.registers[0xf] = (vy >> 7) & 1; this.registers[x] = (vy << 1) & 0xff; break;
          default: throw new Error(`Unsupported classic CHIP-8 instruction 0x${opcode.toString(16)}.`);
        }
        break;
      }
      case 0x9000:
        if (n !== 0) throw new Error(`Unsupported classic CHIP-8 instruction 0x${opcode.toString(16)}.`);
        if (this.registers[x] !== this.registers[y]) this.pc += 2;
        break;
      case 0xa000: this.index = nnn; break;
      case 0xb000: this.pc = (nnn + this.registers[0]) & 0xfff; break;
      case 0xc000:
        this.randomState ^= this.randomState << 13;
        this.randomState ^= this.randomState >>> 17;
        this.randomState ^= this.randomState << 5;
        this.registers[x] = (this.randomState & 0xff) & kk;
        break;
      case 0xd000: {
        if (n > 0 && this.index + n > this.memory.length) throw new Error("CHIP-8 sprite data extends past available memory.");
        const originX = this.registers[x] % CHIP8_WIDTH;
        const originY = this.registers[y] % CHIP8_HEIGHT;
        this.registers[0xf] = 0;
        for (let row = 0; row < n; row += 1) {
          const sprite = this.memory[this.index + row];
          for (let column = 0; column < 8; column += 1) {
            if ((sprite & (0x80 >> column)) === 0) continue;
            const pixel = ((originY + row) % CHIP8_HEIGHT) * CHIP8_WIDTH + ((originX + column) % CHIP8_WIDTH);
            if (this.display[pixel]) this.registers[0xf] = 1;
            this.display[pixel] ^= 1;
          }
        }
        break;
      }
      case 0xe000:
        if (kk === 0x9e && this.keys[this.registers[x]]) this.pc += 2;
        else if (kk === 0xa1 && !this.keys[this.registers[x]]) this.pc += 2;
        else if (kk !== 0x9e && kk !== 0xa1) throw new Error(`Unsupported classic CHIP-8 instruction 0x${opcode.toString(16)}.`);
        break;
      case 0xf000:
        switch (kk) {
          case 0x07: this.registers[x] = this.delayTimer; break;
          case 0x0a: {
            const pressed = this.keys.findIndex((value) => value !== 0);
            if (pressed === -1) this.pc = (this.pc - 2) & 0xfff;
            else this.registers[x] = pressed;
            break;
          }
          case 0x15: this.delayTimer = this.registers[x]; break;
          case 0x18: this.soundTimer = this.registers[x]; break;
          case 0x1e: this.index = (this.index + this.registers[x]) & 0xfff; break;
          case 0x29: this.index = (this.registers[x] & 0xf) * 5; break;
          case 0x33:
            if (this.index + 2 >= this.memory.length) throw new Error("CHIP-8 decimal data extends past available memory.");
            this.memory[this.index] = Math.floor(this.registers[x] / 100);
            this.memory[this.index + 1] = Math.floor((this.registers[x] % 100) / 10);
            this.memory[this.index + 2] = this.registers[x] % 10;
            break;
          case 0x55:
            if (this.index + x >= this.memory.length) throw new Error("CHIP-8 register data extends past available memory.");
            for (let register = 0; register <= x; register += 1) this.memory[this.index + register] = this.registers[register];
            this.index = (this.index + x + 1) & 0xfff;
            break;
          case 0x65:
            if (this.index + x >= this.memory.length) throw new Error("CHIP-8 register data extends past available memory.");
            for (let register = 0; register <= x; register += 1) this.registers[register] = this.memory[this.index + register];
            this.index = (this.index + x + 1) & 0xfff;
            break;
          default: throw new Error(`Unsupported classic CHIP-8 instruction 0x${opcode.toString(16)}.`);
        }
        break;
      default: throw new Error(`Unsupported classic CHIP-8 instruction 0x${opcode.toString(16)}.`);
    }
  }

  snapshot(): Chip8Snapshot {
    return {
      version: 1,
      memory: Array.from(this.memory),
      registers: Array.from(this.registers),
      stack: Array.from(this.stack),
      display: Array.from(this.display),
      index: this.index,
      pc: this.pc,
      stackPointer: this.stackPointer,
      delayTimer: this.delayTimer,
      soundTimer: this.soundTimer,
      randomState: this.randomState,
    };
  }

  private restore(value: unknown) {
    if (!value || typeof value !== "object") throw new Error("The saved CHIP-8 progress is invalid.");
    const state = value as Partial<Chip8Snapshot>;
    const validArray = (data: unknown, length: number) =>
      Array.isArray(data) && data.length === length && data.every((item) => Number.isInteger(item) && item >= 0 && item <= 0xff);
    const validStack = Array.isArray(state.stack) && state.stack.length === this.stack.length &&
      state.stack.every((item) => Number.isInteger(item) && item >= 0 && item < this.memory.length);
    if (
      state.version !== 1 ||
      !validArray(state.memory, this.memory.length) ||
      !validArray(state.registers, this.registers.length) ||
      !validStack ||
      !validArray(state.display, this.display.length) ||
      !Number.isInteger(state.index) || (state.index ?? -1) < 0 || (state.index ?? 0) >= this.memory.length ||
      !Number.isInteger(state.pc) || (state.pc ?? -1) < CHIP8_PROGRAM_START || (state.pc ?? 0) >= this.memory.length ||
      !Number.isInteger(state.stackPointer) || (state.stackPointer ?? -1) < 0 || (state.stackPointer ?? 17) > this.stack.length ||
      !Number.isInteger(state.delayTimer) || (state.delayTimer ?? -1) < 0 || (state.delayTimer ?? 256) > 255 ||
      !Number.isInteger(state.soundTimer) || (state.soundTimer ?? -1) < 0 || (state.soundTimer ?? 256) > 255 ||
      !Number.isInteger(state.randomState)
    ) throw new Error("The saved CHIP-8 progress is invalid.");

    this.memory.set(state.memory!);
    this.registers.set(state.registers!);
    this.stack.set(state.stack!);
    this.display.set(state.display!);
    this.index = state.index!;
    this.pc = state.pc!;
    this.stackPointer = state.stackPointer!;
    this.delayTimer = state.delayTimer!;
    this.soundTimer = state.soundTimer!;
    this.randomState = state.randomState! >>> 0;
  }
}
