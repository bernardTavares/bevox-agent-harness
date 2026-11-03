import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { AgentExecutionContext } from "../agents/execution-context.js";
import { createLogger } from "../config/logger.js";

import { resumeWorkflow, type RunWorkflowOptions } from "./engine.js";
import { WorkflowRegistry } from "./registry.js";
import type { WorkflowStateStore } from "./state-store.js";

const logger = createLogger({ name: "workflow-resume-server" });

export interface ResumeServerOptions {
  host: string;
  port: number;
  /** Shared secret — must match Bevox-side. Required ≥ 32 chars. */
  secret: string;
  store: WorkflowStateStore;
  /** Factory that produces a fresh execution context for a resume request. */
  contextFactory: (row: {
    executionId: string;
    organizationId: string;
    workflowId: string;
  }) => AgentExecutionContext;
  /** Tool executor injected into every resumed step. */
  toolExecutor: RunWorkflowOptions["toolExecutor"];
}

interface ResumeBody {
  suspendToken: string;
  organizationId: string;
  payload?: unknown;
}

/**
 * Internal HTTP resume server (ADR-012). Binds private interface only.
 *
 * Single endpoint: POST /workflow/resume
 *   Headers: X-Workflow-Resume-Secret: <shared secret>
 *   Body:    { suspendToken, organizationId, payload? }
 *
 * Responses:
 *   200 — resumed (idempotent if already terminal)
 *   400 — invalid body
 *   401 — missing/wrong secret
 *   404 — token unknown for the given account
 *   409 — workflow_version_mismatch or already terminal
 *   500 — engine error
 */
export class WorkflowResumeServer {
  private server: Server | undefined;
  private readonly secretBuf: Buffer;

  constructor(private readonly opts: ResumeServerOptions) {
    if (opts.secret.length < 32) {
      throw new Error("WORKFLOW_RESUME_SECRET must be at least 32 chars");
    }
    this.secretBuf = Buffer.from(opts.secret);
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => {
        this.handle(req, res).catch((err) => {
          logger.error({ err }, "resume request crashed");
          if (!res.headersSent) {
            res.statusCode = 500;
            res.end();
          }
        });
      });
      this.server.once("error", reject);
      this.server.listen(this.opts.port, this.opts.host, () => {
        logger.info(
          { host: this.opts.host, port: this.opts.port },
          "workflow resume server listening",
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = undefined;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST" || req.url !== "/workflow/resume") {
      res.statusCode = 404;
      res.end();
      return;
    }

    const headerSecret = req.headers["x-workflow-resume-secret"];
    if (typeof headerSecret !== "string" || !this.constantTimeEq(headerSecret)) {
      res.statusCode = 401;
      res.end();
      return;
    }

    const body = await this.readBody(req);
    if (!body) {
      res.statusCode = 400;
      res.end();
      return;
    }

    const row = await this.opts.store.loadBySuspendToken(body.suspendToken, body.organizationId);
    if (!row) {
      res.statusCode = 404;
      res.end();
      return;
    }

    const definition = WorkflowRegistry.getInstance().getExact(row.workflowId, row.workflowVersion);
    if (!definition) {
      res.statusCode = 409;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "workflow_version_removed" }));
      return;
    }

    const ctx = this.opts.contextFactory({
      executionId: row.executionId,
      organizationId: row.organizationId,
      workflowId: row.workflowId,
    });

    const result = await resumeWorkflow(
      this.opts.store,
      body.suspendToken,
      body.organizationId,
      body.payload,
      {
        definition,
        context: ctx,
        toolExecutor: this.opts.toolExecutor,
      },
    );

    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        status: result.status,
        workflowExecutionId: result.workflowExecutionId,
        error: result.error,
      }),
    );
  }

  private async readBody(req: IncomingMessage): Promise<ResumeBody | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      req.on("data", (c: Buffer) => {
        total += c.length;
        if (total > 64 * 1024) {
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        try {
          const raw = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<ResumeBody>;
          if (
            typeof raw.suspendToken !== "string" ||
            typeof raw.organizationId !== "string" ||
            raw.organizationId.length === 0
          ) {
            resolve(null);
            return;
          }
          resolve({
            suspendToken: raw.suspendToken,
            organizationId: raw.organizationId,
            payload: raw.payload,
          });
        } catch {
          resolve(null);
        }
      });
      req.on("error", () => resolve(null));
    });
  }

  private constantTimeEq(input: string): boolean {
    const ib = Buffer.from(input);
    if (ib.length !== this.secretBuf.length) return false;
    return timingSafeEqual(ib, this.secretBuf);
  }
}
