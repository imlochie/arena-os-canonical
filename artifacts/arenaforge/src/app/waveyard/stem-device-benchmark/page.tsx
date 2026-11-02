import { useEffect, useRef, useState } from "react";
import { LiveStemLayers, type LiveStemTiming } from "@workspace/arena/lib/waveyard/live-stem-layers";

type DeviceClass = "Phone" | "Tablet";
type Mode = "nativeTempo" | "tempoMatched";
type Observation = LiveStemTiming & {
  trial: number;
  mode: Mode;
  observedSelectionToAudibleMs: number;
};
type DeviceReport = {
  schemaVersion: 1;
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
  fixture: {
    source: string;
    durationSeconds: number;
    sampleRate: number;
    transferBytes: number;
    tempoRatio: number;
  };
  observations: Observation[];
  comparison: {
    nativeTempoMedianMs: number;
    tempoMatchedMedianMs: number;
    tempoMatchedMinusNativeMedianMs: number;
    tempoMatchedChangePercent: number | null;
    nativeStagesMedianMs: Record<string, number>;
    tempoMatchedStagesMedianMs: Record<string, number>;
  };
};

const FIXTURE_SECONDS = 8;
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
      const fixture = createWaveFixture(FIXTURE_SECONDS);
      const fixtureBlob = new Blob([fixture], { type: "audio/wav" });
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
      const modes: Mode[] = ["nativeTempo", "tempoMatched"];
      for (let trial = 1; trial <= trialCount; trial += 1) {
        // Alternate the order in each pair so thermal or background-load drift
        // is less likely to favor one tempo mode consistently.
        const order = trial % 2 === 1 ? modes : [...modes].reverse();
        for (const mode of order) {
          const ratio = mode === "nativeTempo" ? 1 : TEMPO_RATIO;
          const donorUrl = URL.createObjectURL(new Blob([fixture], { type: "audio/wav" }));
          donorUrls.push(donorUrl);
          let resolveTiming!: (timing: LiveStemTiming) => void;
          const timingReady = new Promise<LiveStemTiming>(resolve => { resolveTiming = resolve; });
          resolveActiveTiming = resolveTiming;
          const selectedAt = performance.now();
          setStatus(`Trial ${trial} of ${trialCount}: ${mode === "nativeTempo" ? "native tempo" : "tempo matched"}…`);
          await layers.replace(BENCHMARK_CHANNEL, donorUrl, ratio, selectedAt);
          const timing = await timingReady;
          resolveActiveTiming = null;
          observations.push({
            ...timing,
            trial,
            mode,
            observedSelectionToAudibleMs: Math.max(0, performance.now() - selectedAt),
          });
          await new Promise(resolve => setTimeout(resolve, 120));
          await layers.replace(BENCHMARK_CHANNEL, null);
        }
      }

      const native = observations.filter(item => item.mode === "nativeTempo");
      const matched = observations.filter(item => item.mode === "tempoMatched");
      const nativeMedian = median(native.map(item => item.observedSelectionToAudibleMs));
      const matchedMedian = median(matched.map(item => item.observedSelectionToAudibleMs));
      const reportData: DeviceReport = {
        schemaVersion: 1,
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
        fixture: {
          source: "Browser-generated synthetic WAV retrieved from a local Blob URL",
          durationSeconds: FIXTURE_SECONDS,
          sampleRate: FIXTURE_SAMPLE_RATE,
          transferBytes: fixture.byteLength,
          tempoRatio: TEMPO_RATIO,
        },
        observations,
        comparison: {
          nativeTempoMedianMs: nativeMedian,
          tempoMatchedMedianMs: matchedMedian,
          tempoMatchedMinusNativeMedianMs: matchedMedian - nativeMedian,
          tempoMatchedChangePercent: nativeMedian > 0 ? ((matchedMedian - nativeMedian) / nativeMedian) * 100 : null,
          nativeStagesMedianMs: medianStages(native),
          tempoMatchedStagesMedianMs: medianStages(matched),
        },
      };
      setReport(reportData);
      setStatus(`${trialCount} paired comparisons finished. Review or download the measurements below.`);
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
        <div className="grid gap-3 sm:grid-cols-3">
          <Metric label="Native-tempo median" value={report.comparison.nativeTempoMedianMs} />
          <Metric label="Tempo-matched median" value={report.comparison.tempoMatchedMedianMs} />
          <Metric label="Matched minus native" value={report.comparison.tempoMatchedMinusNativeMedianMs} signed />
        </div>
        <p className="text-sm text-slate-300">
          Tempo matching changed the median selection-to-audible time by{" "}
          <strong>{report.comparison.tempoMatchedChangePercent === null
            ? "not enough to calculate a percentage"
            : `${report.comparison.tempoMatchedChangePercent >= 0 ? "+" : ""}${FORMATTERS.format(report.comparison.tempoMatchedChangePercent)}%`}</strong>
          {" "}on this device. This is a comparison, not a pass/fail threshold.
        </p>
        <div className="overflow-x-auto">
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
                  <td className="px-3 py-2 tabular-nums">{FORMATTERS.format(report.comparison.nativeStagesMedianMs[field])}</td>
                  <td className="px-3 py-2 tabular-nums">{FORMATTERS.format(report.comparison.tempoMatchedStagesMedianMs[field])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs leading-5 text-slate-500">
          The JSON report includes every individual swap, user-agent string, sample details, and the phone/tablet metadata.
          The donor is an 8-second, locally generated stereo WAV; keep reports from different devices to compare
          browser and hardware effects. Download timing covers local fixture retrieval, not network latency.
        </p>
      </section>}
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
