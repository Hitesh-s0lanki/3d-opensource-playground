/** The two lines that open a section: a kicker and a title.
 *
 * Every section on the page used to start straight into its content, which is
 * why the nav could point at four places and land on three strips of garnish.
 * A heading is the cheapest structure there is - it costs three words and
 * gives the page something to scan.
 */

export function SectionHead({
  kicker,
  title,
  className = "",
}: {
  kicker: string;
  title: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="kicker">{kicker}</p>
      <h2 className="mt-1.5 font-display text-2xl font-bold tracking-[-0.02em] text-ink sm:text-3xl">
        {title}
      </h2>
    </div>
  );
}
