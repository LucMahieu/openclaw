import { describe, expect, it } from "vitest";
import { clarify, runReview } from "./engine.js";
import { createDefaultState } from "./schema.js";

describe("gtd-core engine", () => {
  it("applies two-minute rule during clarify", () => {
    const state = createDefaultState();
    const now = Date.now();
    state.inboxItems.push({
      id: "01TESTINBOX0000000000000000",
      rawText: "Vraag budget goedkeuring",
      source: "test",
      capturedAtMs: now,
      createdAtMs: now,
      updatedAtMs: now,
      status: "captured",
    });

    const result = clarify(state, {
      inboxId: "01TESTINBOX0000000000000000",
      actionable: true,
      outcome: "Budget akkoord",
      nextAction: {
        textVerbFirst: "Stuur korte akkoordbevestiging",
        estimateMin: 2,
      },
    });

    expect(result.action?.status).toBe("done");
    expect(result.inbox.status).toBe("organized");
    expect(result.note.toLowerCase()).toContain("two-minute");
  });

  it("weekly review guarantees next action for active projects", () => {
    const state = createDefaultState();
    const now = Date.now();
    state.projects.push({
      id: "01TESTPROJ00000000000000000",
      outcome: "Maak GTD rollout plan",
      status: "active",
      supportRefs: [],
      createdAtMs: now,
      updatedAtMs: now,
    });

    const notes = runReview(state, "weekly");

    expect(notes.join(" ").toLowerCase()).toContain("next action");
    expect(state.actions.length).toBe(1);
    expect(state.projects[0]?.nextActionId).toBe(state.actions[0]?.id);
    expect(state.actions[0]?.status).toBe("active");
  });
});
