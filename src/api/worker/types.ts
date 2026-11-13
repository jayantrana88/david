/** What the Worker-only handlers get: the shared request plus the Worker's own bindings. */
import type { Db } from "../../db";
import type { Req } from "../http";

export type WorkerReq = Req & { env: Env; ctx: ExecutionContext; db: Db };
