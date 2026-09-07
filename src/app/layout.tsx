import type { Metadata, Viewport } from "next";
import { Sora } from "next/font/google";
import "./globals.css";
import { currentUser } from "@/lib/session";
import { DEFAULT_PREFS, getSettings } from "@/lib/settings";

const display = Sora({ subsets: ["latin"], weight: ["600", "700", "800"], variable: "--font-display-face", display: "swap" });

export const metadata: Metadata = {
  title: "The Daily Scroll",
  description: "One curated hour of short-form video from your connected social accounts. Then it's gone.",
  applicationName: "The Daily Scroll",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Daily Scroll" },
  icons: { apple: "/icons/icon-192.png" },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0b0b10" },
    { media: "(prefers-color-scheme: light)", color: "#fbf9f6" },
  ],
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Preferences are applied on the server so there is no flash of the wrong theme.
  const user = await currentUser();
  const prefs = user ? getSettings(user.id).prefs : DEFAULT_PREFS;
  return (
    <html
      lang="en"
      className={display.variable}
      data-theme={prefs.theme === "system" ? undefined : prefs.theme}
      data-reduce-motion={prefs.reduceMotion ? "true" : undefined}
      style={{ ["--font-display" as string]: `var(--font-display-face), ${"ui-sans-serif, system-ui, sans-serif"}` }}
    >
      <body>{children}</body>
    </html>
  );
}
