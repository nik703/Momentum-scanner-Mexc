"use client";

/** Route-level boundary: an uncaught render error shows a recoverable message instead of a blank page. */
export default function GlobalError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-canvas p-6 text-center text-fg">
      <p className="text-[13px]">The scanner hit unexpected data and stopped rendering.</p>
      <button
        type="button"
        onClick={reset}
        className="rounded-[3px] border border-line px-3 py-1.5 text-[12px] text-fg-2 hover:text-fg"
      >
        Reload scanner
      </button>
    </main>
  );
}
