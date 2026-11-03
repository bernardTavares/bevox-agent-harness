import { useEffect, useRef, useState } from "react";

interface Props {
  totalMs: number;
  value: number;
  onChange: (v: number) => void;
}

const SPEEDS = [1, 2, 5, 10];

export function ReplaySlider({ totalMs, value, onChange }: Props) {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const raf = useRef<number | null>(null);
  const lastTick = useRef<number | null>(null);

  useEffect(() => {
    if (!playing) {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      raf.current = null;
      lastTick.current = null;
      return;
    }
    const loop = (now: number) => {
      if (lastTick.current === null) lastTick.current = now;
      const delta = (now - lastTick.current) * speed;
      lastTick.current = now;
      const next = Math.min(totalMs, value + delta);
      onChange(next);
      if (next >= totalMs) {
        setPlaying(false);
        return;
      }
      raf.current = requestAnimationFrame(loop);
    };
    raf.current = requestAnimationFrame(loop);
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, [playing, speed, totalMs, value, onChange]);

  return (
    <div className="row" style={{ padding: "8px 12px", gap: 8 }}>
      <button onClick={() => setPlaying((p) => !p)}>{playing ? "⏸" : "▶"}</button>
      <button
        onClick={() => {
          setPlaying(false);
          onChange(0);
        }}
      >
        ⏮
      </button>
      <button
        onClick={() => {
          setPlaying(false);
          onChange(totalMs);
        }}
      >
        ⏭
      </button>
      <input
        type="range"
        min={0}
        max={Math.max(1, totalMs)}
        value={Math.min(value, totalMs)}
        onChange={(e) => {
          setPlaying(false);
          onChange(Number(e.target.value));
        }}
        style={{ flex: 1 }}
      />
      <span className="dim" style={{ width: 90, textAlign: "right" }}>
        {value.toFixed(0)} / {totalMs.toFixed(0)} ms
      </span>
      <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
        {SPEEDS.map((s) => (
          <option key={s} value={s}>
            {s}x
          </option>
        ))}
      </select>
    </div>
  );
}
