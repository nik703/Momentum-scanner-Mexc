import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "MEXC Momentum Scanner",
  description:
    "Real-time MEXC USDT-M perpetual futures scanner: top gainers and losers with timeframe-correlated volume surges over 15M, 30M and 1H.",
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' fill='%23090B0E'/%3E%3Cpath d='M3 11l3-3 2 2 5-5' fill='none' stroke='%2310B981' stroke-width='1.6'/%3E%3C/svg%3E",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#090B0E" },
    { media: "(prefers-color-scheme: light)", color: "#F4F6F8" },
  ],
};

// Applies the saved theme before first paint, so the page doesn't flash the wrong theme. Default is dark.
const themeScript = `try{var t=localStorage.getItem("mx-theme");document.documentElement.setAttribute("data-theme",t==="light"?"light":"dark")}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <link rel="preconnect" href="https://contract.mexc.com" crossOrigin="anonymous" />
      </head>
      <body>{children}</body>
    </html>
  );
}
