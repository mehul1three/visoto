import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Playground — your room is the level",
  description:
    "Photograph any room and play it as a platformer. Objects are given physics based on what they actually are, and every level is proved completable before you play it.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
