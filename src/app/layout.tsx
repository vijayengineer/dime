import type { Metadata, Viewport } from "next";
import { Cabin_Sketch, JetBrains_Mono, Space_Grotesk } from "next/font/google";
import { brand } from "@/config/brand";
import { Shell } from "@/components/Shell";
import "./globals.css";

const sketch = Cabin_Sketch({ subsets: ["latin"], weight: ["400", "700"], variable: "--font-sketch" });
const grotesk = Space_Grotesk({ subsets: ["latin"], variable: "--font-grotesk" });
const jet = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jet" });

export const metadata: Metadata = {
  title: `${brand.name} — BTC on Monad`,
  description: brand.tagline,
};

export const viewport: Viewport = { themeColor: "#171615", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sketch.variable} ${grotesk.variable} ${jet.variable}`}>
      <body>
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
