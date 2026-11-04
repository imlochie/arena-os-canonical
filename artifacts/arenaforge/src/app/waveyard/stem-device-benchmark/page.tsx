import { useEffect, useRef, useState } from "react";
import { LiveStemLayers, type LiveStemTiming } from "@workspace/arena/lib/waveyard/live-stem-layers";
import {
  groupDeviceReports,
  parseDeviceReport,
  type LoadedDeviceReport,
} from "./comparison";

type DeviceClass = "Phone" | "Tablet";
type Mode = "nativeTempo" | "tempoMatched";
type Observation = LiveStemTiming & {
  trial: number;
  mode: Mode;
  fixtureDurationSeconds: number;
  observedSelectionToAudibleMs: number;
};
type FixtureDetails = {
  durationSeconds: number;
  source: string;
  sampleRate: number;
  transferBytes: number;
  tempoRatio: number;
};
type DurationComparison = {
  durationSeconds: number;
  nativeTempoMedianMs: number;
  tempoMatchedMedianMs: number;
  tempoMatchedMinusNativeMedianMs: number;
  tempoMatchedChangePercent: number | null;
  nativeStagesMedianMs: Record<string, number>;
  tempoMatchedStagesMedianMs: Record<string, number>;
};
type DeviceReport = {
  schemaVersion: 2;
  measuredAt: string;
  environment: {
    browser: string;
    operatingSystem: string;
    deviceClass: DeviceClass;
    deviceModel: string;
    userAgent: string;
    hardwareConcurrency: number | null;
    deviceMemoryGiB: number | null;
    audioSampleRate: number;
  };
  fixtures: FixtureDetails[];
  observations: Observation[];
  durationComparisons: DurationComparison[];
};

const FIXTURE_DURATIONS_SECONDS = [8, 30] as const;
const FIXTURE_SAMPLE_RATE = 44_100;
const TEMPO_RATIO = 124 / 120;
const BENCHMARK_CHANNEL = "device-benchmark";
const FORMATTERS = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

function detectBrowser() {
  const ua = navigator.userAgent;
  const brands = (navigator as Navigator & {
    userAgentData?: { brands?: Array<{ brand: string; version: string }> };
  }).userAgentData?.brands;
  const chromiumBrand = brands?.find(({ brand }) => /Google Chrome|Microsoft Edge|Opera/i.test(brand));
  if (chromiumBrand) return `${chromiumBrand.brand} ${chromiumBrand.version}`;
  const patterns: [RegExp, string][] = [
    [/EdgiOS\/([\d.]+)/, "Microsoft Edge"],
    [/FxiOS\/([\d.]+)/, "Firefox"],
    [/OPiOS\/([\d.]+)/, "Opera"],
    [/CriOS\/([\d.]+)/, "Chrome"],
    [/EdgA?\/([\d.]+)/, "Microsoft Edge"],
    [/Firefox\/([\d.]+)/, "Firefox"],
    [/Chrome\/([\d.]+)/, "Chrome"],
    [/Version\/([\d.]+).*Safari/, "Safari"],
  ];
  for (const [pattern, name] of patterns) {
    const version = ua.match(pattern)?.[1];
    if (version) return `${name} ${version}`;
  }
  return "Unknown browser (edit to identify)";
}

function detectOperatingSystem() {
  const ua = navigator.userAgent;
  const platform = navigator.platform || "";
  if (/iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(platform) && navigator.maxTouchPoints > 1)) return "iOS / iPadOS";
  if (/Android/i.test(ua)) return "Android";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "Unknown OS (edit to identify)";
}

function detectDeviceClass(): DeviceClass {
  const platform = navigator.platform || "";
  return /iPad|Tablet/i.test(navigator.userAgent) ||
    (/Mac/i.test(platform) && navigator.maxTouchPoints > 1) ? "Tablet" : "Phone";
}

function createWaveFixture(seconds: number) {
  const frames = FIXTURE_SAMPLE_RATE * seconds;
  const dataBytes = frames * 4;
  const bytes = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(bytes);
  const write = (text: string, offset: number) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
  };
  write("RIFF", 0);
  view.setUint32(4, bytes.byteLength - 8, true);
  write("WAVEfmt ", 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, FIXTURE_SAMPLE_RATE, true);
  view.setUint32(28, FIXTURE_SAMPLE_RATE * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  write("data", 36);
  view.setUint32(40, dataBytes, true);
  for (let frame = 0; frame < frames; frame += 1) {
    const time = frame / FIXTURE_SAMPLE_RATE;
    const left = Math.round(Math.sin(2 * Math.PI * 220 * time) * 1_300);
    const right = Math.round(Math.sin(2 * Math.PI * 330 * time) * 1_300);
    view.setInt16(44 + frame * 4, left, true);
    view.setInt16(46 + frame * 4, right, true);
  }
  return bytes;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function medianStages(observations: Observation[]) {
  return {
    selectionToAudibleMs: median(observations.map(item => item.observedSelectionToAudibleMs)),
    downloadMs: median(observations.map(item => item.downloadMs)),
    decodeMs: median(observations.map(item => item.decodeMs)),
    tempoMatchMs: median(observations.map(item => item.tempoMatchMs)),
  };
}

export default function StemDeviceBenchmarkPage() {
  const [browser, setBrowser] = useState(detectBrowser);
  const [operatingSystem, setOperatingSystem] = useState(detectOperatingSystem);
  const [deviceClass, setDeviceClass] = useState<DeviceClass>(detectDeviceClass);
  const [deviceModel, setDeviceModel] = useState("");
  const [trialCount, setTrialCount] = useState(5);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("Ready. Audio and device details stay in this browser until you export a report.");
  const [report, setReport] = useState<DeviceReport | null>(null);
  const [error, setError] = useState("");
  const [loadedReports, setLoadedReports] = useState<LoadedDeviceReport[]>([]);
  const [importError, setImportError] = useState("");
  const layersRef = useRef<LiveStemLayers | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const baselineUrlRef = useRef<string | null>(null);
  const reportUrlRef = useRef<string | null>(null);

  useEffect(() => () => {
    layersRef.current?.dispose();
    audioRef.current?.pause();
    if (baselineUrlRef.current) URL.revokeObjectURL(baselineUrlRef.current);
    if (reportUrlRef.current) URL.revokeObjectURL(reportUrlRef.current);
    void contextRef.current?.close();
  }, []);

  const runBenchmark = async () => {
    if (running) return;
    setRunning(true);
    setReport(null);
    setError("");
    setStatus("Preparing the audio engine…");
    const donorUrls: string[] = [];
    try {
      if (!browser.trim() || !operatingSystem.trim()) {
        throw new Error("Enter the browser and operating system used for this run.");
      }
      const fixtureBuffers = new Map(
        FIXTURE_DURATIONS_SECONDS.map(durationSeconds =>
          [durationSeconds, createWaveFixture(durationSeconds)] as const),
      );
      const baselineFixture = fixtureBuffers.get(FIXTURE_DURATIONS_SECONDS[0])!;
      const fixtureBlob = new Blob([baselineFixture], { type: "audio/wav" });
      const context = new AudioContext();
      contextRef.current = context;
      const baselineUrl = URL.createObjectURL(fixtureBlob);
      baselineUrlRef.current = baselineUrl;
      const audio = new Audio(baselineUrl);
      audio.loop = true;
      audio.preload = "auto";
      audioRef.current = audio;
      const source = context.createMediaElementSource(audio);
      const inputGain = context.createGain();
      const mixGain = context.createGain();
      inputGain.gain.value = 1;
      mixGain.gain.value = 0.7;
      source.connect(inputGain);
      inputGain.connect(mixGain);
      mixGain.connect(context.destination);
      const channel = { source, inputGain, gain: mixGain };
      let resolveActiveTiming: ((timing: LiveStemTiming) => void) | null = null;
      const layers = new LiveStemLayers(
        () => context,
        id => id === BENCHMARK_CHANNEL ? channel : null,
        undefined,
        timing => resolveActiveTiming?.(timing),
      );
      layersRef.current = layers;
      await Promise.all([context.resume(), audio.play()]);

      const observations: Observation[] = [];
      const fixtures: FixtureDetails[] = FIXTURE_DURATIONS_SECONDS.map(durationSeconds => ({
        durationSeconds,
        source: "Browser-generated synthetic WAV retrieved from a local Blob URL",
        sampleRate: FIXTURE_SAMPLE_RATE,
        transferBytes: fixtureBuffers.get(durationSeconds)!.byteLength,
        tempoRatio: TEMPO_RATIO,
      }));
      const modes: Mode[] = ["nativeTempo", "tempoMatched"];
      for (let trial = 1; trial <= trialCount; trial += 1) {
        // Alternate fixture and mode order to reduce systematic warmup or
        // background-load bias between donor durations and tempo modes.
        const durationOrder = trial % 2 === 1
          ? FIXTURE_DURATIONS_SECONDS
          : [...FIXTURE_DURATIONS_SECONDS].reverse();
        const modeOrder = trial % 2 === 1 ? modes : [...modes].reverse();
        for (const durationSeconds of durationOrder) {
          const fixture = fixtureBuffers.get(durationSeconds)!;
          for (const mode of modeOrder) {
            const ratio = mode === "nativeTempo" ? 1 : TEMPO_RATIO;
            const donorUrl = URL.createObjectURL(new Blob([fixture], { type: "audio/wav" }));
            donorUrls.push(donorUrl);
            let resolveTiming!: (timing: LiveStemTiming) => void;
            const timingReady = new Promise<LiveStemTiming>(resolve => { resolveTiming = resolve; });
            resolveActiveTiming = resolveTiming;
            const selectedAt = performance.now();
            setStatus(`Trial ${trial} of ${trialCount}: ${durationSeconds}-second donor, ${mode === "nativeTempo" ? "native tempo" : "tempo matched"}…`);
            await layers.replace(BENCHMARK_CHANNEL, donorUrl, ratio, selectedAt);
            const timing = await timingReady;
            resolveActiveTiming = null;
            observations.push({
              ...timing,
              trial,
              mode,
              fixtureDurationSeconds: durationSeconds,
              observedSelectionToAudibleMs: Math.max(0, performance.now() - selectedAt),
            });
            await new Promise(resolve => setTimeout(resolve, 120));
            await layers.replace(BENCHMARK_CHANNEL, null);
          }
        }
      }

      const durationComparisons: DurationComparison[] = FIXTURE_DURATIONS_SECONDS.map(durationSeconds => {
        const durationObservations = observations.filter(item => item.fixtureDurationSeconds === durationSeconds);
        const native = durationObservations.filter(item => item.mode === "nativeTempo");
        const matched = durationObservations.filter(item => item.mode === "tempoMatched");
        const nativeMedian = median(native.map(item => item.observedSelectionToAudibleMs));
        const matchedMedian = median(matched.map(item => item.observedSelectionToAudibleMs));
        return {
          durationSeconds,
          nativeTempoMedianMs: nativeMedian,
          tempoMatchedMedianMs: matchedMedian,
          tempoMatchedMinusNativeMedianMs: matchedMedian - nativeMedian,
          tempoMatchedChangePercent: nativeMedian > 0 ? ((matchedMedian - nativeMedian) / nativeMedian) * 100 : null,
          nativeStagesMedianMs: medianStages(native),
          tempoMatchedStagesMedianMs: medianStages(matched),
        };
      });
      const reportData: DeviceReport = {
        schemaVersion: 2,
        measuredAt: new Date().toISOString(),
        environment: {
          browser: browser.trim(),
          operatingSystem: operatingSystem.trim(),
          deviceClass,
          deviceModel: deviceModel.trim(),
          userAgent: navigator.userAgent,
          hardwareConcurrency: navigator.hardwareConcurrency || null,
          deviceMemoryGiB: (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null,
          audioSampleRate: context.sampleRate,
        },
        fixtures,
        observations,
        durationComparisons,
      };
      setReport(reportData);
      setStatus(`${trialCount} paired comparisons per donor duration finished. Review or download the measurements below.`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      setError(message);
      setStatus("The benchmark could not finish on this browser.");
    } finally {
      layersRef.current?.dispose();
      layersRef.current = null;
      audioRef.current?.pause();
      audioRef.current = null;
      for (const url of donorUrls) URL.revokeObjectURL(url);
      if (baselineUrlRef.current) URL.revokeObjectURL(baselineUrlRef.current);
      baselineUrlRef.current = null;
      await contextRef.current?.close().catch(() => undefined);
      contextRef.current = null;
      setRunning(false);
    }
  };

  const downloadReport = () => {
    if (!report) return;
    if (reportUrlRef.current) URL.revokeObjectURL(reportUrlRef.current);
    reportUrlRef.current = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = reportUrlRef.current;
    link.download = `waveyard-stem-swap-${report.environment.deviceClass.toLowerCase()}-${new Date(report.measuredAt).toISOString().slice(0, 10)}.json`;
    link.click();
  };

  const copyReport = async () => {
    if (!report) return;
    await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
    setStatus("The JSON report was copied to the clipboard.");
  };

  const importReports = async (files: FileList | null, input: HTMLInputElement) => {
    if (!files?.length) return;
    const accepted: LoadedDeviceReport[] = [];
    const failures: string[] = [];
    for (const [index, file] of Array.from(files).entries()) {
      try {
        const parsed: unknown = JSON.parse(await file.text());
        accepted.push({
          id: `${file.name}-${file.lastModified}-${file.size}-${index}-${Date.now()}`,
          filename: file.name,
          report: parseDeviceReport(parsed),
        });
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : "Could not read this file.";
        failures.push(`${file.name}: ${detail}`);
      }
    }
    if (accepted.length) setLoadedReports(previous => [...previous, ...accepted]);
    setImportError(failures.join(" "));
    input.value = "";
  };

  const comparisonGroups = groupDeviceReports(loadedReports);

  return (
    <div className="mx-auto max-w-3xl space-y-6 py-6 text-slate-100" data-testid="stem-device-benchmark">
      <header className="space-y-3">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-cyan-300">Waveyard · device performance</p>
        <h1 className="text-3xl font-bold tracking-tight">Measure live stem swaps</h1>
        <p className="max-w-2xl text-sm leading-6 text-slate-300">
          Compare native-tempo and tempo-matched swaps with the same audio engine used by Waveyard. Run this page in the
          phone or tablet browser itself; a desktop-sized or emulated viewport is not a real-device result.
        </p>
      </header>

      <section className="rounded-2xl border border-white/10 bg-slate-900/70 p-5" aria-labelledby="device-details-heading">
        <h2 id="device-details-heading" className="text-lg font-semibold">Device details</h2>
        <p className="mt-1 text-sm text-slate-400">Browser and OS are detected where possible. Confirm or edit them before measuring.</p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span>Browser and version</span>
            <input aria-label="Browser and version" value={browser} onChange={event => setBrowser(event.target.value)}
              className="w-full rounded-lg border border-white/15 bg-slate-950 px-3 py-2 text-white" />
          </label>
          <label className="space-y-1 text-sm">
            <span>Operating system</span>
            <input aria-label="Operating system" value={operatingSystem} onChange={event => setOperatingSystem(event.target.value)}
              className="w-full rounded-lg border border-white/15 bg-slate-950 px-3 py-2 text-white" />
          </label>
          <label className="space-y-1 text-sm">
            <span>Device class</span>
            <select aria-label="Device class" value={deviceClass} onChange={event => setDeviceClass(event.target.value as DeviceClass)}
              className="w-full rounded-lg border border-white/15 bg-slate-950 px-3 py-2 text-white">
              <option>Phone</option>
              <option>Tablet</option>
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span>Device model (optional)</span>
            <input aria-label="Device model (optional)" value={deviceModel} onChange={event => setDeviceModel(event.target.value)}
              placeholder="For example, iPhone 15"
              className="w-full rounded-lg border border-white/15 bg-slate-950 px-3 py-2 text-white placeholder:text-slate-500" />
          </label>
          <label className="space-y-1 text-sm sm:col-span-2">
            <span>Paired trials per tempo mode</span>
            <select aria-label="Paired trials per tempo mode" value={trialCount}
              onChange={event => setTrialCount(Number(event.target.value))}
              className="w-full rounded-lg border border-white/15 bg-slate-950 px-3 py-2 text-white">
              {[3, 5, 10, 15, 20].map(count => <option key={count} value={count}>{count} pairs ({count * 2} swaps)</option>)}
            </select>
          </label>
        </div>
      </section>

      <section className="rounded-2xl border border-cyan-300/20 bg-cyan-950/20 p-5">
        <h2 className="text-lg font-semibold">Before you start</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-slate-300">
          <li>Use a physical phone or tablet, not desktop browser emulation.</li>
          <li>Keep the browser foregrounded and avoid other heavy tasks during the run.</li>
          <li>The page plays a quiet synthetic test tone after you start it; lower your volume if needed.</li>
          <li>The fixture is generated locally, so download timing is not a mobile-network measurement.</li>
          <li>Measurements are reported for comparison only; there is no universal latency pass/fail threshold.</li>
        </ul>
        <button type="button" data-testid="run-stem-device-benchmark" disabled={running}
          onClick={() => void runBenchmark()}
          className="mt-5 min-h-12 w-full rounded-xl bg-cyan-300 px-4 py-3 font-bold text-slate-950 disabled:cursor-wait disabled:opacity-60">
          {running ? "Measuring swaps…" : "Start paired measurements"}
        </button>
        <p role="status" aria-live="polite" className="mt-3 text-sm text-slate-300" data-testid="stem-benchmark-status">{status}</p>
        {error && <p role="alert" className="mt-2 text-sm text-rose-300">{error}</p>}
      </section>

      {report && <section className="space-y-4 rounded-2xl border border-white/10 bg-slate-900/70 p-5"
        aria-labelledby="results-heading" data-testid="stem-benchmark-results" data-report={JSON.stringify(report)}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="results-heading" className="text-xl font-semibold">Comparative results</h2>
            <p className="mt-1 text-sm text-slate-400">
              {report.environment.browser} · {report.environment.operatingSystem} · {report.environment.deviceClass}
              {report.environment.deviceModel ? ` · ${report.environment.deviceModel}` : ""}
            </p>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={downloadReport} className="rounded-lg bg-white/10 px-3 py-2 text-sm font-semibold hover:bg-white/15">
              Download JSON
            </button>
            <button type="button" onClick={() => void copyReport()} className="rounded-lg bg-white/10 px-3 py-2 text-sm font-semibold hover:bg-white/15">
              Copy JSON
            </button>
          </div>
        </div>
        <div className="space-y-4">
          {report.durationComparisons.map(comparison => (
            <article key={comparison.durationSeconds} className="rounded-xl border border-cyan-300/15 bg-slate-950/60 p-4"
              data-testid="stem-duration-comparison">
              <h3 className="font-semibold">{comparison.durationSeconds}-second donor</h3>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <Metric label="Native-tempo median" value={comparison.nativeTempoMedianMs} />
                <Metric label="Tempo-matched median" value={comparison.tempoMatchedMedianMs} />
                <Metric label="Matched minus native" value={comparison.tempoMatchedMinusNativeMedianMs} signed />
              </div>
              <p className="mt-3 text-sm text-slate-300">
                Tempo matching changed the median selection-to-audible time by{" "}
                <strong>{comparison.tempoMatchedChangePercent === null
                  ? "not enough to calculate a percentage"
                  : `${comparison.tempoMatchedChangePercent >= 0 ? "+" : ""}${FORMATTERS.format(comparison.tempoMatchedChangePercent)}%`}</strong>
                {" "}for this duration on this device. This is a comparison, not a pass/fail threshold.
              </p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[34rem] border-collapse text-left text-sm">
                  <thead><tr className="border-b border-white/10 text-slate-400">
                    <th className="py-2 pr-3 font-medium">Median stage (ms)</th>
                    <th className="px-3 py-2 font-medium">Native tempo</th>
                    <th className="px-3 py-2 font-medium">Tempo matched</th>
                  </tr></thead>
                  <tbody>
                    {([
                      ["Download", "downloadMs"],
                      ["Decode", "decodeMs"],
                      ["Tempo matching", "tempoMatchMs"],
                      ["Selection to audible", "selectionToAudibleMs"],
                    ] as const).map(([label, field]) => (
                      <tr key={field} className="border-b border-white/5">
                        <th className="py-2 pr-3 font-medium text-slate-200">{label}</th>
                        <td className="px-3 py-2 tabular-nums">{FORMATTERS.format(comparison.nativeStagesMedianMs[field])}</td>
                        <td className="px-3 py-2 tabular-nums">{FORMATTERS.format(comparison.tempoMatchedStagesMedianMs[field])}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          ))}
        </div>
        <p className="text-xs leading-5 text-slate-500">
          The JSON report includes every individual swap, user-agent string, sample details, and the phone/tablet metadata.
          It records locally generated 8- and 30-second stereo WAV donors separately; keep reports from different devices
          to compare browser and hardware effects. Download timing covers local fixture retrieval, not network latency.
        </p>
      </section>}

      <section className="space-y-4 rounded-2xl border border-white/10 bg-slate-900/70 p-5"
        aria-labelledby="multi-device-comparison-heading" data-testid="multi-device-comparison">
        <div>
          <h2 id="multi-device-comparison-heading" className="text-xl font-semibold">Compare device reports</h2>
          <p className="mt-1 text-sm leading-6 text-slate-400">
            Load exported benchmark JSON files to compare native-tempo and tempo-matched timing by donor duration.
            Reports are grouped by browser, operating system, device class, and duration.
          </p>
        </div>
        <label className="block space-y-2 text-sm">
          <span className="font-medium">Benchmark JSON reports</span>
          <input type="file" accept=".json,application/json" multiple
            aria-label="Load benchmark JSON reports"
            onChange={event => void importReports(event.currentTarget.files, event.currentTarget)}
            className="block w-full rounded-lg border border-white/15 bg-slate-950 p-3 text-slate-200 file:mr-3 file:rounded-md file:border-0 file:bg-white/10 file:px-3 file:py-2 file:font-semibold file:text-white" />
        </label>
        {importError && <p role="alert" className="text-sm leading-6 text-rose-300">{importError}</p>}
        {loadedReports.length > 0 && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-slate-300" role="status">
                {loadedReports.length} report{loadedReports.length === 1 ? "" : "s"} loaded
              </p>
              <button type="button" onClick={() => { setLoadedReports([]); setImportError(""); }}
                className="rounded-lg bg-white/10 px-3 py-2 text-sm font-semibold hover:bg-white/15">
                Clear reports
              </button>
            </div>
            <ul className="divide-y divide-white/5 rounded-xl border border-white/10">
              {loadedReports.map(loaded => (
                <li key={loaded.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0 break-all text-slate-200">
                    {loaded.filename}
                    <span className="ml-2 text-slate-500">
                      {loaded.report.environment.deviceModel || "Device model not provided"} · {new Date(loaded.report.measuredAt).toLocaleDateString()}
                    </span>
                  </span>
                  <button type="button" aria-label={`Remove ${loaded.filename}`}
                    onClick={() => setLoadedReports(previous => previous.filter(item => item.id !== loaded.id))}
                    className="rounded-md px-2 py-1 text-slate-400 hover:bg-white/10 hover:text-white">
                    Remove
                  </button>
                </li>
              ))}
            </ul>
            <div className="space-y-4">
              {comparisonGroups.map(group => (
                <article key={`${group.browser}-${group.operatingSystem}-${group.deviceClass}-${group.durationSeconds ?? "unknown"}`}
                  className="rounded-xl border border-cyan-300/15 bg-slate-950/60 p-4"
                  data-testid="device-comparison-group">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <h3 className="font-semibold">{group.browser}</h3>
                    <p className="text-sm text-slate-400">
                      {group.operatingSystem} · {group.deviceClass} · {group.durationSeconds === null ? "Duration unknown" : `${group.durationSeconds}-second donor`}
                    </p>
                    </div>
                    <span className="text-xs text-slate-500">{group.reports.length} report{group.reports.length === 1 ? "" : "s"}</span>
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-3">
                    <Metric label={`Native tempo · ${group.nativeSampleCount} swaps`} value={group.nativeTempoMedianMs} />
                    <Metric label={`Tempo matched · ${group.tempoMatchedSampleCount} swaps`} value={group.tempoMatchedMedianMs} />
                    <Metric label="Matched minus native" value={group.tempoMatchedMinusNativeMedianMs} signed />
                  </div>
                  <p className="mt-3 text-xs leading-5 text-slate-400">
                    Medians combine individual observations for this duration across these reports. They describe the measured devices;
                    they are not judged against a pass/fail latency threshold.
                  </p>
                </article>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value, signed = false }: { label: string; value: number; signed?: boolean }) {
  return <div className="rounded-xl bg-slate-950/70 p-4">
    <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
    <p className="mt-2 text-2xl font-bold tabular-nums">
      {signed && value > 0 ? "+" : ""}{FORMATTERS.format(value)} <span className="text-sm font-medium text-slate-400">ms</span>
    </p>
  </div>;
}
