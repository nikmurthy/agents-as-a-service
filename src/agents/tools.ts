import type { Db } from "../db.js";
import { many } from "../db.js";
import type { Tenant } from "../types.js";
import { availability, openHolds } from "../calendar.js";
import { utcToLocal } from "../time.js";

export interface ToolContext { db: Db; tenant: Tenant; conversationId: string; contactId: string; now: Date }

// Read-only, scoped to this tenant (row-level security) and this customer. Agents never write to the diary:
// the workflow does, after checking what the agent proposed.
export const tools = {
  get_availability: {
    definition: {
      name: "get_availability",
      description: "Free appointment slots in the business's diary. Local times. At most 40 results.",
      input_schema: {
        type: "object",
        properties: {
          durationMinutes: { type: "integer" },
          fromDate: { type: "string", description: "YYYY-MM-DD, inclusive" },
          toDate: { type: "string", description: "YYYY-MM-DD, inclusive" },
        },
        required: ["durationMinutes"],
      },
    },
    run: (ctx: ToolContext, input: any) => availability(ctx.db, ctx.tenant, ctx.now, input),
  },
  list_offered_times: {
    definition: {
      name: "list_offered_times",
      description: "Times we have already offered this customer and are holding for them, with their holdId.",
      input_schema: { type: "object", properties: {} },
    },
    run: (ctx: ToolContext) => openHolds(ctx.db, ctx.conversationId, ctx.tenant.settings.timezone),
  },
  find_appointments: {
    definition: {
      name: "find_appointments",
      description: "This customer's confirmed upcoming appointments, with their holdId.",
      input_schema: { type: "object", properties: {} },
    },
    run: async (ctx: ToolContext) =>
      (await many(ctx.db, "select id, service, start_at, end_at from holds where contact_id = $1 and status = 'confirmed' and start_at > now() order by start_at", [ctx.contactId]))
        .map((r) => ({ holdId: r.id, service: r.service, start: utcToLocal(r.start_at, ctx.tenant.settings.timezone), end: utcToLocal(r.end_at, ctx.tenant.settings.timezone) })),
  },
};
export type ToolName = keyof typeof tools;
