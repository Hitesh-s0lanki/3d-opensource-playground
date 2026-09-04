/** The sections the header points at, in the order the page tells them.
 *
 * One word each, and only three of them: the pill is small and the page is
 * short, so a label only has to be long enough to tell three destinations
 * apart, and the sections a visitor reaches by scrolling anyway - the input
 * guide, the offer at the foot - do not need a second way in. The offer has
 * the two buttons instead. One list, read by both the pill and the phone menu,
 * so the two can never disagree. Each `href` is the `id` of a section on the
 * page; a link without its section is a dead anchor, so they move together.
 */

export const NAV_LINKS = [
  { href: "#examples", label: "Examples" },
  { href: "#how", label: "Steps" },
  { href: "#what-you-get", label: "Features" },
] as const;
