import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

/**
 * Every origin the BROWSER talks to. REST calls to MEXC go through our own /api routes ('self');
 * the browser only opens WebSockets to the exchanges, plus OKX's public instruments REST endpoint
 * (contract values for USD conversion). OKX is listed with and without :8443 because the client
 * tries :443 first and falls back to the documented :8443 endpoint.
 */
const CONNECT_SRC = [
  "'self'",
  "wss://contract.mexc.com",
  "wss://fstream.binance.com",
  "wss://stream.bybit.com",
  "https://www.okx.com",
  "wss://ws.okx.com",
  "wss://ws.okx.com:8443",
  // next dev's hot-reload socket.
  ...(isDev ? ["ws://localhost:*", "ws://127.0.0.1:*"] : []),
];

const CSP = [
  "default-src 'self'",
  // 'unsafe-inline': Next's App Router streams inline bootstrap scripts, and the pre-paint theme
  // script lives inline in app/layout.tsx. 'unsafe-eval' is only for next dev (React Refresh).
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  `connect-src ${CONNECT_SRC.join(" ")}`,
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,
  // No browser source maps in production: the client bundle doesn't ship original source paths.
  productionBrowserSourceMaps: false,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
