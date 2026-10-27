import {
  automationLinearSegments,
  evaluateAutomation,
  type AutomationPoint,
} from "@waveyard/types";

function decimal(value: number) {
  return Number(value.toFixed(9)).toString();
}

/**
 * FFmpeg's volume filter evaluates this expression once per frame. Its pieces
 * come from the shared V1 linear evaluator, in absolute remix seconds.
 */
export function ffmpegAutomationExpression(
  points: AutomationPoint[],
  defaultValue: number,
) {
  if (!points.length) return decimal(defaultValue);
  const ordered = [...points].sort((left, right) => left.timelineMs - right.timelineMs);
  if (ordered.length === 1) return decimal(evaluateAutomation(ordered, ordered[0].timelineMs, defaultValue));
  const first = ordered[0];
  let expression = decimal(evaluateAutomation(ordered, ordered.at(-1)!.timelineMs, defaultValue));
  for (const segment of automationLinearSegments(ordered).reverse()) {
    const startSeconds = decimal(segment.startMs / 1000);
    const endSeconds = decimal(segment.endMs / 1000);
    const slope = `(${decimal(segment.endValue)}-${decimal(segment.startValue)})*(t-${startSeconds})/(${endSeconds}-${startSeconds})`;
    expression = `if(lt(t\\,${endSeconds})\\,${decimal(segment.startValue)}+${slope}\\,${expression})`;
  }
  return `if(lt(t\\,${decimal(first.timelineMs / 1000)})\\,${decimal(first.value)}\\,${expression})`;
}

/** Equal-power pan is the existing static panning law, expressed per frame. */
export function ffmpegPanGainExpressions(
  panPoints: AutomationPoint[],
  staticPan: number,
  volumeExpression: string,
) {
  const pan = ffmpegAutomationExpression(panPoints, staticPan);
  return {
    left: `(${volumeExpression})*cos(((${pan})+1)*PI/4)`,
    right: `(${volumeExpression})*sin(((${pan})+1)*PI/4)`,
  };
}

/** Track-bus filters keep clip gain/fades separate from track automation. */
export function automatedTrackBusFilters(
  clipLabels: string[],
  trackLabel: string,
  volumePoints: AutomationPoint[],
  panPoints: AutomationPoint[],
  staticVolume: number,
  staticPan: number,
) {
  const volume = ffmpegAutomationExpression(volumePoints, staticVolume);
  const gains = ffmpegPanGainExpressions(panPoints, staticPan, volume);
  const raw = `${trackLabel}raw`;
  const left = `${trackLabel}left`;
  const right = `${trackLabel}right`;
  return [
    `${clipLabels.join("")}amix=inputs=${clipLabels.length}:duration=longest:dropout_transition=0:normalize=0[${raw}]`,
    `[${raw}]asplit=2[${left}in][${right}in]`,
    `[${left}in]pan=mono|c0=c0,volume='${gains.left}':eval=frame[${left}]`,
    `[${right}in]pan=mono|c0=c1,volume='${gains.right}':eval=frame[${right}]`,
    `[${left}][${right}]join=inputs=2:channel_layout=stereo[${trackLabel}]`,
  ];
}
