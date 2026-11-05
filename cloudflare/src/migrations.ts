/** The migration files, bundled as text (wrangler.jsonc `rules`). A new migration is one more import and one more entry. */
import m0001 from "../migrations/0001_init.sql";
import { migrate, type Migration } from "./migrate";

const MIGRATIONS: Migration[] = [{ name: "0001_init.sql", sql: m0001 }];

let done: Promise<void> | null = null;

/** Once per isolate: one D1 round trip when nothing is pending. A failure is retried on the next call. */
export function ensureMigrated(db: D1Database): Promise<void> {
  return (done ??= migrate(db, MIGRATIONS).then(
    () => undefined,
    (e) => {
      done = null;
      throw e;
    },
  ));
}
