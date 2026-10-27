import assert from "node:assert/strict";
import test from "node:test";

import { buildSrt, buildVtt, formatTimecode, parseSrt, segmentsFromText, transcribeAudio } from "./captions";
import { deckFromMarkdown, deckToHtml, deckToPptx, fallbackDeck } from "./slides";
import { parseScript, fallbackScript } from "./podcast";
import { speakText } from "./voice";

// ------------------------------------------------------------ captions (#13)

test("captions: timecodes, SRT/VTT round-trip, auto-segmentation", () => {
  assert.equal(formatTimecode(3661.5), "01:01:01,500");
  assert.equal(formatTimecode(3661.5, true), "01:01:01.500");
  const segments = [
    { start: 0, end: 2.5, text: "hello world" },
    { start: 2.5, end: 5, text: "second line" },
  ];
  const srt = buildSrt(segments);
  assert.match(srt, /1\n00:00:00,000 --> 00:00:02,500\nhello world/);
  // parseSrt inverts buildSrt
  const parsed = parseSrt(srt);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[1], { start: 2.5, end: 5, text: "second line" });
  assert.match(buildVtt(segments), /^WEBVTT/);
  // auto-timing from plain text keeps cues readable
  const auto = segmentsFromText("First sentence here. Second one, a bit longer, with commas, everywhere.");
  assert.ok(auto.length >= 2);
  for (const segment of auto) {
    assert.ok(segment.end > segment.start);
    assert.ok(segment.text.length <= 100);
  }
});

test("captions: transcription request shape (Groq tier first) and honest failure", async () => {
  const calls: { url: string; model: string; auth: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const form = init?.body as FormData;
    calls.push({ url, model: String(form.get("model")), auth: String((init?.headers as Record<string, string>).Authorization) });
    return new Response(JSON.stringify({ text: "transcribed words", segments: [{ start: 0, end: 1, text: "transcribed words" }] }), { status: 200 });
  }) as unknown as typeof fetch;
  const result = await transcribeAudio(Buffer.from("fake-audio"), "clip.wav", { keys: { groq: "gk" }, fetchImpl });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.text, "transcribed words");
    assert.equal(result.via, "groq:whisper-large-v3-turbo");
    assert.deepEqual(result.segments, [{ start: 0, end: 1, text: "transcribed words" }]);
  }
  assert.equal(calls[0].url, "https://api.groq.com/openai/v1/audio/transcriptions");
  assert.equal(calls[0].model, "whisper-large-v3-turbo");
  assert.equal(calls[0].auth, "Bearer gk");
  // No keys → honest failure with guidance, never faked text
  const none = await transcribeAudio(Buffer.from("x"), "clip.wav", {});
  assert.equal(none.ok, false);
  if (!none.ok) assert.match(none.reason, /no transcription key/);
});

// -------------------------------------------------------------- slides (#6)

test("slides: markdown → deck parsing and the honest offline fallback", () => {
  const deck = deckFromMarkdown("# Deck Title\n_a subtitle_\n\n## First\n- one\n- two\n\n## Second\n- three\n");
  assert.equal(deck.title, "Deck Title");
  assert.equal(deck.subtitle, "a subtitle");
  assert.equal(deck.slides.length, 2);
  assert.deepEqual(deck.slides[0], { title: "First", bullets: ["one", "two"] });

  const fb = fallbackDeck("local first music production for producers", 4);
  assert.equal(fb.slides.length, 4);
  for (const slide of fb.slides) assert.ok(slide.bullets.length >= 3);
  assert.match(fb.subtitle, /Local Engine/);
});

test("slides: HTML render and a real PPTX file", async () => {
  const deck = fallbackDeck("quantum computing for musicians", 3);
  const html = deckToHtml(deck);
  assert.match(html, /<!doctype html>/);
  assert.match(html, /Quantum computing for musicians/i);
  const pptx = await deckToPptx(deck);
  // A real .pptx is a ZIP: magic bytes PK\x03\x04
  assert.equal(pptx.subarray(0, 2).toString("latin1"), "PK");
  assert.ok(pptx.byteLength > 4000, `pptx suspiciously small: ${pptx.byteLength}`);
});

// ------------------------------------------------------------ podcast (#5)

test("podcast: script parsing handles model formats and falls back honestly", () => {
  const parsed = parseScript("# My Episode\nHOST A: Welcome in.\nHOST B: Glad to be here.\nA: Quick one today.\nB: Very.");
  assert.equal(parsed.title, "My Episode");
  assert.equal(parsed.lines.length, 4);
  assert.equal(parsed.lines[2].speaker, "A");

  const fb = fallbackScript("some meeting notes about the launch");
  assert.ok(fb.lines.length >= 5);
  assert.ok(fb.lines.every((l) => l.text.length > 10));
  assert.match(fb.lines.at(-1)!.text, /Local Engine/);
});

// --------------------------------------------------------------- voice (#11)

test("voice: ElevenLabs tier honored, all-fail is honest (never fake audio)", async () => {
  const ok = await speakText("hello", {
    keys: { elevenlabs: "k" },
    fetchImpl: (async () => new Response(new Uint8Array(256).fill(1), { status: 200 })) as unknown as typeof fetch,
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.engine, "elevenlabs");
    assert.equal(ok.mime, "audio/mpeg");
  }
  const fail = await speakText("hello", {
    fetchImpl: (async () => {
      throw new Error("network blocked");
    }) as unknown as typeof fetch,
    execImpl: (async () => {
      throw new Error("no espeak");
    }) as never,
  });
  assert.equal(fail.ok, false);
  if (!fail.ok) {
    assert.match(fail.reason, /no voice engine available/);
    assert.ok(fail.tried.length >= 1);
  }
  // Empty text never calls any engine
  const empty = await speakText("   ");
  assert.equal(empty.ok, false);
});
