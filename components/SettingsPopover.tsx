"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useAudioVolume } from "@/hooks/useAppSettings";
import { unlockAudio } from "@/lib/audio";
import { cx } from "./ui/primitives";

function CogIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.15 1.15M11.45 11.45l1.15 1.15M3.4 12.6l1.15-1.15M11.45 4.55l1.15-1.15" />
      <circle cx="8" cy="8" r="4.6" />
    </svg>
  );
}

/**
 * Top-right settings cog: a 28×28 trigger with a 240px panel anchored to its right edge.
 *
 * Dismissal is layered. Click outside closes it. Escape closes the popover FIRST: a
 * capture-phase window listener runs before the app's bubble-phase Escape handler (which closes
 * the Contract Inspection Drawer) and stops the event there, so the drawer stays open. A second
 * Escape then reaches the drawer.
 */
export function SettingsPopover({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation(); // keep the drawer open; this Escape belongs to the popover
      setOpen(false);
      triggerRef.current?.focus({ preventScroll: true });
    };
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && e.target instanceof Node && !rootRef.current.contains(e.target)) setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointer, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointer, true);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0" data-testid={testId}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        data-testid={`${testId}-trigger`}
        onClick={() => setOpen((v) => !v)}
        className={cx(
          "inline-flex h-7 w-7 items-center justify-center rounded-[3px] border border-line transition-colors",
          open ? "bg-row-hover text-fg" : "text-fg-2 hover:text-fg",
        )}
      >
        <CogIcon />
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          aria-label={label}
          data-testid={`${testId}-panel`}
          className="num absolute right-0 top-full z-[60] mt-1 w-[240px] rounded-[3px] border border-line bg-panel py-1 text-[11.5px] tabular-nums"
        >
          {children}
        </div>
      )}
    </div>
  );
}

/** One 32px settings row: a label on the left, a control on the right. */
export function SettingsRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex h-8 items-center justify-between gap-2 px-2.5" title={hint}>
      <span className="truncate text-fg-2">{label}</span>
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </div>
  );
}

export function SettingsDivider() {
  return <div aria-hidden className="my-1 h-px bg-line" />;
}

/** ON/OFF switch used inside the settings panel. */
export function SettingsSwitch({
  checked,
  onChange,
  label,
  testId,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      className="inline-flex h-6 items-center gap-1.5 rounded-[3px] border border-line px-1.5 text-[10.5px] font-medium uppercase hover:bg-row-hover"
    >
      <span
        aria-hidden
        className={cx(
          "relative inline-flex h-3 w-5 shrink-0 items-center rounded-full border",
          checked ? "border-gain bg-gain-tint" : "border-line-strong bg-canvas",
        )}
      >
        <span
          className={cx(
            "absolute h-1.5 w-1.5 rounded-full transition-transform",
            checked ? "translate-x-2.5 bg-gain" : "translate-x-0.5 bg-fg-3",
          )}
        />
      </span>
      <span className={cx("w-[3ch] text-left", checked ? "text-fg" : "text-fg-3")}>{checked ? "ON" : "OFF"}</span>
    </button>
  );
}

/** Small inline action button (Test / Long / Short). */
export function SettingsAction({
  children,
  onClick,
  label,
  testId,
  tone,
}: {
  children: ReactNode;
  onClick: () => void;
  label: string;
  testId: string;
  tone?: "liq-long" | "liq-short";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid={testId}
      className={cx(
        "inline-flex h-6 items-center rounded-[3px] border border-line px-1.5 text-[10.5px] font-medium uppercase hover:bg-row-hover",
        tone === "liq-long" ? "text-liq-long" : tone === "liq-short" ? "text-liq-short" : "text-fg-2 hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round">
      <path d="M2.5 6v4h2.6L8.5 13V3L5.1 6z" fill="currentColor" stroke="none" />
      {muted ? (
        <path d="M10.5 6l3.5 4M14 6l-3.5 4" strokeLinecap="round" />
      ) : (
        <>
          <path d="M10.6 5.8a3 3 0 0 1 0 4.4" strokeLinecap="round" />
          <path d="M12.3 4.2a5.3 5.3 0 0 1 0 7.6" strokeLinecap="round" />
        </>
      )}
    </svg>
  );
}

/**
 * Shared 0–100 alert volume: mute/unmute button (remembers the previous level), range slider,
 * and live numeric readout. Both cogs render this same control against the same persisted
 * state, so they always agree.
 */
export function VolumeControl({ testIdPrefix = "volume" }: { testIdPrefix?: string }) {
  const { volume, setVolume, toggleMute } = useAudioVolume();
  const muted = volume === 0;
  return (
    <div className="flex h-8 items-center gap-2 px-2.5" data-testid={`${testIdPrefix}-control`}>
      <button
        type="button"
        onClick={() => {
          toggleMute();
          if (muted) void unlockAudio(); // unmuting is a user gesture: unlock audio too
        }}
        aria-label={muted ? "Unmute alerts" : "Mute alerts"}
        aria-pressed={muted}
        title={muted ? "Unmute (restore previous volume)" : "Mute"}
        data-testid={`${testIdPrefix}-mute`}
        className={cx(
          "inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[3px] border border-line hover:bg-row-hover",
          muted ? "text-fg-3" : "text-fg",
        )}
      >
        <SpeakerIcon muted={muted} />
      </button>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={volume}
        onChange={(e) => {
          const v = Number(e.target.value);
          setVolume(v);
          if (v > 0) void unlockAudio(); // a drag is a user gesture
        }}
        aria-label="Alert volume"
        aria-valuetext={muted ? "Muted" : `${volume} percent`}
        data-testid={`${testIdPrefix}-slider`}
        className="h-1 min-w-0 flex-1 cursor-pointer accent-gain"
      />
      <span className="w-7 text-right font-mono text-[11px] tabular-nums text-fg" data-testid={`${testIdPrefix}-readout`} aria-hidden>
        {volume}
      </span>
    </div>
  );
}
