import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "フロータスク",
  description: "YAML ベースでフローを可視化する個人向けタスク管理ツール。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
