/**
 * Minimal line icons for the tab bar, drawn with react-native-svg so we avoid an
 * icon-font dependency and keep the visual language restrained and crisp.
 */

import React from 'react';
import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

export type TabIconName = 'camera' | 'sliders' | 'layers' | 'gear';

interface Props {
  name: TabIconName;
  color: string;
  size?: number;
}

export function TabIcon({ name, color, size = 24 }: Props) {
  const sw = 1.8;
  switch (name) {
    case 'camera':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path
            d="M4 8.5A1.5 1.5 0 0 1 5.5 7h1.9l1.1-1.6A1 1 0 0 1 9.3 5h5.4a1 1 0 0 1 .8.4L16.6 7h1.9A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-9Z"
            stroke={color}
            strokeWidth={sw}
            strokeLinejoin="round"
          />
          <Circle cx={12} cy={13} r={3.2} stroke={color} strokeWidth={sw} />
        </Svg>
      );
    case 'sliders':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Line x1={4} y1={8} x2={20} y2={8} stroke={color} strokeWidth={sw} strokeLinecap="round" />
          <Line x1={4} y1={16} x2={20} y2={16} stroke={color} strokeWidth={sw} strokeLinecap="round" />
          <Circle cx={9} cy={8} r={2.6} fill={color} />
          <Circle cx={15} cy={16} r={2.6} fill={color} />
        </Svg>
      );
    case 'layers':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path d="M12 4 3 9l9 5 9-5-9-5Z" stroke={color} strokeWidth={sw} strokeLinejoin="round" />
          <Path d="M4 14l8 4.5L20 14" stroke={color} strokeWidth={sw} strokeLinejoin="round" strokeLinecap="round" />
        </Svg>
      );
    case 'gear':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Circle cx={12} cy={12} r={3} stroke={color} strokeWidth={sw} />
          <Path
            d="M12 3v2.5M12 18.5V21M4.2 7l2.1 1.2M17.7 15.8 19.8 17M4.2 17l2.1-1.2M17.7 8.2 19.8 7"
            stroke={color}
            strokeWidth={sw}
            strokeLinecap="round"
          />
          <Rect x={0} y={0} width={0} height={0} fill="none" />
        </Svg>
      );
  }
}
