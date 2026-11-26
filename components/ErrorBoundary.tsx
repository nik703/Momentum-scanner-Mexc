"use client";

import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Rendered instead of the crashed subtree; gets a reset callback. */
  fallback: (reset: () => void) => ReactNode;
  /** Changing this remounts the subtree (e.g. the inspected symbol). */
  resetKey?: string;
}

/**
 * Contains a render-time crash (e.g. a value no guard anticipated) to one panel, so a bad frame in
 * the drawer can never blank the leaderboards behind it.
 */
export class ErrorBoundary extends Component<Props, { failed: boolean; key?: string }> {
  state = { failed: false, key: this.props.resetKey };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: { failed: boolean; key?: string }) {
    return props.resetKey !== state.key ? { failed: false, key: props.resetKey } : null;
  }

  componentDidCatch(error: unknown) {
    console.warn("[ErrorBoundary] panel crashed and was contained:", error instanceof Error ? error.message : error);
  }

  render() {
    return this.state.failed ? this.props.fallback(() => this.setState({ failed: false })) : this.props.children;
  }
}
