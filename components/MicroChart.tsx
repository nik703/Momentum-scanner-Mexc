"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { usePersistentState } from "@/hooks/usePersistentState";
import {
  DEFAULT_BARS,
  RIGHT_MARGIN_PX,
  anchorFor,
  candleX,
  capacityFor,
  clampBars,
  computeViewport,
  fitWatermarkPx,
  indexAtX,
  resolveOffset,
  zoomBars,
} from "@/lib/chartViewport";
import { fmtPrice, fmtUsd } from "@/lib/format";
import type { Candle } from "@/lib/types";
import { cx } from "./ui/primitives";

export type ChartTimeframe = "1M" | "1S";

const AXIS_MIN_W = 48; // right price axis: sized to its widest label, within these bounds
const AXIS_MAX_W = 96;
const AXIS_PAD = 10; // 5px before + 5px after the label text
const TIME_H = 16; // bottom time axis
const VOL_SHARE = 0.22; // share of plot height used by the volume histogram
const GAP = 6; // gap between price and volume panes
const ZOOM_STEP = 1.25; // per +/- click
const DRAG_THRESHOLD_PX = 3;
const BG_PRICE_KEY = "mexc_chart_bg_price";
const BG_VALUES = ["true", "false"] as const;
/** Watermark colors calibrated per theme so candles stay fully readable on top. */
const WATERMARK = { dark: "rgba(241, 245, 249, 0.065)", light: "rgba(15, 23, 42, 0.065)" } as const;

interface Palette {
  panel: string;
  line: string;
  fg2: string;
  fg3: string;
  gain: string;
  loss: string;
  mono: string;
  watermark: string;
}

/**
 * Reads theme tokens and the real monospace family. Canvas `ctx.font` can't resolve
 * `var(--font-geist-mono)`: an invalid font string is ignored and the canvas silently falls back
 * to `10px sans-serif`. So the CSS variable is resolved here.
 */
function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el);
  const root = getComputedStyle(document.documentElement);
  const v = (name: string, fb: string) => cs.getPropertyValue(name).trim() || fb;
  const geistMono = root.getPropertyValue("--font-geist-mono").trim();
  return {
    panel: v("--panel", "#0f1217"),
    line: v("--line", "#1e242d"),
    fg2: v("--fg-2", "#8b949e"),
    fg3: v("--fg-3", "#484f58"),
    gain: v("--gain", "#10b981"),
    loss: v("--loss", "#ef4444"),
    mono: `${geistMono ? `${geistMono}, ` : ""}ui-monospace, SFMono-Regular, Menlo, monospace`,
    watermark: document.documentElement.dataset.theme === "light" ? WATERMARK.light : WATERMARK.dark,
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

/** Snaps a coordinate to the device pixel grid so 1px lines stay crisp. */
const crisp = (x: number, dpr: number) => (Math.round(x * dpr) + 0.5) / dpr;
const snap = (x: number, dpr: number) => Math.round(x * dpr) / dpr;

interface ViewState {
  bars: number;
  /** null = follow the newest bar; otherwise the open time pinned at the right edge. */
  anchorT: number | null;
}

type Gesture =
  | { kind: "none" }
  | { kind: "pending" | "pan"; pointerId: number; startX: number; startOffset: number; slotW: number }
  | { kind: "pinch"; startDist: number; startBars: number };

function ToolButton({
  children,
  onClick,
  label,
  disabled,
  active,
  testId,
}: {
  children: ReactNode;
  onClick: () => void;
  label: string;
  disabled?: boolean;
  active?: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-pressed={active}
      data-testid={testId}
      className={cx(
        "num inline-flex h-6 min-w-6 items-center justify-center px-1.5 text-[11px] tabular-nums transition-colors",
        "[&+&]:border-l [&+&]:border-line disabled:cursor-not-allowed disabled:text-fg-3 disabled:opacity-60",
        active ? "bg-row-hover text-fg" : "text-fg-2 hover:bg-row-hover hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

export function MicroChart({
  candles,
  timeframe,
  height = 240,
  emptyLabel,
  title,
  timeframeControl,
  livePrice,
  formatPrice = fmtPrice,
}: {
  candles: readonly Candle[];
  timeframe: ChartTimeframe;
  height?: number;
  emptyLabel: string;
  /** Left side of the toolbar strip, e.g. "1-minute · last 60m". */
  title?: ReactNode;
  /** The 1M / 1S selector, rendered in the toolbar alongside the zoom controls. */
  timeframeControl?: ReactNode;
  /** Live last price for the background watermark (falls back to the newest close). */
  livePrice?: number | null;
  /** Shared price formatter (same decimals as the drawer's price strip). */
  formatPrice?: (p: number) => string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hoverRef = useRef<{ x: number; y: number } | null>(null);
  const sizeRef = useRef({ w: 0, h: height, dpr: 1 });
  const frame = useRef<number | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture>({ kind: "none" });
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  // Axis width measured during draw (canvas text metrics). Kept in state so the Live pill and
  // the pointer math line up with the drawn plot. Only updated when it actually changes.
  const [axisW, setAxisW] = useState(58);
  const [views, setViews] = useState<Record<ChartTimeframe, ViewState>>({
    "1M": { bars: DEFAULT_BARS, anchorT: null },
    "1S": { bars: DEFAULT_BARS, anchorT: null },
  });
  const [bgPref, setBgPref] = usePersistentState(BG_PRICE_KEY, "true", BG_VALUES);
  const bgPrice = bgPref === "true";

  // ---- derived viewport (render scope: plain values, no refs) ----
  const capacity = capacityFor(timeframe);
  const view = views[timeframe];
  const visibleBars = clampBars(view.bars, capacity);
  const times = candles.map((c) => c.t);
  const rightOffset = resolveOffset(times, view.anchorT, visibleBars);
  const n = candles.length;
  const zoomPct = Math.round((DEFAULT_BARS / visibleBars) * 100);
  const watermarkPrice = livePrice ?? candles[n - 1]?.c ?? null;
  const watermarkText = bgPrice && watermarkPrice !== null && watermarkPrice > 0 ? formatPrice(watermarkPrice) : "";

  const setView = useCallback(
    (fn: (v: ViewState) => ViewState) => setViews((all) => ({ ...all, [timeframe]: fn(all[timeframe]) })),
    [timeframe],
  );

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const { w, h, dpr } = sizeRef.current;
    if (w <= 0 || h <= 0) return;

    const pal = readPalette(canvas);
    const font = (px: number, weight = 400) => `${weight} ${px}px ${pal.mono}`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 0) Opaque panel background: the canvas is self-contained, so the 6.5% watermark blends
    //    against the theme panel color itself rather than relying on CSS behind a transparent canvas.
    ctx.fillStyle = pal.panel;
    ctx.fillRect(0, 0, w, h);
    ctx.font = font(10);
    ctx.textBaseline = "middle";

    // Size the price scale to the widest label we'll draw (ticks + live price + VOL), so 6-digit
    // and long sub-cent prices never clip against the canvas edge.
    const n0 = candles.length;
    let measuredAxis = AXIS_MIN_W;
    if (n0 > 0) {
      const vp0 = computeViewport(n0, visibleBars, rightOffset, Math.max(10, w - axisW - RIGHT_MARGIN_PX));
      let lo0 = Infinity;
      let hi0 = -Infinity;
      for (let i = vp0.start; i < vp0.end; i++) {
        lo0 = Math.min(lo0, candles[i].l);
        hi0 = Math.max(hi0, candles[i].h);
      }
      const labels = [...niceTicks(lo0, hi0).map(formatPrice), formatPrice(candles[n0 - 1].c), "VOL", "$999.9M"];
      for (const l of labels) measuredAxis = Math.max(measuredAxis, ctx.measureText(l).width + AXIS_PAD);
    }
    const AXIS_W = Math.min(AXIS_MAX_W, Math.ceil(measuredAxis));
    if (AXIS_W !== axisW) setAxisW(AXIS_W);
    const axisX = Math.max(10, w - AXIS_W); // left edge of the price scale
    const plotW = Math.max(10, axisX - RIGHT_MARGIN_PX); // candle slots end 8px before the axis
    const plotH = h - TIME_H;
    const volH = Math.round(plotH * VOL_SHARE);
    const priceH = plotH - volH - GAP;

    // 1) Frame / pane separators
    ctx.strokeStyle = pal.line;
    ctx.lineWidth = 1 / dpr;
    ctx.beginPath();
    ctx.moveTo(crisp(axisX, dpr), 0);
    ctx.lineTo(crisp(axisX, dpr), plotH);
    ctx.moveTo(0, crisp(plotH, dpr));
    ctx.lineTo(w, crisp(plotH, dpr));
    ctx.moveTo(0, crisp(priceH + GAP / 2, dpr));
    ctx.lineTo(axisX, crisp(priceH + GAP / 2, dpr));
    ctx.stroke();

    const vp = computeViewport(n, visibleBars, rightOffset, plotW);
    canvas.dataset.plotRight = String(plotW);
    canvas.dataset.slotWidth = vp.slotW.toFixed(3);
    canvas.dataset.bodyWidth = String(vp.bodyW);

    if (n === 0) {
      canvas.dataset.lastBarX = "-1";
      canvas.dataset.bgFontPx = "0";
      ctx.fillStyle = pal.fg3;
      ctx.textAlign = "center";
      ctx.fillText(emptyLabel, plotW / 2, priceH / 2);
      return;
    }

    // Y range and max volume come strictly from the visible slice.
    let lo = Infinity;
    let hi = -Infinity;
    let vmax = 0;
    let useTurnover = false;
    for (let i = vp.start; i < vp.end; i++) if (candles[i].a > 0) useTurnover = true;
    for (let i = vp.start; i < vp.end; i++) {
      const c = candles[i];
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

    // 2) Price gridlines + axis labels (labels that would collide with the live price tag are skipped)
    ctx.textAlign = "left";
    const tagY = y(candles[n - 1].c);
    for (const t of niceTicks(lo, hi)) {
      const yy = crisp(y(t), dpr);
      if (yy < 6 || yy > priceH - 4) continue;
      const collides = Math.abs(yy - tagY) < 14;
      ctx.strokeStyle = pal.line;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(axisX, yy);
      ctx.stroke();
      ctx.setLineDash([]);
      if (collides) continue;
      ctx.fillStyle = pal.fg3;
      ctx.fillText(formatPrice(t), axisX + 5, yy);
    }

    // 3) Background price watermark: after the grid, BEFORE volume, wicks, bodies, price line
    //    and crosshair, so candles always render in front of it. Drawn on the canvas, so live
    //    ticks cause no DOM reflow.
    if (watermarkText) {
      ctx.font = font(100, 700);
      const px = fitWatermarkPx(ctx.measureText(watermarkText).width, plotW, priceH);
      ctx.font = font(px, 700);
      ctx.fillStyle = pal.watermark;
      ctx.textAlign = "center";
      ctx.fillText(watermarkText, plotW / 2, priceH / 2);
      canvas.dataset.bgFontPx = px.toFixed(1);
      canvas.dataset.bgTextWidth = ctx.measureText(watermarkText).width.toFixed(1);
      ctx.font = font(10);
    } else {
      canvas.dataset.bgFontPx = "0";
      canvas.dataset.bgTextWidth = "0";
    }

    // 4) Volume histogram, then 5) wicks and bodies
    const bodyW = vp.bodyW;
    for (let i = vp.start; i < vp.end; i++) {
      const c = candles[i];
      const vv = useTurnover ? c.a : c.v;
      if (vmax > 0 && vv > 0) {
        const vh = Math.max(1 / dpr, (vv / vmax) * (volH - 2));
        ctx.fillStyle = c.c >= c.o ? pal.gain : pal.loss;
        ctx.globalAlpha = 0.45;
        ctx.fillRect(snap(candleX(vp, i) - bodyW / 2, dpr), plotH - vh, bodyW, vh);
      }
    }
    ctx.globalAlpha = 1;
    for (let i = vp.start; i < vp.end; i++) {
      const c = candles[i];
      const cx0 = candleX(vp, i);
      const col = c.c >= c.o ? pal.gain : pal.loss;
      if (c.v > 0 || c.h !== c.l) {
        const xs = crisp(cx0, dpr);
        ctx.strokeStyle = col;
        ctx.lineWidth = 1 / dpr;
        ctx.beginPath();
        ctx.moveTo(xs, snap(y(c.h), dpr));
        ctx.lineTo(xs, snap(y(c.l), dpr));
        ctx.stroke();
      }
      const top = snap(y(Math.max(c.o, c.c)), dpr);
      const bot = snap(y(Math.min(c.o, c.c)), dpr);
      ctx.fillStyle = col;
      ctx.globalAlpha = c.v > 0 ? 1 : 0.35; // padded seconds with no trades are dimmed
      ctx.fillRect(snap(cx0 - bodyW / 2, dpr), top, bodyW, Math.max(1 / dpr, bot - top));
      ctx.globalAlpha = 1;
    }
    canvas.dataset.lastBarX = rightOffset === 0 ? candleX(vp, n - 1).toFixed(2) : "-1";

    // 6) Last price line + tag (always the live price, even when panned)
    const last = candles[n - 1];
    const lastCol = last.c >= last.o ? pal.gain : pal.loss;
    const lyRaw = y(last.c);
    if (lyRaw >= 0 && lyRaw <= priceH) {
      const ly = crisp(lyRaw, dpr);
      ctx.strokeStyle = lastCol;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(0, ly);
      ctx.lineTo(axisX, ly);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = lastCol;
      ctx.fillRect(axisX + 1, ly - 7, AXIS_W - 1, 14);
      ctx.fillStyle = pal.panel;
      ctx.textAlign = "left";
      ctx.fillText(formatPrice(last.c), axisX + 5, ly);
    }

    // Time labels, spaced by pixels
    ctx.fillStyle = pal.fg3;
    ctx.textAlign = "center";
    const labelPx = timeframe === "1S" ? 74 : 56;
    const every = Math.max(1, Math.ceil(labelPx / vp.slotW));
    for (let i = vp.end - 1; i >= vp.start; i -= every) {
      const xx = candleX(vp, i);
      if (xx < 22 || xx > plotW - 22) continue;
      ctx.fillText(fmtTime(candles[i].t, timeframe), xx, plotH + TIME_H / 2 + 1);
    }

    // Volume label: two short lines so it always fits inside the 58px axis
    ctx.textAlign = "left";
    ctx.fillText("VOL", axisX + 5, priceH + GAP + 8);
    ctx.fillText(vmax > 0 ? (useTurnover ? fmtUsd(vmax) : `${compactNum(vmax)} ct`) : "—", axisX + 5, priceH + GAP + 20);

    // 7) Crosshair (topmost)
    const hv = hoverRef.current;
    if (hv && hv.y >= 0 && hv.y <= plotH) {
      const idx = indexAtX(vp, hv.x);
      if (idx >= 0) {
        const hx = crisp(candleX(vp, idx), dpr);
        const hy = crisp(hv.y, dpr);
        ctx.strokeStyle = pal.fg3;
        ctx.lineWidth = 1 / dpr;
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(hx, 0);
        ctx.lineTo(hx, plotH);
        if (hv.y <= priceH) {
          ctx.moveTo(0, hy);
          ctx.lineTo(axisX, hy);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        if (hv.y <= priceH) {
          ctx.fillStyle = pal.fg2;
          ctx.fillRect(axisX + 1, hy - 7, AXIS_W - 1, 14);
          ctx.fillStyle = pal.panel;
          ctx.fillText(formatPrice(hi - (hv.y / priceH) * (hi - lo)), axisX + 5, hy);
        }
      }
    }
  }, [candles, n, timeframe, emptyLabel, visibleBars, rightOffset, watermarkText, formatPrice, axisW]);

  // The latest draw lives in a ref so `schedule` stays stable; resize/observer effects don't re-run on ticks.
  const drawRef = useRef(draw);
  const schedule = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      drawRef.current();
    });
  }, []);

  // Backing store = CSS size × devicePixelRatio, so text and lines stay sharp on HiDPI screens.
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
    // Redraw on theme change (colors and watermark come from the theme) and once web fonts load.
    const mo = new MutationObserver(schedule);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    void document.fonts?.ready.then(schedule);
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

  // ---- interactions ----
  const plotWidth = () => Math.max(10, Math.max(10, sizeRef.current.w - axisW) - RIGHT_MARGIN_PX);

  const zoomBy = useCallback(
    (factor: number) => setView((v) => ({ ...v, bars: zoomBars(clampBars(v.bars, capacity), factor, capacity) })),
    [setView, capacity],
  );
  const zoomTo = useCallback(
    (bars: number) => setView((v) => ({ ...v, bars: clampBars(bars, capacity) })),
    [setView, capacity],
  );
  const panToOffset = (offset: number) => setView((v) => ({ ...v, anchorT: anchorFor(times, offset, visibleBars) }));
  const goLive = () => setView((v) => ({ ...v, anchorT: null }));
  const resetZoom = () => setView(() => ({ bars: DEFAULT_BARS, anchorT: null }));

  // Wheel / trackpad: vertical = zoom (follow mode keeps the newest bar anchored right),
  // horizontal = pan. A native non-passive listener, so the page doesn't scroll.
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  useEffect(() => {
    wheelRef.current = (e: WheelEvent) => {
      if (n === 0) return;
      e.preventDefault();
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const slotW = plotWidth() / visibleBars;
        panToOffset(rightOffset - e.deltaX / slotW);
        return;
      }
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1; // lines / pages -> px
      const factor = Math.exp((e.deltaY * unit) / 300);
      if (factor !== 1) zoomBy(factor);
    };
  });
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => wheelRef.current(e);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  const localPoint = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const updateHover = (pt: { x: number; y: number } | null) => {
    hoverRef.current = pt;
    if (!pt) {
      setHoverIdx(null);
    } else {
      const vp = computeViewport(n, visibleBars, rightOffset, plotWidth());
      const idx = indexAtX(vp, pt.x);
      setHoverIdx(idx >= 0 ? idx : null);
    }
    schedule();
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const pt = localPoint(e);
    pointers.current.set(e.pointerId, pt);
    try {
      e.currentTarget.setPointerCapture(e.pointerId); // keep the drag even if the pointer leaves the canvas
    } catch {
      /* NotFoundError for pointers that are no longer active (e.g. synthetic or interrupted touches) */
    }
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      gesture.current = { kind: "pinch", startDist: Math.hypot(a.x - b.x, a.y - b.y) || 1, startBars: visibleBars };
      updateHover(null);
    } else if (pointers.current.size === 1) {
      gesture.current = {
        kind: "pending",
        pointerId: e.pointerId,
        startX: pt.x,
        startOffset: rightOffset,
        slotW: plotWidth() / visibleBars,
      };
    }
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const pt = localPoint(e);
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, pt);
    const g = gesture.current;
    if (g.kind === "pinch" && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      zoomTo(g.startBars * (g.startDist / dist)); // fingers apart -> fewer bars (zoom in)
      return;
    }
    if ((g.kind === "pending" || g.kind === "pan") && g.pointerId === e.pointerId) {
      const dx = pt.x - g.startX;
      if (g.kind === "pending" && Math.abs(dx) < DRAG_THRESHOLD_PX) return;
      if (g.kind === "pending") {
        gesture.current = { ...g, kind: "pan" };
        updateHover(null);
      }
      // Drag right = pull older bars into view (offset grows). Drag left = toward live.
      panToOffset(g.startOffset + dx / g.slotW);
      return;
    }
    if (e.pointerType === "mouse") updateHover(pt);
  };

  const endPointer = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    pointers.current.delete(e.pointerId);
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    if (pointers.current.size === 0) gesture.current = { kind: "none" };
    else if (gesture.current.kind === "pinch") gesture.current = { kind: "none" }; // lifting one finger ends the pinch
  };

  const onPointerLeave = () => {
    if (gesture.current.kind === "none") updateHover(null);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLCanvasElement>) => {
    if (e.key === "+" || e.key === "=") zoomBy(1 / ZOOM_STEP);
    else if (e.key === "-" || e.key === "_") zoomBy(ZOOM_STEP);
    else if (e.key === "ArrowLeft") panToOffset(rightOffset + Math.max(1, Math.round(visibleBars / 6)));
    else if (e.key === "ArrowRight") panToOffset(rightOffset - Math.max(1, Math.round(visibleBars / 6)));
    else if (e.key === "End") goLive();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const shown = (hoverIdx !== null ? candles[hoverIdx] : undefined) ?? candles[n - 1] ?? null;
  const up = shown ? shown.c >= shown.o : true;

  return (
    <div className="min-w-0">
      {/* Toolbar: title on the left; zoom, BG price and 1M/1S on the right. Wraps on narrow phones. */}
      <div className="mb-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1.5" data-testid="chart-toolbar">
        <span className="whitespace-nowrap text-[10px] font-medium uppercase tracking-wider text-fg-3">{title}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <div className="inline-flex items-stretch overflow-hidden rounded-[3px] border border-line" role="group" aria-label="Chart zoom">
            <ToolButton label="Zoom out" testId="zoom-out" onClick={() => zoomBy(ZOOM_STEP)} disabled={visibleBars >= capacity}>
              −
            </ToolButton>
            <ToolButton label="Zoom in" testId="zoom-in" onClick={() => zoomBy(1 / ZOOM_STEP)} disabled={visibleBars <= 10}>
              +
            </ToolButton>
            <ToolButton label="Reset zoom to 100% and follow live" testId="zoom-reset" onClick={resetZoom} active={zoomPct !== 100}>
              <span className="w-[4ch] text-center">{zoomPct}%</span>
            </ToolButton>
          </div>
          <div className="inline-flex items-stretch overflow-hidden rounded-[3px] border border-line">
            <ToolButton
              label={`Background price ${bgPrice ? "on" : "off"}`}
              testId="bg-price-toggle"
              onClick={() => setBgPref(bgPrice ? "false" : "true")}
              active={bgPrice}
            >
              <span className="text-[10px] uppercase tracking-wider">
                BG <span className={bgPrice ? "text-fg" : "text-fg-3"}>{bgPrice ? "ON" : "OFF"}</span>
              </span>
            </ToolButton>
          </div>
          {timeframeControl}
        </div>
      </div>

      <div className="num flex h-8 flex-wrap content-center items-center gap-x-2.5 overflow-hidden whitespace-nowrap text-[10.5px] leading-[14px] text-fg-3 sm:h-5 sm:flex-nowrap">
        {shown ? (
          <>
            <span className="text-fg-2">{fmtTime(shown.t, timeframe)}</span>
            <span>
              O <span className="text-fg">{formatPrice(shown.o)}</span>
            </span>
            <span>
              H <span className="text-fg">{formatPrice(shown.h)}</span>
            </span>
            <span>
              L <span className="text-fg">{formatPrice(shown.l)}</span>
            </span>
            <span>
              C <span className={up ? "text-gain" : "text-loss"}>{formatPrice(shown.c)}</span>
            </span>
            <span>
              V <span className="text-fg">{shown.a > 0 ? fmtUsd(shown.a) : shown.v.toLocaleString("en-US")}</span>
            </span>
            {hoverIdx === null && <span className="hidden text-fg-3 sm:inline">{rightOffset === 0 ? "live" : "history"}</span>}
          </>
        ) : (
          <span>—</span>
        )}
      </div>
      <div ref={wrapRef} className="relative w-full" style={{ height }}>
        <canvas
          ref={canvasRef}
          tabIndex={0}
          data-chart-timeframe={timeframe}
          data-visible-bars={visibleBars}
          data-right-offset={rightOffset}
          data-bg-price={bgPrice ? "on" : "off"}
          role="img"
          aria-label={`${timeframe} candlestick chart, ${n} candles, ${visibleBars} visible${rightOffset ? `, ${rightOffset} bars back` : ", following live"}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endPointer}
          onPointerCancel={endPointer}
          onPointerLeave={onPointerLeave}
          onKeyDown={onKeyDown}
          className={cx(
            "block touch-none select-none focus-visible:outline-1 focus-visible:outline-offset-[-1px]",
            n ? "cursor-crosshair active:cursor-grabbing" : "",
          )}
        />
        {rightOffset > 0 && (
          <button
            type="button"
            onClick={goLive}
            data-testid="chart-live"
            title="Jump back to the live bar (End)"
            className="num absolute z-10 inline-flex h-5 items-center gap-1 rounded-[2px] border border-line-strong bg-panel px-1.5 text-[10px] font-medium uppercase tracking-wider text-fg hover:bg-row-hover"
            style={{ right: axisW + RIGHT_MARGIN_PX + 4, bottom: TIME_H + 4 }}
          >
            Live <span aria-hidden>⇥</span>
          </button>
        )}
      </div>
    </div>
  );
}
