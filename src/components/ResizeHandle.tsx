import { useRef, useState } from 'react';

interface Props {
  /** Current width of the panel being resized. */
  value: number;
  min: number;
  max: number;
  /** +1 when dragging right grows the panel (left-docked), -1 otherwise. */
  direction: 1 | -1;
  onChange: (width: number) => void;
  onCommit: () => void;
  label: string;
}

/** Pointer-captured splitter; arrow keys resize for keyboard users. */
export function ResizeHandle({ value, min, max, direction, onChange, onCommit, label }: Props) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (v: number) => Math.round(Math.max(min, Math.min(max, v)));

  return (
    <div
      className="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      data-dragging={dragging || undefined}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width: value };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!start.current) return;
        onChange(clamp(start.current.width + (e.clientX - start.current.x) * direction));
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        start.current = null;
        setDragging(false);
        onCommit();
      }}
      onDoubleClick={() => {
        onChange(clamp(260));
        onCommit();
      }}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const delta = (e.key === 'ArrowRight' ? 16 : -16) * direction;
        onChange(clamp(value + delta));
        onCommit();
      }}
    />
  );
}
