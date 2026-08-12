import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

export function getDb() {
  if (!env.DB) {
    throw new Error("The server database is not configured.");
  }

  return drizzle(env.DB, { schema });
}
