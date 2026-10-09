import { useMemo } from 'react';
import { encode } from 'uqr';
import { cn } from '../lib/cn';

/**
 * A QR code, drawn as one SVG path (no markup from a string, nothing the CSP refuses). Dark modules on
 * light paper in both themes, with the quiet zone scanners need.
 */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const { size, path } = useMemo(() => {
    const { size, data } = encode(value, { ecc: 'M', border: 2 });
    let d = '';
    data.forEach((row, y) => {
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      });
    });
    return { size, path: d };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className={cn('rounded-lg bg-qr-paper', className)}
    >
      <path d={path} className="fill-qr-ink" />
    </svg>
  );
}
