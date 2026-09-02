import "dotenv/config";
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    // Set in frontend/.env (see .env.example) - the Neon connection string.
    url: process.env.DATABASE_URL ?? "",
  },
});
