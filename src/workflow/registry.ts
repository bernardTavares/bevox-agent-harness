import type { WorkflowDefinition } from "./types.js";

/**
 * Singleton registry for workflow definitions. Mirrors {@link AgentRegistry}.
 *
 * Lookup keys:
 *  - `id@version` — exact lookup, used by `resumeWorkflow` (must match the
 *    version persisted in the DB row).
 *  - `id` — alias for the latest registered version, used at dispatch time
 *    when an `AgentDefinition.workflow: "<id>"` reference doesn't pin a
 *    version.
 */
export class WorkflowRegistry {
  private static instance?: WorkflowRegistry;
  private readonly map = new Map<string, WorkflowDefinition>();

  static getInstance(): WorkflowRegistry {
    if (!WorkflowRegistry.instance) WorkflowRegistry.instance = new WorkflowRegistry();
    return WorkflowRegistry.instance;
  }

  static resetForTests(): void {
    WorkflowRegistry.instance = new WorkflowRegistry();
  }

  register(def: WorkflowDefinition): void {
    const versionedKey = `${def.id}@${def.version}`;
    if (this.map.has(versionedKey)) {
      throw new Error(`Workflow ${versionedKey} already registered`);
    }
    this.map.set(versionedKey, def);

    // Latest-alias: only overwrite if this version is higher.
    const existing = this.map.get(def.id);
    if (!existing || existing.version <= def.version) {
      this.map.set(def.id, def);
    }
  }

  get(idOrKey: string): WorkflowDefinition | undefined {
    return this.map.get(idOrKey);
  }

  getExact(id: string, version: number): WorkflowDefinition | undefined {
    return this.map.get(`${id}@${version}`);
  }

  has(idOrKey: string): boolean {
    return this.map.has(idOrKey);
  }

  list(): WorkflowDefinition[] {
    // Deduplicate by versioned key (skip the latest-alias entries).
    const seen = new Set<string>();
    const out: WorkflowDefinition[] = [];
    for (const [key, def] of this.map.entries()) {
      if (!key.includes("@")) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(def);
    }
    return out;
  }
}
