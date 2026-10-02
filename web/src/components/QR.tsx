import qrcode from 'qrcode-generator';

/** A QR code for a link (rendered locally — the link never leaves the device). */
export default function QR({ value, label }: { value: string; label: string }) {
  const q = qrcode(0, 'M');
  q.addData(value);
  q.make();
  const n = q.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + 2} ${r + 2}h1v1h-1z`;
  return (
    <span className="qr" role="img" aria-label={label}>
      <svg viewBox={`0 0 ${n + 4} ${n + 4}`} shapeRendering="crispEdges">
        <path d={d} fill="#000" />
      </svg>
    </span>
  );
}
