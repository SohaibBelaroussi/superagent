import Svg, { Circle, Path } from 'react-native-svg';
import { useTheme } from './theme';

/** The superagent mark: the chief above two departments (as in the web app). */
export function Logo({ size = 32 }: { size?: number }) {
  const theme = useTheme();
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      accessibilityElementsHidden
      importantForAccessibility="no"
    >
      <Path
        d="M16 11.5 10 20.5M16 11.5l6 9"
        fill="none"
        stroke={theme.colors.brand}
        strokeWidth={2}
        strokeLinecap="round"
      />
      <Circle cx={16} cy={10} r={3.5} fill={theme.colors.brand} />
      <Circle cx={9.5} cy={21.5} r={3} fill={theme.colors.foreground} />
      <Circle cx={22.5} cy={21.5} r={3} fill={theme.colors.foreground} />
    </Svg>
  );
}
