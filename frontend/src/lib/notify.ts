"use client";

/** Telling the user their mesh is ready when they are not looking at the tab.
 *
 * A generation takes minutes, which is exactly long enough that nobody sits
 * and watches it - they switch to something else. Everything the app said
 * about a finished run used to be said inside the page: a toast that expires
 * unseen, a card that quietly appears in a list. This is the part that can
 * reach out of the tab.
 *
 * Three things happen when a run lands, in decreasing order of how much they
 * interrupt: a system notification (opt-in, never raised while the tab is
 * already in front of the user), a short chime, and a count in the tab title -
 * the last of which is free, needs no permission, and is usually enough.
 *
 * The state lives in a module-level store rather than a context because it is
 * browser state, not app state: the permission belongs to the origin and can
 * be changed from outside the page entirely. `useSyncExternalStore` starts
 * from a "nothing is available" snapshot so the server render and the first
 * client render agree, then corrects on subscribe.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";

/** Alerts the user turned off from inside the app. Kept separate from the
 * browser permission: revoking permission is a trip into site settings, and
 * "stop pinging me" should cost one click and be reversible in one more. */
const MUTED_KEY = "dioramic:alerts-muted";

const ICON = "/brand/png/dioramic-icon-192x192.png";
const BADGE = "/brand/png/dioramic-icon-64x64.png";

export type NotifyPermission = NotificationPermission | "unsupported";

export interface NotifyState {
  /** The browser has the Notification API at all - it is absent in some
   * embedded webviews, and on iOS outside an installed web app. */
  supported: boolean;
  /** "default" until the user has been asked. */
  permission: NotifyPermission;
  muted: boolean;
  /** Granted, not muted: a finished run will raise a system notification. */
  enabled: boolean;
}

const NONE: NotifyState = {
  supported: false,
  permission: "unsupported",
  muted: false,
  enabled: false,
};

let current: NotifyState = NONE;
const listeners = new Set<() => void>();

/** Reads the browser, never the cache. `Notification.permission` can change
 * while the page is open - the user can revoke it from the address bar - so
 * anything that acts on it asks again rather than trusting a snapshot. */
function read(): NotifyState {
  if (typeof window === "undefined" || !("Notification" in window)) return NONE;
  const permission = Notification.permission;
  let muted = false;
  try {
    muted = window.localStorage.getItem(MUTED_KEY) === "1";
  } catch {
    /* private mode, or storage blocked; treat as unmuted */
  }
  return {
    supported: true,
    permission,
    muted,
    enabled: permission === "granted" && !muted,
  };
}

function publish(): void {
  const next = read();
  if (
    next.supported === current.supported &&
    next.permission === current.permission &&
    next.muted === current.muted
  ) {
    return;
  }
  current = next;
  for (const listener of listeners) listener();
}

let watching = false;

/** Follow the permission when it is changed from outside the page - the site
 * settings menu, or another tab. Not every browser will answer a query for
 * the "notifications" descriptor, which is why nothing depends on it. */
function watchPermission(): void {
  if (watching || typeof navigator === "undefined" || !navigator.permissions?.query) return;
  watching = true;
  navigator.permissions
    .query({ name: "notifications" as PermissionName })
    .then((status) => {
      status.onchange = publish;
    })
    .catch(() => {
      /* descriptor unsupported; the value is still re-read on every action */
    });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    publish();
    watchPermission();
    // Another tab of the same app flipping the mute toggle.
    window.addEventListener("storage", publish);
  }
  return () => {
    listeners.delete(listener);
  };
}

export function useNotifyState(): NotifyState {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => NONE,
  );
}

/** Built on the click that turns alerts on, which is also the gesture that
 * lets it start: an AudioContext created without one is born suspended. No
 * opt-in, no context, no sound - which is the behaviour we want anyway. */
let audio: AudioContext | null = null;

function primeAudio(): void {
  if (audio) return;
  const Ctor =
    window.AudioContext ??
    (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return;
  try {
    audio = new Ctor();
  } catch {
    audio = null;
  }
}

/** Two notes, a fifth apart, under a second. Synthesised rather than served
 * so there is no asset to load at the moment it is needed - the tab is in the
 * background by then, and a cold fetch is the difference between a chime and
 * silence. */
export function chime(): void {
  const context = audio;
  if (!context) return;
  try {
    if (context.state === "suspended") void context.resume();
    const now = context.currentTime;
    for (const [at, hz] of [
      [0, 660],
      [0.16, 990],
    ] as const) {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = "sine";
      osc.frequency.value = hz;
      // Ramped rather than switched: a square-edged gain change is a click.
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.09, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.34);
      osc.connect(gain).connect(context.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.36);
    }
  } catch {
    /* audio is a nicety; never let it break the alert */
  }
}

/** Ask for permission, and clear the mute while we are at it - the user
 * clicking "notify me" means it either way round.
 *
 * Must be called from a user gesture: Chrome refuses the prompt otherwise,
 * and Safari has never allowed it any other way. */
export async function enableAlerts(): Promise<NotifyPermission> {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  try {
    window.localStorage.removeItem(MUTED_KEY);
  } catch {
    /* nothing to unset */
  }
  primeAudio();
  let permission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch {
      // Older Safari only ever had the callback form; it has still recorded
      // an answer by the time the promise version rejects.
      permission = Notification.permission;
    }
  }
  publish();
  return permission;
}

/** Stop alerting. The permission is left alone: taking it back is the
 * browser's to offer, and asking again after a mute should not need a prompt. */
export function muteAlerts(): void {
  try {
    window.localStorage.setItem(MUTED_KEY, "1");
  } catch {
    /* cannot persist it; this tab still goes quiet for the rest of the session */
  }
  publish();
}

export interface Alert {
  title: string;
  body?: string;
  /** Collapses repeats of the same subject into one notification. The job id
   * is the right value: one alert per run, however many polls see it land. */
  tag?: string;
  /** The photo that produced the mesh, when there is one - a thumbnail of the
   * actual thing says more than the app icon. */
  image?: string;
  onClick?: () => void;
}

/** Raise a system notification, if the user has said yes. Returns whether one
 * was actually shown, so a caller can tell the difference between "notified"
 * and "the toast was all they got". */
export function raiseAlert({ title, body, tag, image, onClick }: Alert): boolean {
  if (!read().enabled) return false;
  try {
    const note = new Notification(title, {
      body,
      tag,
      icon: image ?? ICON,
      badge: BADGE,
    });
    note.onclick = () => {
      window.focus();
      note.close();
      onClick?.();
    };
    return true;
  } catch {
    // Android Chrome throws here on principle: it only shows notifications
    // through a service worker registration. Nothing to do but fall back to
    // the in-page toast the caller already raised.
    return false;
  }
}

/** The tab strip is the one notification channel that is always on, costs no
 * permission, and survives the toast expiring. `badge` is prefixed to whatever
 * the document was titled, and taken away again when it is null. */
export function useTitleBadge(badge: string | null): void {
  const base = useRef<string | null>(null);
  useEffect(() => {
    if (base.current === null) base.current = document.title;
    const title = base.current;
    document.title = badge ? `${badge} · ${title}` : title;
    return () => {
      document.title = title;
    };
  }, [badge]);
}
