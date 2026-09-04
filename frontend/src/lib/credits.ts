/** Generation credits: what a user is allowed to spend, and what they have left.
 *
 * Every user gets FREE_CREDITS generations. One generation costs one credit,
 * taken when the job is submitted - the GPU minute is spent the moment Modal
 * accepts the call, so charging on completion would let a user start any
 * number of runs at once for a single credit.
 *
 * A credit that produced nothing is given back: a job that fails, or one the
 * user cancels, is refunded. Only a mesh the user can actually open is
 * something they paid for.
 *
 * The whole balance is two integers on one row, moved by one conditional
 * UPDATE. That matters: Neon's HTTP driver has no interactive transaction, so
 * "check then decrement" in two statements would let two simultaneous submits
 * both pass the check. `where spent < granted` inside the UPDATE is the check,
 * and the row that comes back (or does not) is the answer.
 */

import { and, eq, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import { credits } from "@/db/schema";
import type { CreditsSnapshot } from "./types";

/** What a new account starts with. Kept in step with the column default in
 * `db/schema.ts` - the column is what an INSERT actually uses. */
export const FREE_CREDITS = 5;

/** Figurine renders allowed per user per day. Generous enough that nobody
 * iterating on one upload will meet it, low enough that a held-down button
 * costs cents rather than a bill. See `stylizedOn` in `db/schema.ts`. */
export const DAILY_FIGURINES = 20;

export class OutOfCredits extends Error {
  constructor(granted: number) {
    super(
      `you have used all ${granted} of your free generations - each one costs a credit, and failed or cancelled runs are refunded`,
    );
    this.name = "OutOfCredits";
  }
}

export class FigurineLimit extends Error {
  constructor(perDay: number) {
    super(
      `that is ${perDay} figurine renders today, which is the daily limit - the run itself still works on the image you uploaded`,
    );
    this.name = "FigurineLimit";
  }
}

function snapshot(row: typeof credits.$inferSelect): CreditsSnapshot {
  return {
    granted: row.granted,
    spent: row.spent,
    remaining: Math.max(row.granted - row.spent, 0),
  };
}

/** The user's row, created on first sight. Clerk is the only sign-up there is,
 * and it does not tell us about new accounts, so the allowance is granted
 * lazily here instead of by a webhook. */
async function ensureRow(userId: string): Promise<typeof credits.$inferSelect> {
  const db = getDb();
  const [existing] = await db.select().from(credits).where(eq(credits.userId, userId)).limit(1);
  if (existing) return existing;

  // Two tabs signing in at once both land here; the conflict clause makes the
  // loser a no-op rather than a duplicate-key error.
  await db
    .insert(credits)
    .values({ userId, granted: FREE_CREDITS, spent: 0 })
    .onConflictDoNothing();
  const [row] = await db.select().from(credits).where(eq(credits.userId, userId)).limit(1);
  return row;
}

export async function getCredits(userId: string): Promise<CreditsSnapshot> {
  return snapshot(await ensureRow(userId));
}

/** Take one credit, or throw `OutOfCredits`. Returns what is left after it. */
export async function spendCredit(userId: string): Promise<CreditsSnapshot> {
  const row = await ensureRow(userId);
  const db = getDb();
  const [charged] = await db
    .update(credits)
    .set({ spent: sql`${credits.spent} + 1`, updatedAt: new Date() })
    .where(and(eq(credits.userId, userId), lt(credits.spent, credits.granted)))
    .returning();
  if (!charged) throw new OutOfCredits(row.granted);
  return snapshot(charged);
}

/** Give one back, for a run that produced nothing. Never goes below zero, and
 * never above what was taken, so a double refund cannot mint a credit. */
export async function refundCredit(userId: string): Promise<void> {
  const db = getDb();
  await db
    .update(credits)
    .set({ spent: sql`greatest(${credits.spent} - 1, 0)`, updatedAt: new Date() })
    .where(and(eq(credits.userId, userId), sql`${credits.spent} > 0`));
}

/** Count one figurine render against today's allowance, or throw
 * `FigurineLimit`. Returns how many are left after it.
 *
 * One UPDATE again, for the same reason `spendCredit` is one: the HTTP driver
 * has no interactive transaction, so reading the count and then writing it
 * back would let two simultaneous renders both pass a check that only one of
 * them should have. `is distinct from` is what makes the day roll over inside
 * the same statement - it is true both when the stored date is an earlier day
 * and when it is null, which is every row written before this column existed.
 */
export async function takeFigurine(userId: string): Promise<number> {
  await ensureRow(userId);
  const today = new Date().toISOString().slice(0, 10);
  const db = getDb();
  const [taken] = await db
    .update(credits)
    .set({
      stylizedOn: today,
      stylizedCount: sql`case when ${credits.stylizedOn} is not distinct from ${today}::date then ${credits.stylizedCount} + 1 else 1 end`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(credits.userId, userId),
        sql`(${credits.stylizedOn} is distinct from ${today}::date or ${credits.stylizedCount} < ${DAILY_FIGURINES})`,
      ),
    )
    .returning();
  if (!taken) throw new FigurineLimit(DAILY_FIGURINES);
  return Math.max(DAILY_FIGURINES - taken.stylizedCount, 0);
}

/** Give back a figurine render that never happened.
 *
 * A render that errors bills nothing on OpenAI's side, so it should not have
 * moved today's count either - without this, a key that is expired or out of
 * quota spends the user's whole daily allowance on error messages and then
 * tells them they have hit the limit, which is two wrong answers at once.
 *
 * Guarded on the date as well as the count so a refund that lands just after
 * midnight cannot take one off the new day.
 */
export async function refundFigurine(userId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const db = getDb();
  await db
    .update(credits)
    .set({
      stylizedCount: sql`greatest(${credits.stylizedCount} - 1, 0)`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(credits.userId, userId),
        sql`${credits.stylizedOn} is not distinct from ${today}::date`,
        sql`${credits.stylizedCount} > 0`,
      ),
    );
}
