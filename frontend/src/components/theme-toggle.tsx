"use client";

/** Light / dark / follow-the-system, in one button. Three states rather than
 * two, because "follow the system" is the default and there has to be a way
 * back to it once you have overridden it.
 */

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const ORDER = ["system", "light", "dark"] as const;
const LABEL = { system: "System theme", light: "Light theme", dark: "Dark theme" };
const ICON = { system: Monitor, light: Sun, dark: Moon };

const subscribeNever = () => () => {};
const onClient = () => true;
const onServer = () => false;

export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  // The server cannot know the stored preference, so the icon is only correct
  // once hydration has happened; showing the neutral one until then keeps the
  // first client render identical to the server's.
  const mounted = useSyncExternalStore(subscribeNever, onClient, onServer);

  const current = (mounted && ORDER.includes(theme as never) ? theme : "system") as
    | "system"
    | "light"
    | "dark";
  const Icon = ICON[current];
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={`${LABEL[current]} — switch to ${LABEL[next].toLowerCase()}`}
            className={className}
            onClick={() => setTheme(next)}
          />
        }
      >
        <Icon />
      </TooltipTrigger>
      <TooltipContent>{LABEL[current]}</TooltipContent>
    </Tooltip>
  );
}
