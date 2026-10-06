/**
 * Minimal jest-compatible `expect` for the ported LUMA test suite, so the
 * original tests (written for jest) run unchanged under `node --test`.
 * Covers exactly the matchers the suite uses.
 */
import assert from "node:assert/strict";

type Matcher = {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
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
        JSON.stringify(received) === JSON.stringify(expected),
        `expected ${JSON.stringify(received)} to equal ${JSON.stringify(expected)}`,
      );
    },
    toBeCloseTo(expected, precision = 2) {
      const delta = Math.abs(Number(received) - expected);
      check(delta < Math.pow(10, -precision) / 2, `expected ${received} to be close to ${expected}`);
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
