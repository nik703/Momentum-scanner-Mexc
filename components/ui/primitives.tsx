"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}
export { cx };

/* ------------------------------------------------------------------ */
/* SegmentedControl: WAI-ARIA radiogroup with roving tabindex + arrows */
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
  size = "md",
}: {
  label: string;
  value: T;
  options: readonly SegmentOption<T>[];
  onChange: (v: T) => void;
  size?: "sm" | "md";
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
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
      className="inline-flex shrink-0 items-center rounded-md border border-border bg-surface-2 p-0.5"
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
              "rounded-[5px] font-medium tabular-nums transition-colors",
              size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-xs sm:text-sm",
              active ? "bg-surface text-text shadow-sm ring-1 ring-border" : "text-muted hover:text-text",
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
/* Switch: role="switch" button                                        */
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
      className="group inline-flex items-center gap-2 rounded-md px-1.5 py-1 text-xs font-medium text-muted hover:text-text"
    >
      <span
        aria-hidden
        className={cx(
          "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full border transition-colors",
          checked ? "border-accent bg-accent" : "border-border bg-surface-2",
        )}
      >
        <span
          className={cx(
            "absolute h-3 w-3 rounded-full shadow transition-transform",
            checked ? "translate-x-3.5 bg-accent-fg" : "translate-x-0.5 bg-subtle",
          )}
        />
      </span>
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Tooltip: CSS-only, shows on hover and keyboard focus                */
/* ------------------------------------------------------------------ */

export function Tooltip({ content, children }: { content: string; children: ReactNode }) {
  const id = useId();
  return (
    <span className="group/tt relative inline-flex" aria-describedby={id}>
      {children}
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute left-1/2 top-full z-30 mt-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded border border-border bg-surface px-2 py-1 text-[11px] font-normal text-text shadow-lg group-hover/tt:block group-focus-within/tt:block"
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
  tone?: "neutral" | "up" | "down" | "accent" | "warn";
  children: ReactNode;
  className?: string;
}) {
  const tones = {
    neutral: "bg-surface-2 text-muted border-border",
    up: "bg-up-soft text-up border-transparent",
    down: "bg-down-soft text-down border-transparent",
    accent: "bg-accent/15 text-accent border-transparent",
    warn: "bg-warn/15 text-warn border-transparent",
  } as const;
  return (
    <span
      className={cx(
        "inline-flex items-center rounded border px-1.5 py-px text-[10px] font-semibold uppercase leading-4 tracking-wide",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Kbd                                                                 */
/* ------------------------------------------------------------------ */

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded border border-border bg-surface-2 px-1 font-mono text-[10px] leading-4 text-subtle">
      {children}
    </kbd>
  );
}
