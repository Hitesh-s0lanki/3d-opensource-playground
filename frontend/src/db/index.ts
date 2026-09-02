/** One Drizzle client over Neon's serverless HTTP driver, or null when no
 * DATABASE_URL is configured - the whole database layer is optional and the
 * viewer works file-only without it.
 */

import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

export type Db = NeonHttpDatabase<typeof schema>;

const globalStore = globalThis as unknown as { __dioramaDb?: Db | null };

export function getDb(): Db | null {
  if (globalStore.__dioramaDb === undefined) {
    const url = process.env.DATABASE_URL;
    globalStore.__dioramaDb = url ? drizzle(neon(url), { schema }) : null;
  }
  return globalStore.__dioramaDb;
}
