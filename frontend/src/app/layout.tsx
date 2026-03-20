import type { Metadata } from "next";
import React, { type ReactNode } from "react";
import { Geist_Mono, Manrope, Space_Grotesk } from "next/font/google";
import "./globals.css";
import "./landing.css";
import "./auth.css";

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
});

const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Signal | High-Performance Product Frontend",
  description:
    "Signal builds fast, reliable, high-conversion frontend experiences for modern product teams.",
  icons: {
    icon: "/signal_transparent.png",
    apple: "/signal_transparent.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${manrope.variable} ${spaceGrotesk.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}