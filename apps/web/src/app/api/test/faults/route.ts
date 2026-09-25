import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  armTestFault,
  readTestFaultEvents,
  TEST_FAULTS,
  type TestFault,
} from "@waveyard/queue";

export const runtime = "nodejs";

function hasTestToken(request: Request) {
  const expected = process.env.WAVEYARD_TEST_FAULT_TOKEN;
  const received = request.headers.get("x-waveyard-test-fault-token");
  if (!expected || !received) return false;
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(received);
  return (
    expectedBytes.byteLength === receivedBytes.byteLength &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

function parseFault(value: unknown): TestFault | null {
  return typeof value === "string" &&
    (TEST_FAULTS as readonly string[]).includes(value)
    ? (value as TestFault)
    : null;
}

function unavailable() {
  // Do not expose a test-control surface in environments that did not opt in.
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

export async function POST(request: Request) {
  if (!hasTestToken(request)) return unavailable();
  try {
    const body = await request.json();
    const fault = parseFault(body?.fault);
    if (!fault)
      return NextResponse.json({ error: "Unknown test fault." }, { status: 422 });
    await armTestFault(fault, body?.count ?? 1);
    return NextResponse.json({ fault, armed: true }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Test fault was not armed.";
    return NextResponse.json({ error: message }, { status: 422 });
  }
}

export async function GET(request: Request) {
  if (!hasTestToken(request)) return unavailable();
  const fault = parseFault(new URL(request.url).searchParams.get("fault"));
  if (!fault)
    return NextResponse.json({ error: "Unknown test fault." }, { status: 422 });
  return NextResponse.json({ fault, events: await readTestFaultEvents(fault) });
}
