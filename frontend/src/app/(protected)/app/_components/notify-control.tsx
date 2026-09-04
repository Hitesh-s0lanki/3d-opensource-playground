"use client";

/** The opt-in for "tell me when it's done".
 *
 * Two shapes of the same switch. `cta` is the one in the waiting room, offered
 * at the only moment the user is actually thinking about the question - they
 * are watching a progress bar that will not move for two minutes. `footer` is
 * the small persistent one in the sidebar, which exists so that turning it
 * back off does not mean digging through browser settings.
 *
 * Nothing is rendered where the browser has no Notification API, and the
 * permission prompt is only ever raised from a real click - Chrome ignores
 * requests that are not, and a prompt nobody asked for is how a site gets
 * blocked permanently.
 */

import { Bell, BellOff, BellRing } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { enableAlerts, muteAlerts, useNotifyState } from "@/lib/notify";
import { cn } from "@/lib/utils";

interface NotifyControlProps {
  variant?: "cta" | "footer";
  className?: string;
}

export function NotifyControl({ variant = "cta", className }: NotifyControlProps) {
  const { supported, permission, enabled } = useNotifyState();
  if (!supported) return null;

  const blocked = permission === "denied";

  const turnOn = async () => {
    const result = await enableAlerts();
    if (result === "granted") {
      toast.success("Alerts on", {
        description: "You will get a notification when a run finishes, even in another tab.",
      });
    } else if (result === "denied") {
      toast.error("Your browser is blocking notifications for this site", {
        description: "Allow them in the padlock menu next to the address bar to be pinged.",
      });
    }
  };

  const turnOff = () => {
    muteAlerts();
    toast("Alerts off", { description: "Finished runs will still appear in the list." });
  };

  if (variant === "footer") {
    return (
      <button
        type="button"
        aria-pressed={enabled}
        onClick={() => (enabled ? turnOff() : void turnOn())}
        title={
          blocked
            ? "Notifications are blocked for this site in your browser"
            : enabled
              ? "Stop notifying me when a run finishes"
              : "Notify me when a run finishes"
        }
        className={cn(
          "focus-ring flex items-center gap-1 rounded hover:text-ink",
          enabled && "text-brand-deep",
          className,
        )}
      >
        {enabled ? (
          <BellRing className="size-3.5" aria-hidden />
        ) : (
          <BellOff className="size-3.5" aria-hidden />
        )}
        alerts
      </button>
    );
  }

  if (enabled) {
    return (
      <p
        className={cn(
          "flex items-center justify-center gap-1.5 text-[11px] text-ink-muted",
          className,
        )}
      >
        <BellRing className="size-3.5 shrink-0 text-brand" aria-hidden />
        We will ping you when it lands.
        <button
          type="button"
          onClick={turnOff}
          className="focus-ring rounded underline decoration-dotted underline-offset-2 hover:text-ink"
        >
          Turn off
        </button>
      </p>
    );
  }

  if (blocked) {
    return (
      <p className={cn("max-w-xs text-[11px] leading-relaxed text-ink-muted", className)}>
        Notifications are blocked for this site. Allow them from the padlock menu in the address
        bar and we can tell you when this finishes.
      </p>
    );
  }

  return (
    <Button variant="outline" size="sm" className={cn("shadow-xs", className)} onClick={turnOn}>
      <Bell data-icon="inline-start" /> Notify me when it&rsquo;s done
    </Button>
  );
}
