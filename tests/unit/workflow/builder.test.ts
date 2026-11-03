import { describe, expect, it } from "vitest";

import { createStep, createWorkflow } from "../../../src/workflow/builder.js";

describe("WorkflowBuilder", () => {
  it("chains step() calls in order", () => {
    const a = createStep("a", async () => 1);
    const b = createStep("b", async () => 2);

    const def = createWorkflow("wf", 1).step(a).step(b).build("desc");

    expect(def.id).toBe("wf");
    expect(def.version).toBe(1);
    expect(def.steps.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("builds branch composite with both arms", () => {
    const truthyStep = createStep("t", async () => "T");
    const falsyStep = createStep("f", async () => "F");

    const def = createWorkflow("wf").branch(
      "decide",
      () => true,
      [truthyStep],
      [falsyStep],
    ).build("desc");

    expect(def.steps[0]!.kind).toBe("branch");
    expect(def.steps[0]!.branches?.truthy.map((s) => s.id)).toEqual(["t"]);
    expect(def.steps[0]!.branches?.falsy.map((s) => s.id)).toEqual(["f"]);
  });

  it("builds parallel composite", () => {
    const def = createWorkflow("wf")
      .parallel("par", [
        createStep("p1", async () => 1),
        createStep("p2", async () => 2),
      ])
      .build("desc");

    expect(def.steps[0]!.kind).toBe("parallel");
    expect(def.steps[0]!.parallel?.length).toBe(2);
  });

  it("rejects duplicate step ids", () => {
    const dup = createStep("a", async () => null);
    expect(() => createWorkflow("wf").step(dup).step(dup).build("desc")).toThrow(
      /duplicate or cyclic/,
    );
  });

  it("rejects branch sub-tree referencing an ancestor id (cycle)", () => {
    const outer = createStep("outer", async () => 1);
    const inner = createStep("outer", async () => 2); // same id intentionally
    expect(() =>
      createWorkflow("wf")
        .step(outer)
        .branch("br", () => true, [inner])
        .build("desc"),
    ).toThrow(/duplicate or cyclic/);
  });

  it("does NOT expose a .then() alias", () => {
    // Compile-time check is the real safety. Run-time assertion for clarity.
    const b = createWorkflow("wf");
    expect((b as unknown as { then?: unknown }).then).toBeUndefined();
  });
});
