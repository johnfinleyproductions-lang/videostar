import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "FrameForge — Local AI Video Studio",
  description:
    "Generate videos locally with LTX-Video 2.3 on your RTX PRO 4500",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark h-full">
      <body className="font-sans antialiased bg-black text-white min-h-full">
        {children}
      </body>
    </html>
  );
}
