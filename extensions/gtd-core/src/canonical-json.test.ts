import { describe, expect, it } from "vitest";
import { canonicalizeState } from "./canonical-json.js";
import { createDefaultState } from "./schema.js";

describe("gtd-core canonical json", () => {
  it("sorts arrays deterministically by createdAtMs and id", () => {
    const state = createDefaultState();

    state.actions.push(
      {
        id: "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
        textVerbFirst: "A",
        context: "computer",
        energy: "med",
        estimateMin: 10,
        hardLandscape: false,
        status: "active",
        createdAtMs: 200,
        updatedAtMs: 200,
      },
      {
        id: "01AAAAAAAAAAAAAAAAAAAAAAAA",
        textVerbFirst: "B",
        context: "computer",
        energy: "med",
        estimateMin: 10,
        hardLandscape: false,
        status: "active",
        createdAtMs: 100,
        updatedAtMs: 100,
      },
      {
        id: "01BBBBBBBBBBBBBBBBBBBBBBBB",
        textVerbFirst: "C",
        context: "computer",
        energy: "med",
        estimateMin: 10,
        hardLandscape: false,
        status: "active",
        createdAtMs: 100,
        updatedAtMs: 100,
      },
    );

    const firstPass = canonicalizeState(state);
    const secondPass = canonicalizeState(firstPass);

    expect(firstPass.actions.map((item) => item.id)).toEqual([
      "01AAAAAAAAAAAAAAAAAAAAAAAA",
      "01BBBBBBBBBBBBBBBBBBBBBBBB",
      "01ZZZZZZZZZZZZZZZZZZZZZZZZ",
    ]);
    expect(JSON.stringify(secondPass)).toBe(JSON.stringify(firstPass));
  });
});
