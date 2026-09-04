"use client";

/** next-themes, with the class strategy the `dark` custom variant in
 * globals.css expects. `system` is the default so the app matches the machine
 * it is on before anyone has expressed a preference.
 */

import { ThemeProvider as NextThemesProvider } from "next-themes";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      // The stage repaints its WebGL backdrop from CSS variables; a transition
      // there would sample half-swapped colors for a frame.
      disableTransitionOnChange
      storageKey="dioramic-theme"
    >
      {children}
    </NextThemesProvider>
  );
}
