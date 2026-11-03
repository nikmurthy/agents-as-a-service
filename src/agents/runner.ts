import Anthropic from "@anthropic-ai/sdk";
import type { AgentDefinition, RunEvent, Tenant } from "../types.js";
import { env } from "../env.js";
import { tools, type ToolContext, type ToolName } from "./tools.js";
import { packRules } from "./registry.js";
import { mockAgent } from "./mock.js";
import { utcToLocal } from "../time.js";

let client: Anthropic | undefined;
const anthropic = () => (client ??= new Anthropic({ apiKey: env.anthropicApiKey }));

function systemPrompt(def: AgentDefinition, tenant: Tenant, now: Date): string {
  const s = tenant.settings;
  const local = utcToLocal(now, s.timezone);
  const summary = [
    `Name: ${tenant.name}`,
    `Tone: ${s.tone}`,
    `Sign-off: ${s.signOff}`,
    s.serviceArea?.length ? `Service area (postcode districts): ${s.serviceArea.join(", ")}` : undefined,
    `Services: ${s.services.map((x) => `${x.name} (${x.durationMinutes} min${x.price ? `, ${x.price}` : ""})`).join("; ")}`,
    s.priceGuide?.length ? `Price guide (ranges only, never a firm quote):\n${s.priceGuide.map((p) => `  - ${p.item}: ${p.range}`).join("\n")}` : undefined,
    s.replyGuidance ? `How to shape replies: ${s.replyGuidance}` : undefined,
    `Working hours: ${s.workingHours.start}-${s.workingHours.end}, days ${s.workingHours.days.join(",")} (1=Mon)`,
    `Now: ${new Date(local.slice(0, 10)).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" })} ${local.replace("T", " ")} (${s.timezone})`,
  ].filter(Boolean).join("\n");
  return def.instructions.replace("{{tenant}}", summary).replace("{{pack_rules}}", packRules(tenant.pack));
}

/** Runs one agent to completion: it may call its permitted tools and must finish with its output tool. */
export async function runAgent<T>(def: AgentDefinition, input: unknown, ctx: ToolContext, events: RunEvent[]): Promise<T> {
  const started = Date.now();
  const model = process.env[`MODEL_${def.id.toUpperCase()}`] ?? def.model;

  if (env.agentMode === "mock") {
    const out = (await mockAgent(def.id, input, ctx)) as T;
    events.push({ step: "agent", agent: def.id, agentVersion: def.version, model: "mock", ms: Date.now() - started });
    return out;
  }

  const allowed = def.tools.filter((n): n is ToolName => n in tools);
  const toolDefs: any[] = [...allowed.map((n) => tools[n].definition), { name: def.output.name, description: def.output.description, input_schema: def.output.schema }];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: "Input as JSON:\n\n" + JSON.stringify(input, null, 2) }];
  let inTok = 0, outTok = 0;

  for (let turn = 0; turn < 8; turn++) {
    const force = allowed.length === 0 || turn >= 6;
    const res = await anthropic().messages.create({
      model, max_tokens: def.maxTokens, system: systemPrompt(def, ctx.tenant, ctx.now), tools: toolDefs,
      tool_choice: force ? { type: "tool", name: def.output.name } : { type: "any" }, messages,
    });
    inTok += res.usage.input_tokens; outTok += res.usage.output_tokens;
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const final = uses.find((u) => u.name === def.output.name);
    if (final) {
      events.push({ step: "agent", agent: def.id, agentVersion: def.version, model, inputTokens: inTok, outputTokens: outTok, ms: Date.now() - started });
      return final.input as T;
    }
    messages.push({ role: "assistant", content: res.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const u of uses) {
      if (!allowed.includes(u.name as ToolName)) {
        results.push({ type: "tool_result", tool_use_id: u.id, content: `Tool ${u.name} is not permitted.`, is_error: true });
        continue;
      }
      const out = await tools[u.name as ToolName].run(ctx, u.input as any);
      events.push({ step: "tool", agent: def.id, detail: `${u.name} -> ${Array.isArray(out) ? out.length + " results" : "ok"}` });
      results.push({ type: "tool_result", tool_use_id: u.id, content: JSON.stringify(out) });
    }
    messages.push({ role: "user", content: results.length ? results : `Finish by calling ${def.output.name}.` });
  }
  throw new Error(`Agent ${def.id} did not finish`);
}
