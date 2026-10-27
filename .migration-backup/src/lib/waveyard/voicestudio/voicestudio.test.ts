/**
 * Voice Studio contract tests — the consent gate, honest capability
 * labels, job validation, provenance. These are the safety properties
 * that must never regress.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ConsentRegistry } from "./consent";
import { createVoiceConversionJob, VOICE_CONVERSION_QUEUE } from "./job";
import {
  resolveVoiceCapability,
  voiceCapabilityLabel,
} from "./capability";

const SHA = "a".repeat(64);

function registryWithOwnVoice() {
  const registry = new ConsentRegistry();
  registry.grant({
    voiceId: "voice:me",
    displayName: "My own voice",
    rightsBasis: "own-voice",
    evidence: "This is my voice; I am the user.",
  });
  return registry;
}

test("identity conversion is impossible without a consent record", () => {
  const registry = new ConsentRegistry();
  const result = createVoiceConversionJob({
    registry,
    projectId: "p1",
    sourceStemAssetId: "stem-1",
    sourceChecksumSha256: SHA,
    targetVoiceId: "voice:frank-ocean",
    model: "rvc",
    transposeSemitones: 0,
    identityStrength: 0.9,
    preserveTiming: true,
    requestedBy: "user",
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "CONSENT_MISSING");
  assert.ok(result.error.includes("consent"));
  // And the capability layer says the same thing.
  const capability = resolveVoiceCapability({
    operation: "identity-conversion",
    runtime: { workerAvailable: true, modelsInstalled: true, gpuAvailable: false },
    consentOnFile: false,
  });
  assert.equal(capability.capability, "unavailable");
  assert.ok(capability.reason.includes("consent"));
});

test("own-voice consent unlocks conversion; licensed requires real evidence", () => {
  const registry = registryWithOwnVoice();
  const own = createVoiceConversionJob({
    registry,
    projectId: "p1",
    sourceStemAssetId: "stem-1",
    sourceChecksumSha256: SHA,
    targetVoiceId: "voice:me",
    model: "rvc",
    transposeSemitones: 2,
    identityStrength: 1,
    preserveTiming: true,
    requestedBy: "user",
  });
  assert.equal(own.ok, true);
  assert.equal(own.job!.queue, VOICE_CONVERSION_QUEUE);
  assert.equal(own.job!.provenance.consentFingerprint.length, 16);
  assert.equal(own.job!.transposeSemitones, 2);

  const registry2 = new ConsentRegistry();
  assert.throws(
    () =>
      registry2.grant({
        voiceId: "voice:licensed",
        displayName: "Licensed Voice",
        rightsBasis: "licensed",
        evidence: "no",
      }),
    /concrete rights description/i,
  );
  registry2.grant({
    voiceId: "voice:licensed",
    displayName: "Licensed Voice",
    rightsBasis: "licensed",
    evidence: "License #123 from the artist's official voice marketplace.",
    scope: "conversion+public-release",
  });
  const licensed = createVoiceConversionJob({
    registry: registry2,
    projectId: "p1",
    sourceStemAssetId: "stem-1",
    sourceChecksumSha256: SHA,
    targetVoiceId: "voice:licensed",
    model: "so-vits-svc",
    transposeSemitones: 0,
    identityStrength: 0.8,
    preserveTiming: true,
    requestedBy: "user",
  });
  assert.equal(licensed.ok, true);
});

test("revocation immediately re-locks the gate", () => {
  const registry = registryWithOwnVoice();
  assert.ok(registry.canCloneIdentity("voice:me"));
  registry.revoke("voice:me");
  assert.ok(!registry.canCloneIdentity("voice:me"));
  const result = createVoiceConversionJob({
    registry,
    projectId: "p1",
    sourceStemAssetId: "stem-1",
    sourceChecksumSha256: SHA,
    targetVoiceId: "voice:me",
    model: "rvc",
    transposeSemitones: 0,
    identityStrength: 1,
    preserveTiming: true,
    requestedBy: "user",
  });
  assert.equal(result.ok, false);
});

test("job contract rejects bad inputs with specific codes", () => {
  const registry = registryWithOwnVoice();
  const badChecksum = createVoiceConversionJob({
    registry, projectId: "p1", sourceStemAssetId: "stem-1",
    sourceChecksumSha256: "not-sha", targetVoiceId: "voice:me",
    model: "rvc", transposeSemitones: 0, identityStrength: 1,
    preserveTiming: true, requestedBy: "user",
  });
  assert.equal(badChecksum.ok, false);
  assert.equal(badChecksum.errorCode, "INPUT_INVALID");

  const badModel = createVoiceConversionJob({
    registry, projectId: "p1", sourceStemAssetId: "stem-1",
    sourceChecksumSha256: SHA, targetVoiceId: "voice:me",
    model: "wondermachine", transposeSemitones: 0, identityStrength: 1,
    preserveTiming: true, requestedBy: "user",
  });
  assert.equal(badModel.ok, false);
  assert.equal(badModel.errorCode, "MODEL_UNKNOWN");
});

test("capability labels are exact and style transfer never claims identity", () => {
  assert.equal(voiceCapabilityLabel("identity-conversion"), "Voice conversion: real (consent on file)");
  assert.equal(voiceCapabilityLabel("style-transfer"), "Style transfer: delivery character, not identity");
  assert.equal(voiceCapabilityLabel("pitch-correction"), "Pitch correction: tuning only");
  assert.equal(voiceCapabilityLabel("unavailable"), "Voice conversion unavailable in this session");

  const noModels = resolveVoiceCapability({
    operation: "identity-conversion",
    runtime: { workerAvailable: true, modelsInstalled: false, gpuAvailable: true },
    consentOnFile: true,
  });
  assert.equal(noModels.capability, "unavailable");
  assert.ok(noModels.reason.includes("models"));

  const style = resolveVoiceCapability({
    operation: "style-transfer",
    runtime: { workerAvailable: true, modelsInstalled: true, gpuAvailable: false },
    consentOnFile: false,
  });
  assert.equal(style.capability, "style-transfer");
  assert.ok(style.reason.includes("identity is preserved"));
});
