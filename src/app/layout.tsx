import type { Metadata } from "next";
import { Inter_Tight, JetBrains_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { detectLocale } from "@/lib/locale";
import { LocaleProvider } from "@/components/format/locale-context";

const interTight = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-inter-tight",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: "Metering & Billing Engine",
  description: "Microgrid metering and billing management",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const h = await headers();
  const detectedLocale = detectLocale(h.get("accept-language"));
  return (
    <html lang={detectedLocale}>
      <body className={`${interTight.variable} ${jetbrainsMono.variable} antialiased`}>
        <LocaleProvider locale={detectedLocale}>{children}</LocaleProvider>
      </body>
    </html>
  );
}
