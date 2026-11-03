import { describe, expect, it, beforeEach } from "vitest";

import { createStep, createWorkflow } from "../../../src/workflow/builder.js";
import { WorkflowRegistry } from "../../../src/workflow/registry.js";

describe("WorkflowRegistry", () => {
  beforeEach(() => WorkflowRegistry.resetForTests());

  it("registers and looks up by id and id@version", () => {
    const wf = createWorkflow("foo", 1)
      .step(createStep("s", async () => 1))
      .build("d");
    const reg = WorkflowRegistry.getInstance();
    reg.register(wf);
    expect(reg.get("foo")).toBe(wf);
    expect(reg.get("foo@1")).toBe(wf);
    expect(reg.getExact("foo", 1)).toBe(wf);
    expect(reg.getExact("foo", 2)).toBeUndefined();
  });

  it("rejects duplicate id@version", () => {
    const wf = createWorkflow("foo", 1)
      .step(createStep("s", async () => 1))
      .build("d");
    const reg = WorkflowRegistry.getInstance();
    reg.register(wf);
    expect(() => reg.register(wf)).toThrow(/already registered/);
  });

  it("keeps the highest version aliased as latest", () => {
    const reg = WorkflowRegistry.getInstance();
    const v1 = createWorkflow("foo", 1).step(createStep("a", async () => 1)).build("d");
    const v2 = createWorkflow("foo", 2).step(createStep("b", async () => 2)).build("d");
    reg.register(v1);
    reg.register(v2);
    expect(reg.get("foo")).toBe(v2);
    expect(reg.getExact("foo", 1)).toBe(v1);
  });

  it("list() returns each versioned entry exactly once", () => {
    const reg = WorkflowRegistry.getInstance();
    reg.register(createWorkflow("foo", 1).step(createStep("a", async () => 1)).build("d"));
    reg.register(createWorkflow("foo", 2).step(createStep("b", async () => 2)).build("d"));
    reg.register(createWorkflow("bar", 1).step(createStep("c", async () => 1)).build("d"));
    expect(reg.list().length).toBe(3);
  });
});
