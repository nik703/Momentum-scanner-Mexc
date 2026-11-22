"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/* ------------------------------------------------------------------ */
/* SegmentedControl: WAI-ARIA radiogroup, roving tabindex, arrow keys   */
/* ------------------------------------------------------------------ */

export interface SegmentOption<T extends string> {
  value: T;
  label: ReactNode;
  hint?: string;
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
  mono = false,
  compact = false,
}: {
  label: string;
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (v: T) => void;
  mono?: boolean;
  /** 24px tall (chart toolbars) instead of 28px. */
  compact?: boolean;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const idx = Math.max(0, options.findIndex((o) => o.value === value));

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const dir =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!dir) return;
    e.preventDefault();
    const next = (idx + dir + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cx(
        "inline-flex shrink-0 items-stretch overflow-hidden rounded-[3px] border border-line",
        compact ? "h-6" : "h-7",
      )}
    >
      {options.map((o, i) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            title={o.hint}
            onClick={() => onChange(o.value)}
            className={cx(
              "px-2 font-medium transition-colors [&+&]:border-l [&+&]:border-line",
              compact ? "text-[11px]" : "text-[11.5px]",
              mono && "num",
              active ? "bg-row-hover text-fg" : "text-fg-2 hover:text-fg",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Switch: role="switch"                                               */
/* ------------------------------------------------------------------ */

export function Switch({
  checked,
  onChange,
  label,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="inline-flex h-7 items-center gap-1.5 px-2 text-[11.5px] font-medium text-fg-2 hover:text-fg"
    >
      <span
        aria-hidden
        className={cx(
          "relative inline-flex h-3.5 w-6 shrink-0 items-center rounded-full border transition-colors",
          checked ? "border-gain bg-gain-tint" : "border-line-strong bg-canvas",
        )}
      >
        <span
          className={cx(
            "absolute h-2 w-2 rounded-full transition-transform",
            checked ? "translate-x-3 bg-gain" : "translate-x-0.5 bg-fg-3",
          )}
        />
      </span>
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Tooltip: CSS only; shows on hover and on keyboard focus             */
/* ------------------------------------------------------------------ */

export function Tooltip({ content, children }: { content: string; children: ReactNode }) {
  const id = useId();
  return (
    <span className="group/tt relative inline-flex" aria-describedby={id}>
      {children}
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute right-0 top-full z-50 mt-1 hidden whitespace-nowrap rounded-[3px] border border-line bg-panel px-1.5 py-0.5 text-[11px] text-fg group-hover/tt:block group-focus-within/tt:block"
      >
        {content}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Badge                                                               */
/* ------------------------------------------------------------------ */

export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: "neutral" | "gain" | "loss" | "alert";
  children: ReactNode;
  className?: string;
}) {
  const tones = {
    neutral: "border-line text-fg-2",
    gain: "border-transparent bg-gain-tint text-gain",
    loss: "border-transparent bg-loss-tint text-loss",
    alert: "border-transparent bg-alert-tint text-alert",
  } as const;
  return (
    <span
      className={cx(
        "num inline-flex items-center rounded-[2px] border px-1 text-[9.5px] font-semibold uppercase leading-[14px] tracking-wider",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="num rounded-[2px] border border-line px-1 text-[10px] leading-[14px] text-fg-3">{children}</kbd>
  );
}
