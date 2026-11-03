import type { AgentResponse } from "../../reasoning/engine.js";
import type { ExecutionPayload } from "../execution-handler.js";

/**
 * Input passed to every post-execution hook. Includes the final shape of the
 * execution: the payload that arrived, the agent's final response, and the
 * computed final string sent to the user.
 */
export interface PostExecutionHookInput {
  /** Original BullMQ payload. */
  payload: ExecutionPayload;
  /** Synthesized agent response (answer + strategy). */
  agentResponse: AgentResponse;
  /** Final response string sent to Bevox via /complete. */
  finalResponse: string;
  /** Last user message content (joined or single). */
  lastUserMessage: string;
  /** Resolved organizationId (payload.organization_id, UUID string). */
  organizationId: string;
  /** Resolved agent name that produced the response. */
  agentName: string;
}

export interface PostExecutionHook {
  readonly name: string;
  run(input: PostExecutionHookInput): Promise<void>;
}
