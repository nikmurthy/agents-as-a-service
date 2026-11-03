import { run } from "graphile-worker";
import { getPool } from "./db.js";
import { taskList, crontab } from "./jobs/tasks.js";

// Runs queued jobs (agent runs, approvals, sending) and the scheduled sweeps. Run one or more of these.
const runner = await run({ pgPool: getPool(), taskList, crontab, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 4), noHandleSignals: false });
console.log("Worker running");
await runner.promise;
