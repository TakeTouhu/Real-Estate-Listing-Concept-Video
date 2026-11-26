import type { ReactNode } from "react";
import "./globals.css";

// Every page renders per request, the 404 included, so each script carries the request's nonce (ADR-0188).
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Real Estate Virtual Tour AI — Operations",
  description: "Phase 0 authenticated health-check console.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
