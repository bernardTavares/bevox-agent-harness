import type { Redis } from "ioredis";

import type { AgentExecutionContext } from "../agents/execution-context.js";
import { createLogger } from "../config/logger.js";

import { resumeWorkflow, type RunWorkflowOptions } from "./engine.js";
import { WorkflowRegistry } from "./registry.js";
import type { WorkflowStateStore } from "./state-store.js";

const logger = createLogger({ name: "workflow-subscriber" });

export interface SubscriberOptions {
  redis: Redis;
  store: WorkflowStateStore;
  channel?: string;
  contextFactory: (row: {
    executionId: string;
    organizationId: string;
    workflowId: string;
  }) => AgentExecutionContext;
  toolExecutor: RunWorkflowOptions["toolExecutor"];
}

interface ResumePubMessage {
  suspendToken: string;
  organizationId: string;
  payload?: unknown;
}

/**
 * Optional Redis pub/sub resume subscriber (fallback to the HTTP resume
 * server when `WORKFLOW_RESUME_VIA_REDIS=true`).
 *
 * NOT durable: messages published while no subscriber is online are lost.
 * Pair with a periodic reconciliation job in Bevox if you rely on this
 * path.
 */
export class WorkflowResumeSubscriber {
  private readonly channel: string;
  private started = false;

  constructor(private readonly opts: SubscriberOptions) {
    this.channel = opts.channel ?? "workflow:resume";
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.opts.redis.subscribe(this.channel);
    this.opts.redis.on("message", (channel, raw) => {
      if (channel !== this.channel) return;
      this.handle(raw).catch((err) => logger.error({ err }, "resume subscriber failed"));
    });
    this.started = true;
    logger.info({ channel: this.channel }, "workflow resume subscriber started");
  }

  private async handle(raw: string): Promise<void> {
    let msg: ResumePubMessage;
    try {
      msg = JSON.parse(raw) as ResumePubMessage;
    } catch {
      logger.warn("invalid resume message; ignoring");
      return;
    }
    if (
      typeof msg.suspendToken !== "string" ||
      typeof msg.organizationId !== "string" ||
      msg.organizationId.length === 0
    ) {
      logger.warn("resume message missing required fields");
      return;
    }

    const row = await this.opts.store.loadBySuspendToken(msg.suspendToken, msg.organizationId);
    if (!row) {
      logger.warn({ token: msg.suspendToken }, "unknown suspend token");
      return;
    }

    const def = WorkflowRegistry.getInstance().getExact(row.workflowId, row.workflowVersion);
    if (!def) {
      logger.warn({ workflowId: row.workflowId }, "workflow version no longer registered");
      return;
    }

    const ctx = this.opts.contextFactory({
      executionId: row.executionId,
      organizationId: row.organizationId,
      workflowId: row.workflowId,
    });

    await resumeWorkflow(this.opts.store, msg.suspendToken, msg.organizationId, msg.payload, {
      definition: def,
      context: ctx,
      toolExecutor: this.opts.toolExecutor,
    });
  }
}
