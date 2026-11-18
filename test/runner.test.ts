// How agents call Claude in live mode, with a fake client: no database, no network.
// The other tests run agents in mock mode, so they never see the request that goes to the API.
import { test, after } from "node:test";
import assert from "node:assert/strict";

process.env.AGENT_MODE = "live";
process.env.ANTHROPIC_API_KEY = "test-key";

const { runAgent, setAnthropicClientForTests } = await import("../src/agents/runner.js");
const { configAgents } = await import("../src/agents/registry.js");

after(() => setAnthropicClientForTests(undefined));

const tenant = {
  id: "t1", slug: "t", name: "Test Flooring", pack: "flooring", status: "active",
  settings: {
    tone: "friendly", signOff: "Mark", timezone: "Europe/London", services: [{ name: "Survey", durationMinutes: 60 }],
    replyVia: {}, workingHours: { days: [1, 2, 3, 4, 5], start: "08:00", end: "17:00" },
    escalationName: "Mark", spotCheckEvery: 0, reviewerPassScore: 4,
  },
} as any;
const ctx = { db: undefined as any, tenant, conversationId: "c1", contactId: "p1", now: new Date("2026-11-18T10:00:00Z") };

function fakeClient(replies: any[]) {
  const requests: any[] = [];
  const client = { messages: { create: async (req: any) => { requests.push(structuredClone(req)); return replies.shift(); } } };
  return { client: client as any, requests };
}
const usage = { input_tokens: 10, output_tokens: 5 };

test("agents let the model choose tools (forced tool_choice is rejected by current models) and send their effort", async () => {
  const drafting = configAgents().find((a) => a.id === "drafting")!;
  const { client, requests } = fakeClient([
    { stop_reason: "end_turn", usage, content: [{ type: "text", text: "Here is my draft..." }] },
    { stop_reason: "tool_use", usage, content: [{ type: "tool_use", id: "tu1", name: "record_draft", input: { replyText: "Hi", needsHumanBeforeSending: false, internalNote: "" } }] },
  ]);
  setAnthropicClientForTests(client);
  const events: any[] = [];
  const out = await runAgent<any>(drafting, { message: "Hello" }, ctx, events);

  assert.equal(out.replyText, "Hi");
  assert.equal(requests.length, 2, "a text-only turn gets a reminder and another turn");
  for (const r of requests) {
    assert.deepEqual(r.tool_choice, { type: "auto" });
    assert.equal(r.model, drafting.model);
    assert.deepEqual(r.output_config, { effort: drafting.effort });
    assert.match(r.system, /finish by calling the record_draft tool/);
  }
  assert.match(String(requests[1].messages.at(-1).content), /Finish by calling record_draft/);
  assert.equal(events[0].inputTokens, 20);
});

test("a refusal or running out of room fails the agent run instead of looping", async () => {
  const triage = configAgents().find((a) => a.id === "triage")!;
  setAnthropicClientForTests(fakeClient([{ stop_reason: "refusal", usage, content: [] }]).client);
  await assert.rejects(runAgent(triage, {}, ctx, []), /declined/);
  setAnthropicClientForTests(fakeClient([{ stop_reason: "max_tokens", usage, content: [] }]).client);
  await assert.rejects(runAgent(triage, {}, ctx, []), /ran out of room/);
});

test("every agent definition uses a current model and leaves room for thinking", () => {
  for (const a of configAgents()) {
    assert.match(a.model, /^claude-(haiku|sonnet|opus)-5-5$/, a.id);
    assert.ok(a.maxTokens >= 2000, `${a.id} maxTokens`);
  }
});
