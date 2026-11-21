"use client";

import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { fmtPrice, fmtUsd } from "@/lib/format";
import type { Candle } from "@/lib/types";
import { cx } from "./ui/primitives";

export type ChartTimeframe = "1M" | "1S";

const AXIS_W = 58; // right price axis
const TIME_H = 16; // bottom time axis
const VOL_SHARE = 0.22; // share of plot height used by the volume histogram
const GAP = 6; // gap between price and volume panes
const FONT = "10px var(--font-geist-mono), ui-monospace, monospace";

interface Palette {
  panel: string;
  line: string;
  fg: string;
  fg2: string;
  fg3: string;
  gain: string;
  loss: string;
}

function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el);
  const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  return {
    panel: v("--panel", "#0f1217"),
    line: v("--line", "#1e242d"),
    fg: v("--fg", "#f1f5f9"),
    fg2: v("--fg-2", "#8b949e"),
    fg3: v("--fg-3", "#484f58"),
    gain: v("--gain", "#10b981"),
    loss: v("--loss", "#ef4444"),
  };
}

function fmtTime(t: number, tf: ChartTimeframe): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return tf === "1S" ? `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` : `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Up to 5 evenly spaced price gridlines on round values. */
function niceTicks(lo: number, hi: number, count = 4): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-12; v += step) out.push(v);
  return out.slice(0, 6);
}

const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const compactNum = (v: number) => compactFmt.format(v);

/** Short series keep a minimum candle width instead of stretching across the whole chart. */
const slotCount = (n: number) => Math.max(n, 30);

/** Snaps a coordinate to the device pixel grid so 1px lines stay crisp. */
const crisp = (x: number, dpr: number) => (Math.round(x * dpr) + 0.5) / dpr;

export function MicroChart({
  candles,
  timeframe,
  height = 240,
  emptyLabel,
}: {
  candles: readonly Candle[];
  timeframe: ChartTimeframe;
  height?: number;
  emptyLabel: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const sizeRef = useRef({ w: 0, h: height, dpr: 1 });
  const frame = useRef<number | null>(null);
  const [hover, setHover] = useState<Candle | null>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { w, h, dpr } = sizeRef.current;
    if (w <= 0 || h <= 0) return;

    const pal = readPalette(canvas);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = FONT;
    ctx.textBaseline = "middle";

    const plotW = Math.max(10, w - AXIS_W);
    const plotH = h - TIME_H;
    const volH = Math.round(plotH * VOL_SHARE);
    const priceH = plotH - volH - GAP;

    // Frame / pane separators
    ctx.strokeStyle = pal.line;
    ctx.lineWidth = 1 / dpr;
    ctx.beginPath();
    ctx.moveTo(crisp(plotW, dpr), 0);
    ctx.lineTo(crisp(plotW, dpr), plotH);
    ctx.moveTo(0, crisp(plotH, dpr));
    ctx.lineTo(w, crisp(plotH, dpr));
    ctx.moveTo(0, crisp(priceH + GAP / 2, dpr));
    ctx.lineTo(plotW, crisp(priceH + GAP / 2, dpr));
    ctx.stroke();

    const n = candles.length;
    if (n === 0) {
      ctx.fillStyle = pal.fg3;
      ctx.textAlign = "center";
      ctx.fillText(emptyLabel, plotW / 2, priceH / 2);
      return;
    }

    const cw = plotW / slotCount(n);
    const bodyW = Math.max(1, Math.floor(cw * 0.7 * dpr) / dpr);
    const x0 = plotW - n * cw; // right-align newest candle

    let lo = Infinity;
    let hi = -Infinity;
    let vmax = 0;
    const useTurnover = candles.some((c) => c.a > 0);
    for (const c of candles) {
      if (c.l < lo) lo = c.l;
      if (c.h > hi) hi = c.h;
      const vv = useTurnover ? c.a : c.v;
      if (vv > vmax) vmax = vv;
    }
    if (!(hi > lo)) {
      const pad = Math.max(Math.abs(hi) * 0.001, 1e-9);
      hi += pad;
      lo -= pad;
    }
    const padY = (hi - lo) * 0.08;
    hi += padY;
    lo -= padY;
    const y = (p: number) => ((hi - p) / (hi - lo)) * priceH;

    // Price gridlines + axis labels
    ctx.textAlign = "left";
    for (const t of niceTicks(lo, hi)) {
      const yy = crisp(y(t), dpr);
      if (yy < 6 || yy > priceH - 4) continue;
      ctx.strokeStyle = pal.line;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(plotW, yy);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = pal.fg3;
      ctx.fillText(fmtPrice(t), plotW + 5, yy);
    }

    // Candles + volume histogram
    for (let i = 0; i < n; i++) {
      const c = candles[i];
      const cx0 = x0 + i * cw + cw / 2;
      const up = c.c >= c.o;
      const col = up ? pal.gain : pal.loss;
      const xs = crisp(cx0, dpr);

      if (c.v > 0 || c.h !== c.l) {
        ctx.strokeStyle = col;
        ctx.lineWidth = 1 / dpr;
        ctx.beginPath();
        ctx.moveTo(xs, Math.round(y(c.h) * dpr) / dpr);
        ctx.lineTo(xs, Math.round(y(c.l) * dpr) / dpr);
        ctx.stroke();
      }
      const top = Math.round(y(Math.max(c.o, c.c)) * dpr) / dpr;
      const bot = Math.round(y(Math.min(c.o, c.c)) * dpr) / dpr;
      ctx.fillStyle = col;
      ctx.globalAlpha = c.v > 0 ? 1 : 0.35; // padded seconds with no trades are dimmed
      ctx.fillRect(Math.round((cx0 - bodyW / 2) * dpr) / dpr, top, bodyW, Math.max(1 / dpr, bot - top));

      const vv = useTurnover ? c.a : c.v;
      if (vmax > 0 && vv > 0) {
        const vh = Math.max(1 / dpr, (vv / vmax) * (volH - 2));
        ctx.globalAlpha = 0.45;
        ctx.fillRect(Math.round((cx0 - bodyW / 2) * dpr) / dpr, plotH - vh, bodyW, vh);
      }
      ctx.globalAlpha = 1;
    }

    // Last price line + tag
    const last = candles[n - 1];
    const ly = crisp(y(last.c), dpr);
    const lastCol = last.c >= last.o ? pal.gain : pal.loss;
    ctx.strokeStyle = lastCol;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, ly);
    ctx.lineTo(plotW, ly);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = lastCol;
    ctx.fillRect(plotW + 1, ly - 7, AXIS_W - 1, 14);
    ctx.fillStyle = pal.panel;
    ctx.fillText(fmtPrice(last.c), plotW + 5, ly);

    // Time labels
    ctx.fillStyle = pal.fg3;
    ctx.textAlign = "center";
    // Space labels by pixels (one per ~70px), not by candle count. Short series use narrow slots.
    const labelPx = timeframe === "1S" ? 74 : 56;
    const every = Math.max(1, Math.ceil(labelPx / cw));
    for (let i = n - 1; i >= 0; i -= every) {
      const xx = x0 + i * cw + cw / 2;
      if (xx < 22 || xx > plotW - 22) continue;
      ctx.fillText(fmtTime(candles[i].t, timeframe), xx, plotH + TIME_H / 2 + 1);
    }

    // Volume label
    ctx.textAlign = "left";
    // Two short lines so the label always fits inside the 58px axis.
    ctx.fillText("VOL", plotW + 5, priceH + GAP + 8);
    ctx.fillText(
      vmax > 0 ? (useTurnover ? fmtUsd(vmax) : `${compactNum(vmax)} ct`) : "—",
      plotW + 5,
      priceH + GAP + 20,
    );

    // Crosshair
    const hv = hoverRef.current;
    if (hv && hv.x >= 0 && hv.x <= plotW && hv.y >= 0 && hv.y <= plotH) {
      const idx = Math.min(n - 1, Math.max(0, Math.floor((hv.x - x0) / cw)));
      const hx = crisp(x0 + idx * cw + cw / 2, dpr);
      const hy = crisp(hv.y, dpr);
      ctx.strokeStyle = pal.fg3;
      ctx.lineWidth = 1 / dpr;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(hx, 0);
      ctx.lineTo(hx, plotH);
      if (hv.y <= priceH) {
        ctx.moveTo(0, hy);
        ctx.lineTo(plotW, hy);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      if (hv.y <= priceH) {
        const price = hi - (hv.y / priceH) * (hi - lo);
        ctx.fillStyle = pal.fg2;
        ctx.fillRect(plotW + 1, hy - 7, AXIS_W - 1, 14);
        ctx.fillStyle = pal.panel;
        ctx.fillText(fmtPrice(price), plotW + 5, hy);
      }
    }
  }, [candles, timeframe, emptyLabel]);

  // The latest draw lives in a ref, so `schedule` stays stable. Otherwise every candle update would
  // re-run the resize effect, resetting canvas.width (which clears it) and re-creating observers 4×/s.
  const drawRef = useRef(draw);
  const schedule = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      drawRef.current();
    });
  }, []);

  // Size the backing store to CSS size × devicePixelRatio, so text and lines stay sharp on HiDPI screens.
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const resize = () => {
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const w = Math.floor(wrap.clientWidth);
      const cur = sizeRef.current;
      if (cur.w === w && cur.h === height && cur.dpr === dpr && canvas.width === Math.round(w * dpr)) return;
      sizeRef.current = { w, h: height, dpr };
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(height * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${height}px`;
      schedule();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    // Redraw when the theme changes (the colors come from CSS variables).
    const mo = new MutationObserver(schedule);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    mq.addEventListener("change", resize);
    return () => {
      ro.disconnect();
      mo.disconnect();
      mq.removeEventListener("change", resize);
    };
  }, [height, schedule]);

  useEffect(() => {
    drawRef.current = draw;
    schedule();
  }, [draw, schedule]);

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - r.left;
    const yy = e.clientY - r.top;
    hoverRef.current = { x, y: yy };
    const n = candles.length;
    const plotW = Math.max(10, sizeRef.current.w - AXIS_W);
    if (n && x <= plotW) {
      const cw = plotW / slotCount(n);
      const idx = Math.floor((x - (plotW - n * cw)) / cw);
      setHover(idx >= 0 && idx < n ? candles[idx] : null);
    } else setHover(null);
    schedule();
  };
  const onLeave = () => {
    hoverRef.current = null;
    setHover(null);
    schedule();
  };

  const shown = hover ?? candles[candles.length - 1] ?? null;
  const up = shown ? shown.c >= shown.o : true;

  return (
    <div className="min-w-0">
      <div className="num flex h-8 flex-wrap content-center items-center gap-x-2.5 overflow-hidden whitespace-nowrap text-[10.5px] leading-[14px] text-fg-3 sm:h-5 sm:flex-nowrap">
        {shown ? (
          <>
            <span className="text-fg-2">{fmtTime(shown.t, timeframe)}</span>
            <span>
              O <span className="text-fg">{fmtPrice(shown.o)}</span>
            </span>
            <span>
              H <span className="text-fg">{fmtPrice(shown.h)}</span>
            </span>
            <span>
              L <span className="text-fg">{fmtPrice(shown.l)}</span>
            </span>
            <span>
              C <span className={up ? "text-gain" : "text-loss"}>{fmtPrice(shown.c)}</span>
            </span>
            <span>
              V <span className="text-fg">{shown.a > 0 ? fmtUsd(shown.a) : shown.v.toLocaleString("en-US")}</span>
            </span>
            {hover === null && <span className="hidden text-fg-3 sm:inline">live</span>}
          </>
        ) : (
          <span>—</span>
        )}
      </div>
      <div ref={wrapRef} className="relative w-full" style={{ height }}>
        <canvas
          ref={canvasRef}
          data-chart-timeframe={timeframe}
          role="img"
          aria-label={`${timeframe} candlestick chart, ${candles.length} candles`}
          onPointerMove={onMove}
          onPointerLeave={onLeave}
          className={cx("block touch-none", candles.length ? "cursor-crosshair" : "")}
        />
      </div>
    </div>
  );
}
