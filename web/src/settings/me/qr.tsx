import { useMemo } from "react";
import qrcode from "qrcode-generator";

interface Props {
  /** What the code says: here, an otpauth:// address. */
  value: string;
  /** Said by screen readers. */
  label: string;
  size?: number;
}

/**
 * A QR code drawn as one SVG path. It is black on white in both themes with
 * the quiet border scanners need, so a phone reads it from a dark screen too.
 */
export function QrCode({ value, label, size = 176 }: Props) {
  const { path, count } = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    let path = "";
    for (let row = 0; row < count; row++) {
      for (let col = 0; col < count; col++) {
        if (qr.isDark(row, col)) path += `M${col} ${row}h1v1h-1z`;
      }
    }
    return { path, count };
  }, [value]);
  const quiet = 4;
  const box = count + quiet * 2;
  return (
    <svg
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a picture drawn with CSS or SVG, not an image file
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`${-quiet} ${-quiet} ${box} ${box}`}
      shapeRendering="crispEdges"
      className="shrink-0 rounded-md border border-line"
    >
      <rect x={-quiet} y={-quiet} width={box} height={box} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
