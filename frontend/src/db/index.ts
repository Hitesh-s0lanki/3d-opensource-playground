/** One Drizzle client over Neon's serverless HTTP driver.
 *
 * The database is not optional. It holds every run, job and blob key there
 * is, so a missing DATABASE_URL is a misconfiguration rather than a degraded
 * mode - there is no on-disk fallback to fall back to.
 */

import { neon } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import * as schema from "./schema";

export type Db = NeonHttpDatabase<typeof schema>;

const globalStore = globalThis as unknown as { __dioramicDb?: Db };

export function getDb(): Db {
  if (!globalStore.__dioramicDb) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        "DATABASE_URL is not set - copy .env.example to .env and fill it in",
      );
    }
    globalStore.__dioramicDb = drizzle(neon(url), { schema });
  }
  return globalStore.__dioramicDb;
}

export function dbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}
