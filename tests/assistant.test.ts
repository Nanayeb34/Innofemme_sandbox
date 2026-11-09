import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockLanguageModelV4 } from "ai/test";

process.env.SANDBOX_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "momo-sandbox-ai-"));
process.env.SANDBOX_TEAMS = "1";

const { resetWorld } = await import("../src/engine/worlds");
const { chat } = await import("../src/engine/assistant");
const { getConfig, setConfig } = await import("../src/engine/config/store");

const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 50, text: 50, reasoning: 0 } };
const call = (toolName: string, input: unknown) => ({
  content: [{ type: "tool-call" as const, toolCallId: `c${Math.random()}`, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: "tool_calls" },
  usage,
  warnings: [],
});

describe("assistant", () => {
  it("reads a surface, proposes a validated patch, and the proposal applies cleanly", async () => {
    const w = await resetWorld("team-01");
    const steps = [
      call("read_surface", { surface: "menus" }),
      // First attempt points at a node that does not exist: must come back as a validation error.
      call("propose_change", { surface: "menus", summary: "bad", operations: [{ op: "replace", path: "/mtn/nodes/onnet_ref/next", valueJson: '"missing_node"' }] }),
      call("propose_change", {
        surface: "menus",
        summary: "Warn MTN users before paying a number they have never paid",
        operations: [
          { op: "add", path: "/mtn/nodes/onnet_check", valueJson: JSON.stringify({ type: "branch", if: { fact: "recipient_is_new", op: "==", value: true }, then: "onnet_warn", else: "onnet_pin" }) },
          { op: "add", path: "/mtn/nodes/onnet_warn", valueJson: JSON.stringify({ type: "warning", text: "You have never paid this number before.", next: "onnet_pin" }) },
          { op: "replace", path: "/mtn/nodes/onnet_ref/next", valueJson: '"onnet_check"' },
        ],
      }),
      { content: [{ type: "text" as const, text: "I've prepared a warning screen. Press Apply." }], finishReason: { unified: "stop" as const, raw: "stop" }, usage, warnings: [] },
    ];
    const toolResults: unknown[] = [];
    let i = 0;
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        const last = options.prompt[options.prompt.length - 1];
        if (last?.role === "tool") toolResults.push(last.content);
        return steps[i++] as never;
      },
    });

    const reply = await chat(w, "Add a warning before sending to new numbers on MTN", { model });
    expect(reply.text).toContain("Apply");
    expect(reply.proposals).toHaveLength(1);
    expect(JSON.stringify(toolResults[1])).toContain("missing node");

    const p = w.db.prepare("SELECT * FROM proposals WHERE id = ?").get(reply.proposals[0].id) as { surface: "menus"; after: string; summary: string };
    setConfig(w.db, p.surface, JSON.parse(p.after), p.summary, "assistant");
    expect(getConfig(w.db, "menus").mtn.nodes.onnet_warn).toMatchObject({ type: "warning" });
    expect((w.db.prepare("SELECT tokens FROM ai_usage").get() as { tokens: number }).tokens).toBeGreaterThan(0);
  });
});
