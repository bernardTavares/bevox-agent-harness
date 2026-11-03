import type { LoadedSkill } from "../skills/skill-runtime.js";

import type { ConnectedClient } from "./client.js";

/**
 * Singleton tracking active connections to external MCP servers plus the
 * synthetic skills each one contributed to the SkillRegistry.
 *
 * The health loop (`startMcpHealthLoop`) iterates `list()` to ping every
 * connection. `closeAll()` is called from the shutdown hook to stop both
 * the health interval and the SDK clients.
 */
export class McpClientRegistry {
  private static instance: McpClientRegistry | undefined;
  private clients = new Map<string, ConnectedClient>();
  private skillsByServer = new Map<string, LoadedSkill[]>();
  private healthTimer: NodeJS.Timeout | undefined;

  static getInstance(): McpClientRegistry {
    if (!McpClientRegistry.instance) {
      McpClientRegistry.instance = new McpClientRegistry();
    }
    return McpClientRegistry.instance;
  }

  /** Test-only: reset internal state. */
  static resetForTests(): void {
    McpClientRegistry.instance = new McpClientRegistry();
  }

  add(connected: ConnectedClient, skills: LoadedSkill[]): void {
    this.clients.set(connected.serverId, connected);
    this.skillsByServer.set(connected.serverId, skills);
  }

  list(): ConnectedClient[] {
    return Array.from(this.clients.values());
  }

  skillsFor(serverId: string): LoadedSkill[] {
    return this.skillsByServer.get(serverId) ?? [];
  }

  setHealthTimer(timer: NodeJS.Timeout | undefined): void {
    this.healthTimer = timer;
  }

  async closeAll(): Promise<void> {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
    await Promise.allSettled(Array.from(this.clients.values()).map((c) => c.close()));
    this.clients.clear();
    this.skillsByServer.clear();
  }
}
