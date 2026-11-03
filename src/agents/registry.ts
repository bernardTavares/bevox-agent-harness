import type { BaseAgent } from "./base-agent.js";
import type { AgentType } from "./types.js";

export class AgentRegistry {
  private static instance: AgentRegistry;
  private agents = new Map<string, BaseAgent>();

  private constructor() {}

  static getInstance(): AgentRegistry {
    if (!AgentRegistry.instance) {
      AgentRegistry.instance = new AgentRegistry();
    }
    return AgentRegistry.instance;
  }

  register(agent: BaseAgent): void {
    if (this.agents.has(agent.name)) {
      throw new Error(`Agent already registered: ${agent.name}`);
    }
    this.agents.set(agent.name, agent);
  }

  resolve(name: string): BaseAgent {
    const agent = this.agents.get(name);
    if (!agent) {
      throw new Error(`Agent not found: ${name}`);
    }
    return agent;
  }

  listByType(type: AgentType): BaseAgent[] {
    return Array.from(this.agents.values()).filter((a) => a.type === type);
  }

  has(name: string): boolean {
    return this.agents.has(name);
  }
}
