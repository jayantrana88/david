/** Worker-only endpoints: the log lines, and "Run now" for a stage. */
import { STAGES, type Stage } from "../../core";
import { tick } from "../../runner";
import { fail, flag, json, ok, readBody, text } from "../http";
import type { WorkerReq } from "./types";

export async function logs(req: WorkerReq): Promise<Response> {
  const stage = req.url.searchParams.get("stage") ?? "";
  const rows = await req.db.all(
    `SELECT at, stage, level, message FROM logs ${/^[a-z]+$/.test(stage) ? "WHERE stage = ?" : ""} ORDER BY id DESC LIMIT 300`,
    /^[a-z]+$/.test(stage) ? [stage] : [],
  );
  return json({ rows });
}

export async function runNow(req: WorkerReq): Promise<Response> {
  const body = await readBody(req);
  const stage = text(body, "stage") as Stage;
  if (!STAGES.includes(stage)) return fail("Unknown stage");
  return ok(await tick(req.env, { only: stage, force: flag(body, "force") }));
}
