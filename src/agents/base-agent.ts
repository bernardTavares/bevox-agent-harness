import type { AgentExecutionContext } from "./execution-context.js";
import type { AgentDefinition, AgentResult } from "./types.js";

export abstract class BaseAgent {
  readonly definition: AgentDefinition;

  constructor(definition: AgentDefinition) {
    this.definition = definition;
  }

  abstract execute(context: AgentExecutionContext): Promise<AgentResult>;

  get name(): string {
    return this.definition.name;
  }

  get type() {
    return this.definition.type;
  }
}
