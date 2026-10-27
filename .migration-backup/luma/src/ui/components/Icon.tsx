/**
 * A small, dependency-light line-icon set (react-native-svg) used across the
 * camera and editor controls. Keeps the visual language consistent and avoids an
 * icon-font dependency.
 */

import React from 'react';
import Svg, { Circle, Line, Path, Polyline, Rect } from 'react-native-svg';

export type IconName =
  | 'flip'
  | 'flash-on'
  | 'flash-off'
  | 'flash-auto'
  | 'close'
  | 'check'
  | 'undo'
  | 'redo'
  | 'reset'
  | 'compare'
  | 'share'
  | 'download'
  | 'image'
  | 'plus'
  | 'text'
  | 'shape'
  | 'sticker'
  | 'trash'
  | 'chevron-up'
  | 'chevron-down'
  | 'eye'
  | 'eye-off';

interface Props {
  name: IconName;
  color?: string;
  size?: number;
  strokeWidth?: number;
}

export function Icon({ name, color = '#F5F5F7', size = 22, strokeWidth = 1.9 }: Props) {
  const p = { stroke: color, strokeWidth, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' as const };
  const S = ({ children }: { children: React.ReactNode }) => (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {children}
    </Svg>
  );

  switch (name) {
    case 'flip':
      return (
        <S>
          <Path d="M4 8a8 8 0 0 1 14-3M20 16a8 8 0 0 1-14 3" {...p} />
          <Polyline points="18 3 18 6 15 6" {...p} />
          <Polyline points="6 21 6 18 9 18" {...p} />
        </S>
      );
    case 'flash-on':
      return (
        <S>
          <Path d="M13 3 5 13h5l-1 8 8-11h-5l1-7Z" {...p} fill={color} />
        </S>
      );
    case 'flash-off':
      return (
        <S>
          <Path d="M13 3 5 13h5l-1 8 8-11h-5l1-7Z" {...p} />
          <Line x1={4} y1={4} x2={20} y2={20} {...p} />
        </S>
      );
    case 'flash-auto':
      return (
        <S>
          <Path d="M11 3 4 12h4l-1 6 6-8H9l2-7Z" {...p} />
          <Path d="M15 15l2-5 2 5M15.6 13.5h2.8" {...p} />
        </S>
      );
    case 'close':
      return (
        <S>
          <Line x1={6} y1={6} x2={18} y2={18} {...p} />
          <Line x1={18} y1={6} x2={6} y2={18} {...p} />
        </S>
      );
    case 'check':
      return (
        <S>
          <Polyline points="5 12 10 17 19 6" {...p} />
        </S>
      );
    case 'undo':
      return (
        <S>
          <Path d="M9 7 4 12l5 5" {...p} />
          <Path d="M4 12h11a5 5 0 0 1 0 10h-1" {...p} />
        </S>
      );
    case 'redo':
      return (
        <S>
          <Path d="M15 7l5 5-5 5" {...p} />
          <Path d="M20 12H9a5 5 0 0 0 0 10h1" {...p} />
        </S>
      );
    case 'reset':
      return (
        <S>
          <Path d="M4 4v5h5" {...p} />
          <Path d="M4 9a8 8 0 1 1-1.5 6" {...p} />
        </S>
      );
    case 'compare':
      return (
        <S>
          <Rect x={3} y={5} width={18} height={14} rx={2} {...p} />
          <Line x1={12} y1={5} x2={12} y2={19} {...p} />
        </S>
      );
    case 'share':
      return (
        <S>
          <Circle cx={18} cy={5} r={2.5} {...p} />
          <Circle cx={6} cy={12} r={2.5} {...p} />
          <Circle cx={18} cy={19} r={2.5} {...p} />
          <Line x1={8.2} y1={10.8} x2={15.8} y2={6.2} {...p} />
          <Line x1={8.2} y1={13.2} x2={15.8} y2={17.8} {...p} />
        </S>
      );
    case 'download':
      return (
        <S>
          <Path d="M12 4v11" {...p} />
          <Polyline points="7 11 12 16 17 11" {...p} />
          <Path d="M5 19h14" {...p} />
        </S>
      );
    case 'image':
      return (
        <S>
          <Rect x={3} y={4} width={18} height={16} rx={2} {...p} />
          <Circle cx={8.5} cy={9.5} r={1.6} {...p} />
          <Path d="M4 17l5-4 4 3 3-2 4 3" {...p} />
        </S>
      );
    case 'plus':
      return (
        <S>
          <Line x1={12} y1={5} x2={12} y2={19} {...p} />
          <Line x1={5} y1={12} x2={19} y2={12} {...p} />
        </S>
      );
    case 'text':
      return (
        <S>
          <Path d="M5 6h14M12 6v13" {...p} />
        </S>
      );
    case 'shape':
      return (
        <S>
          <Rect x={4} y={4} width={11} height={11} rx={1.5} {...p} />
          <Circle cx={16} cy={16} r={4} {...p} />
        </S>
      );
    case 'sticker':
      return (
        <S>
          <Path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8l-6 6H6a2 2 0 0 1-2-2V6Z" {...p} />
          <Path d="M14 20v-4a2 2 0 0 1 2-2h4" {...p} />
        </S>
      );
    case 'trash':
      return (
        <S>
          <Path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" {...p} />
        </S>
      );
    case 'chevron-up':
      return (
        <S>
          <Polyline points="6 15 12 9 18 15" {...p} />
        </S>
      );
    case 'chevron-down':
      return (
        <S>
          <Polyline points="6 9 12 15 18 9" {...p} />
        </S>
      );
    case 'eye':
      return (
        <S>
          <Path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" {...p} />
          <Circle cx={12} cy={12} r={3} {...p} />
        </S>
      );
    case 'eye-off':
      return (
        <S>
          <Path d="M4 5l16 14M9.5 9.6A3 3 0 0 0 12 15a3 3 0 0 0 2.4-1.2" {...p} />
          <Path d="M6.5 6.9C3.9 8.4 2 12 2 12s3.5 7 10 7a11 11 0 0 0 4-.8M9 4.6A11 11 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.4 3.2" {...p} />
        </S>
      );
  }
}
