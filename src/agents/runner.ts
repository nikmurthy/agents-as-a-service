import Anthropic from "@anthropic-ai/sdk";
import type { AgentDefinition, ReplyStyle, RunEvent, Tenant } from "../types.js";
import { env } from "../env.js";
import { tools, type ToolContext, type ToolName } from "./tools.js";
import { packRules } from "./registry.js";
import { mockAgent } from "./mock.js";
import { utcToLocal } from "../time.js";

let client: Anthropic | undefined;
export const anthropic = () => (client ??= new Anthropic({ apiKey: env.anthropicApiKey }));
/** Tests only: swap in a fake client. */
export function setAnthropicClientForTests(c: Anthropic | undefined) { client = c; }

const GREETING = { hi: "Hi <first name>,", hello: "Hello <first name>,", dear: "Dear <first name>," } as const;
const LENGTH = { short: "short: a few sentences at most", medium: "medium: a short paragraph or two", detailed: "detailed: cover everything they asked, still clear and easy to read" } as const;

/** How replies should sound: Flows → Reply. */
export function styleLines(st: ReplyStyle | undefined): string[] {
  if (!st) return [];
  const examples = (st.examples ?? []).filter((e) => e.trim());
  return [
    st.greeting ? `Greeting: start with "${GREETING[st.greeting]}"` : undefined,
    st.length ? `Reply length: ${LENGTH[st.length]}` : undefined,
    st.emoji ? `Emoji: ${st.emoji === "never" ? "never use emoji" : "an occasional emoji is fine on WhatsApp and text, never in email"}` : undefined,
    st.spelling ? `Spelling: ${st.spelling === "american" ? "American English" : "British English"}` : undefined,
    st.avoid ? `Words and phrases never to use: ${st.avoid}` : undefined,
    examples.length ? `Replies the business wrote itself. Match their voice, wording and length. Never copy facts, prices, names, dates or promises from them:\n${examples.map((e, i) => `<example ${i + 1}>\n${e}\n</example ${i + 1}>`).join("\n")}` : undefined,
  ].filter((x): x is string => !!x);
}

export function tenantSummary(tenant: Tenant, now: Date): string {
  const s = tenant.settings;
  const local = utcToLocal(now, s.timezone);
  return [
    `Name: ${tenant.name}`,
    `Tone: ${s.tone}`,
    `Sign-off: ${s.signOff}`,
    s.serviceArea?.length ? `Service area (postcode districts): ${s.serviceArea.join(", ")}` : undefined,
    `Services: ${s.services.map((x) => `${x.name} (${x.durationMinutes} min${x.price ? `, ${x.price}` : ""})`).join("; ")}`,
    s.priceGuide?.length ? `Price guide (ranges only, never a firm quote):\n${s.priceGuide.map((p) => `  - ${p.item}: ${p.range}`).join("\n")}` : undefined,
    ...styleLines(s.replyStyle),
    s.replyGuidance ? `How to shape replies: ${s.replyGuidance}` : undefined,
    `Working hours: ${s.workingHours.start}-${s.workingHours.end}, days ${s.workingHours.days.join(",")} (1=Mon)`,
    `Now: ${new Date(local.slice(0, 10)).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" })} ${local.replace("T", " ")} (${s.timezone})`,
  ].filter(Boolean).join("\n");
}

function systemPrompt(def: AgentDefinition, tenant: Tenant, now: Date): string {
  return def.instructions.replace("{{tenant}}", tenantSummary(tenant, now)).replace("{{pack_rules}}", packRules(tenant.pack));
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

  // Current models reject a forced tool_choice ("tool"/"any"), so the model chooses ("auto") and the instructions,
  // plus a reminder after any turn that ends without it, make it finish with the output tool.
  const system = systemPrompt(def, ctx.tenant, ctx.now) +
    `\n\nWhen you have decided, finish by calling the ${def.output.name} tool. Don't answer in plain text.`;

  for (let turn = 0; turn < 8; turn++) {
    const res = await anthropic().messages.create({
      model, max_tokens: def.maxTokens, system, tools: toolDefs, tool_choice: { type: "auto" }, messages,
      ...(def.effort ? { output_config: { effort: def.effort } } : {}),
    } as Anthropic.MessageCreateParamsNonStreaming);
    if ((res.stop_reason as string) === "refusal") throw new Error(`Agent ${def.id} declined this message`);
    if (res.stop_reason === "max_tokens") throw new Error(`Agent ${def.id} ran out of room (maxTokens ${def.maxTokens})`);
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
