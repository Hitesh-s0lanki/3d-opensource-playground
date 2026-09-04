import type { Metadata } from "next";
import { ViewerApp } from "./_components/viewer-app";

/** The studio. Everything it shows belongs to one account; the `(protected)`
 * layout has already turned a visitor who is not signed in back to `/sign-in`,
 * so by the time this renders there is someone to render it for. */
export const metadata: Metadata = {
  title: "Studio — dioramic",
  description: "Your runs, your meshes, and the photos they came from.",
};

export default function StudioPage() {
  return <ViewerApp />;
}
