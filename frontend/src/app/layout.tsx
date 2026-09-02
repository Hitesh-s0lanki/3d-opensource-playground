import { ClerkProvider } from "@clerk/nextjs";
import { shadcn } from "@clerk/ui/themes";
import type { Metadata } from "next";
import { Cormorant_Garamond, Geist_Mono, Inter } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const cormorant = Cormorant_Garamond({
  variable: "--font-cormorant",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  style: ["normal", "italic"],
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

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${cormorant.variable} ${geistMono.variable} h-full antialiased`}
      style={{ colorScheme: "light" }}
    >
      <body className="h-full overflow-hidden">
        <ClerkProvider appearance={{ theme: shadcn }}>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster position="bottom-right" />
        </ClerkProvider>
      </body>
    </html>
  );
}