import { makeWorkerUtils, type WorkerUtils } from "graphile-worker";
import { getPool } from "../db.js";

// The job queue lives in Postgres (graphile-worker): no extra service, data stays in the UK database,
// retries with backoff, and cron for scheduled sweeps.
let utils: WorkerUtils | undefined;
export async function queue(): Promise<WorkerUtils> {
  utils ??= await makeWorkerUtils({ pgPool: getPool() });
  return utils;
}
export async function releaseQueue() { await utils?.release(); utils = undefined; }

export type JobName = "process_inbound" | "send_approval" | "send_outbox" | "notify_owner";

export async function enqueue(name: JobName, payload: Record<string, unknown>, opts: { jobKey?: string; maxAttempts?: number } = {}) {
  const q = await queue();
  await q.addJob(name, payload, { maxAttempts: opts.maxAttempts ?? 5, jobKey: opts.jobKey });
}
