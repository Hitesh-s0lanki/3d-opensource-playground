import { ClerkProvider } from "@clerk/nextjs";
import { shadcn } from "@clerk/ui/themes";
import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter, Space_Grotesk } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

/** The display face. A grotesk with drawn-in quirks - the flat-topped `a`,
 * the squared bowls - which reads as a made thing next to Inter's neutrality,
 * which is what a page of generated meshes wants. It replaced Cormorant
 * Garamond: a high-contrast old-style serif is a beautiful face for prose and
 * the wrong voice entirely for a tool whose subject is geometry. It has no
 * italic, so the captions that used Cormorant's are upright now. */
const spaceGrotesk = Space_Grotesk({
  variable: "--font-space-grotesk",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "dioramic — photo → 3D",
  description:
    "Inspect every generated mesh next to the photo that produced it, and start new runs from the same page.",
  // Absolute base for the og:image URL. Set NEXT_PUBLIC_SITE_URL in the
  // deployed environment; locally it falls back to the dev server.
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
  openGraph: {
    title: "dioramic — photo → 3D",
    description: "Turn imagination into 3D reality.",
    images: [{ url: "/brand/og-image.png", width: 1200, height: 300, alt: "Dioramic" }],
  },
};

/** `viewportFit: cover` lets the mobile sheets run under the home indicator,
 * with `pb-safe` giving their controls the inset back. Zoom is deliberately
 * left enabled - pinching a 10px measurement is a real use of this page. */
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eef0f7" },
    { media: "(prefers-color-scheme: dark)", color: "#161a24" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${spaceGrotesk.variable} ${geistMono.variable} antialiased`}
      suppressHydrationWarning
    >
      {/* The page scrolls. It did not use to: `/` was the studio, which fills
          the viewport exactly and must never scroll, so the lock lived here on
          the body. Now `/` is a landing page and the studio is one route among
          several, so the lock belongs to the thing that needs it - ViewerApp is
          `h-dvh overflow-hidden`, which is self-contained. */}
      <body>
        <ThemeProvider>
          <ClerkProvider appearance={{ theme: shadcn }}>
            <TooltipProvider>{children}</TooltipProvider>
            <Toaster position="bottom-right" />
          </ClerkProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
