import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MEXC Momentum Scanner",
  description:
    "Real-time MEXC USDT-M perpetual futures scanner: top gainers and losers with timeframe-correlated volume surges over 15M, 30M and 1H.",
  icons: {
    icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Crect width='24' height='24' rx='5' fill='%230b0e12'/%3E%3Cpath d='M4 16l4.5-4.5 3.5 3.5 7-8' fill='none' stroke='%234c8dff' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0e12" },
    { media: "(prefers-color-scheme: light)", color: "#f6f7f9" },
  ],
};

// Applies the persisted theme before first paint (default: dark) to avoid a flash.
const themeScript = `try{var t=localStorage.getItem("mx-theme");if(t==="light")document.documentElement.classList.remove("dark");else document.documentElement.classList.add("dark")}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <link rel="preconnect" href="https://contract.mexc.com" crossOrigin="anonymous" />
      </head>
      <body>{children}</body>
    </html>
  );
}
