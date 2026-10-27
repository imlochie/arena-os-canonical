/**
 * Minimal jest-compatible `expect` for the ported LUMA test suite, so the
 * original tests (written for jest) run unchanged under `node --test`.
 * Covers exactly the matchers the suite uses.
 */
import assert from "node:assert/strict";

type Matcher = {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toMatchObject(expected: Record<string, unknown>): void;
  toBeCloseTo(expected: number, precision?: number): void;
  toBeNull(): void;
  toBeUndefined(): void;
  toBeDefined(): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  toBeGreaterThan(n: number): void;
  toBeGreaterThanOrEqual(n: number): void;
  toBeLessThan(n: number): void;
  toBeLessThanOrEqual(n: number): void;
  toContain(s: unknown): void;
  toHaveLength(n: number): void;
  toThrow(msg?: string | RegExp): void;
  not: Matcher;
};

type AnyPattern = { __expectAny: Function };
type ObjectContaining = { __expectObjectContaining: Record<string, unknown> };
type ArrayContaining = { __expectArrayContaining: unknown[] };
type Containing = AnyPattern | ObjectContaining | ArrayContaining;

function looseEqual(recv: any, exp: any): boolean {
  if (exp && typeof exp === "object" && "__expectAny" in exp) {
    const ctor = (exp as AnyPattern).__expectAny;
    // eslint-disable-next-line valid-typeof
    return typeof recv === (typeof ctor === "function" && ctor.name ? typeofRecvForCtor(ctor) : "object") || recv instanceof ctor || recv?.constructor === ctor;
  }
  if (exp && typeof exp === "object" && "__expectObjectContaining" in exp) {
    const pat = (exp as ObjectContaining).__expectObjectContaining;
    return typeof recv === "object" && recv !== null &&
      Object.keys(pat).every((k) => looseEqual(recv[k], (pat as Record<string, unknown>)[k]));
  }
  if (exp && typeof exp === "object" && "__expectArrayContaining" in exp) {
    const items = (exp as ArrayContaining).__expectArrayContaining;
    return Array.isArray(recv) && items.every((item) => recv.some((r) => looseEqual(r, item)));
  }
  if (Array.isArray(exp) && Array.isArray(recv)) {
    return exp.length === recv.length && exp.every((e, i) => looseEqual(recv[i], e));
  }
  if (exp && typeof exp === "object" && recv && typeof recv === "object") {
    const ek = Object.keys(exp);
    const rk = Object.keys(recv);
    return ek.length === rk.length && ek.every((k) => looseEqual(recv[k], exp[k]));
  }
  return JSON.stringify(recv) === JSON.stringify(exp);
}

function typeofRecvForCtor(ctor: Function): string {
  if (ctor === String) return "string";
  if (ctor === Number) return "number";
  if (ctor === Boolean) return "boolean";
  if (ctor === Function) return "function";
  return "object";
}

function build(received: unknown, isNot: boolean): Matcher {
  const check = (cond: boolean, message: string) => {
    if (isNot ? cond : !cond) {
      throw new assert.AssertionError({
        message: isNot ? `NOT expected: ${message}` : message,
      });
    }
  };
  // Lazy: building `not` eagerly would recurse forever, so it is a getter.
  let notCache: Matcher | null = null;
  const m: Matcher = {
    toBe(expected) {
      check(Object.is(received, expected), `expected ${JSON.stringify(received)} to be ${JSON.stringify(expected)}`);
    },
    toEqual(expected) {
      check(
        looseEqual(received, expected),
        `expected ${JSON.stringify(received)} to equal ${JSON.stringify(expected)}`,
      );
    },
    toBeCloseTo(expected, precision = 2) {
      const delta = Math.abs(Number(received) - expected);
      check(delta < Math.pow(10, -precision) / 2, `expected ${received} to be close to ${expected}`);
    },
    toMatchObject(expected) {
      const matches = (recv: any, exp: any): boolean => {
        if (exp === null || typeof exp !== "object") return Object.is(recv, exp);
        if (exp.__expectAny || exp.__expectObjectContaining || exp.__expectArrayContaining) return looseEqual(recv, exp);
        if (typeof recv !== "object" || recv === null) return false;
        return Object.keys(exp).every((k) => matches(recv[k], exp[k]));
      };
      check(matches(received, expected), `expected ${JSON.stringify(received)} to match object ${JSON.stringify(expected)}`);
    },
    toBeNull() { check(received === null, `expected ${JSON.stringify(received)} to be null`); },
    toBeUndefined() { check(received === undefined, `expected ${JSON.stringify(received)} to be undefined`); },
    toBeDefined() { check(received !== undefined, `expected value to be defined`); },
    toBeTruthy() { check(!!received, `expected ${JSON.stringify(received)} to be truthy`); },
    toBeFalsy() { check(!received, `expected ${JSON.stringify(received)} to be falsy`); },
    toBeGreaterThan(n) { check(Number(received) > n, `expected ${received} > ${n}`); },
    toBeGreaterThanOrEqual(n) { check(Number(received) >= n, `expected ${received} >= ${n}`); },
    toBeLessThan(n) { check(Number(received) < n, `expected ${received} < ${n}`); },
    toBeLessThanOrEqual(n) { check(Number(received) <= n, `expected ${received} <= ${n}`); },
    toContain(s) {
      const contains =
        typeof received === "string"
          ? received.includes(String(s))
          : Array.isArray(received) && received.includes(s);
      check(contains, `expected ${JSON.stringify(received)} to contain ${JSON.stringify(s)}`);
    },
    toHaveLength(n) {
      check((received as { length?: number })?.length === n, `expected length ${n}, got ${(received as { length?: number })?.length}`);
    },
    toThrow(msg) {
      let threw: unknown = null;
      try {
        (received as () => unknown)();
      } catch (e) {
        threw = e;
      }
      check(threw !== null, "expected function to throw");
      if (threw && msg !== undefined) {
        const text = String((threw as Error).message ?? threw);
        check(msg instanceof RegExp ? msg.test(text) : text.includes(String(msg)), `expected throw to match ${String(msg)}`);
      }
    },
    get not(): Matcher {
      if (!notCache) notCache = build(received, true);
      return notCache;
    },
  };
  return m;
}

export function expect(received: unknown): Matcher {
  return build(received, false);
}

expect.objectContaining = (pattern: Record<string, unknown>) =>
  ({ __expectObjectContaining: pattern }) as never;
expect.arrayContaining = (items: unknown[]) => ({ __expectArrayContaining: items }) as never;
expect.any = (ctor: Function) => ({ __expectAny: ctor }) as never;
