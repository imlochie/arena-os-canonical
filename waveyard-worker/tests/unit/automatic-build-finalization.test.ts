import { describe, expect, it } from "vitest";
import { evaluateAutomaticBuildFinalization } from "../../apps/web/src/lib/automatic-build-finalization";

function evaluate(overrides: Partial<Parameters<typeof evaluateAutomaticBuildFinalization>[0]> = {}) {
  return evaluateAutomaticBuildFinalization({
    acceptedSourceCount: 1,
    persistedFailedSourceCount: 0,
    processing: false,
    failedJobSourceIds: [],
    sources: [{
      id: "source-a",
      analysisStatus: "complete",
      sectionStatus: "complete",
      hasRealStems: true,
    }],
    ...overrides,
  });
}

describe("automatic build finalization", () => {
  it("builds the continuous fallback when structural analysis is unavailable", () => {
    const result = evaluate({
      sources: [{
        id: "source-a",
        analysisStatus: "complete",
        sectionStatus: "unavailable",
        hasRealStems: true,
      }],
    });

    expect(result).toMatchObject({
      stage: "building",
      canBuildAutomaticRemix: true,
      eligibleSourceCount: 1,
      failedSourceCount: 0,
    });
  });

  it("does not count structural analysis failure as a source failure", () => {
    const result = evaluate({
      sources: [{
        id: "source-a",
        analysisStatus: "complete",
        sectionStatus: "failed",
        hasRealStems: true,
      }],
    });

    expect(result).toMatchObject({
      canBuildAutomaticRemix: true,
      failedSourceCount: 0,
      reportedAcceptedSourceCount: 1,
    });
  });

  it("waits for queued structural analysis before snapshotting an arrangement", () => {
    const result = evaluate({
      sources: [{
        id: "source-a",
        analysisStatus: "complete",
        sectionStatus: "processing",
        hasRealStems: true,
      }],
    });

    expect(result).toMatchObject({
      stage: "finding-structure",
      canBuildAutomaticRemix: false,
    });
  });

  it("waits for the section lifecycle row to be provisioned", () => {
    const result = evaluate({
      sources: [{
        id: "source-a",
        analysisStatus: "complete",
        hasRealStems: true,
      }],
    });

    expect(result).toMatchObject({
      stage: "finding-structure",
      canBuildAutomaticRemix: false,
    });
  });

  it("counts failed authoritative analysis as a source failure", () => {
    const result = evaluate({
      sources: [{
        id: "source-a",
        analysisStatus: "failed",
        sectionStatus: "unavailable",
        hasRealStems: true,
      }],
    });

    expect(result).toMatchObject({
      expectedReadySourceCount: 0,
      failedSourceCount: 1,
      canBuildAutomaticRemix: false,
    });
  });

  it("preserves accepted sources while authoritative analysis is still pending", () => {
    const analysisPending = evaluate({
      sources: [{
        id: "source-a",
        analysisStatus: "processing",
        sectionStatus: "unavailable",
        hasRealStems: true,
      }],
    });
    const stemsMissing = evaluate({
      sources: [{
        id: "source-a",
        analysisStatus: "complete",
        sectionStatus: "complete",
        hasRealStems: false,
      }],
    });
    const completeAfterPending = evaluate({
      acceptedSourceCount: analysisPending.reportedAcceptedSourceCount,
      sources: [{
        id: "source-a",
        analysisStatus: "complete",
        sectionStatus: "unavailable",
        hasRealStems: true,
      }],
    });

    expect(analysisPending).toMatchObject({
      stage: "understanding",
      reportedAcceptedSourceCount: 1,
      canBuildAutomaticRemix: false,
    });
    expect(stemsMissing).toMatchObject({
      stage: "understanding",
      reportedAcceptedSourceCount: 1,
      canBuildAutomaticRemix: false,
    });
    expect(completeAfterPending).toMatchObject({
      reportedAcceptedSourceCount: 1,
      canBuildAutomaticRemix: true,
    });
  });

  it("keeps separation ahead of downstream analysis", () => {
    const result = evaluate({ processing: true });
    expect(result).toMatchObject({
      stage: "separating",
      canBuildAutomaticRemix: false,
    });
  });
});
