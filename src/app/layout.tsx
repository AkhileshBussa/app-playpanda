import type { Metadata, Viewport } from "next";
import "./globals.css";

// Icons and the link-preview image come from the app-dir convention files
// (favicon.ico, icon.png, apple-icon.png, opengraph-image.png) — all
// generated from the mascot's head + wordmark.
export const metadata: Metadata = {
  metadataBase: new URL("https://app.theplaypanda.com"),
  title: "Play Panda — Book & Pay",
  description: "Skip the line at Play Panda: book your play session and pay online.",
  openGraph: {
    title: "Play Panda — Book & Pay",
    description: "Skip the line: book your play session online.",
    siteName: "Play Panda",
    type: "website",
    // "./" resolves per-route against metadataBase, so each page's og:url
    // points at itself.
    url: "./",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#FFF8EC",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
