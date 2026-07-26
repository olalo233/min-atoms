import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "min-atoms",
  description: "A private workspace for building small interactive applications.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html data-scroll-behavior="smooth" lang="en">
      <body>
        <a className="skip-link" href="#main-content">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
