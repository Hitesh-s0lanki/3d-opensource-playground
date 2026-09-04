/** The foot of the landing page: what this is, and who made it.
 *
 * A dark slab across the full width, and the one block on the page that does
 * not follow the theme. Everything above it is a pale gallery wall that has to
 * stay out of the way of whatever colour the user's model happens to be; the
 * footer is where the page finally ends, and a hard change of ground says that
 * better than another surface panel would. It is deeper than the night ground
 * too, so it still reads as an ending in dark mode.
 *
 * That is why the colours here are literals rather than the `ink`/`surface`
 * tokens: those flip with the theme, and this block must not. Everything laid
 * over the slab is white at an alpha instead of a second fixed colour, so the
 * whole thing is tuned by changing one hex. The muted ramp sits at 6.3:1 on it,
 * which is the bar the rest of the app holds its 10-11px metadata to.
 *
 * Product Hunt is read from the environment because the launch does not exist
 * yet: an unset `NEXT_PUBLIC_PRODUCT_HUNT_URL` simply drops the icon instead of
 * shipping a link to a page that 404s, and setting it on the deploy brings it
 * back with no code change.
 */

import { Globe, Mail } from "lucide-react";
import { GithubIcon, LinkedinIcon, ProductHuntIcon } from "./brand-icons";
import { Logo } from "@/components/logo";

const AUTHOR = {
  name: "Hitesh Solanki",
  site: "https://hiteshsolanki.com",
  github: "https://github.com/Hitesh-s0lanki/3d-opensource-playground",
  linkedin: "https://www.linkedin.com/in/hitesh-solanki",
  email: "hiteshsolanki4623@gmail.com",
} as const;

/** Must be the literal name: Next inlines NEXT_PUBLIC_* at build, so a
 *  computed `process.env[key]` would read as undefined in the browser. */
const productHunt = process.env.NEXT_PUBLIC_PRODUCT_HUNT_URL;

const LINKS = [
  { href: AUTHOR.site, label: "hiteshsolanki.com", icon: Globe },
  { href: AUTHOR.github, label: "Source on GitHub", icon: GithubIcon },
  ...(productHunt
    ? [{ href: productHunt, label: "dioramic on Product Hunt", icon: ProductHuntIcon }]
    : []),
  { href: AUTHOR.linkedin, label: "LinkedIn", icon: LinkedinIcon },
  { href: `mailto:${AUTHOR.email}`, label: `Email ${AUTHOR.email}`, icon: Mail },
];

export function LandingFooter() {
  return (
    <footer className="border-t border-white/10 bg-[#0b0e16] text-[#c9d0e0]">
      <div className="mx-auto w-full max-w-5xl px-4 py-12 sm:px-6 sm:py-14">
        <div className="flex flex-col gap-10 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-xs">
            <div className="flex items-center gap-2.5">
              <Logo className="size-8 shrink-0" />
              <span className="font-display text-xl font-bold tracking-[-0.02em] text-[#f3f5fa]">
                dioramic
              </span>
            </div>
            <p className="mt-3 text-sm leading-snug text-[#a8b1c6]">
              A photo in, a textured <code className="font-mono">.glb</code> out. Open
              source, running on a cloud GPU.
            </p>
          </div>

          <div className="sm:text-right">
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[#8b94aa]">
              Built by
            </p>
            <a
              href={AUTHOR.site}
              target="_blank"
              rel="noreferrer"
              className="mt-1.5 inline-block rounded-full font-display text-2xl font-bold tracking-[-0.02em] text-[#f3f5fa] underline-offset-[6px] outline-none hover:underline focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0e16]"
            >
              {AUTHOR.name}
            </a>
            <ul className="mt-4 flex flex-wrap items-center gap-1.5 sm:justify-end">
              {LINKS.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    target="_blank"
                    rel="noreferrer"
                    title={link.label}
                    className="flex size-10 items-center justify-center rounded-full border border-white/15 text-[#a8b1c6] outline-none transition-colors hover:border-white/25 hover:bg-white/10 hover:text-[#f3f5fa] focus-visible:ring-2 focus-visible:ring-white/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0b0e16]"
                  >
                    <link.icon className="size-4" />
                    <span className="sr-only">{link.label}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mt-10 flex flex-col-reverse gap-2 border-t border-white/10 pt-6 text-xs text-[#8b94aa] sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getFullYear()} {AUTHOR.name}
          </p>
          <p>Meshes by Hunyuan3D-2.1 · nothing you upload is public</p>
        </div>
      </div>
    </footer>
  );
}
