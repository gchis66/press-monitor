import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Press Release Monitor — live demo",
  description:
    "Enter a company newsroom URL and see the email alert an AI agent would send for its latest press release.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-slate-100 text-ink antialiased">{children}</body>
    </html>
  );
}
