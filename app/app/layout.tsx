import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "OBS — Obscura Mineable Token",
  description:
    "Browser-mined ERC-20. Inspired by hash256.org. Educational replica.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="crt">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
