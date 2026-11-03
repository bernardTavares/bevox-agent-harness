import { describe, it, expect } from 'vitest';
import { buildPermissionContext } from "../../../src/permissions/permission-context.js";
import type { AgentDefinition } from "../../../src/agents/types.js";
import type { ExecutionPayload } from "../../../src/runtime/execution-handler.js";

const agent: AgentDefinition = {
  name: 'scheduler',
  type: 'surface',
  description: 't',
  reasoning: { default: 'react' },
  permissions: { required: [], optional: [], denied: [] }
};

const ORG = '018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b';

function basePayload(): ExecutionPayload {
  return {
    execution_id: '11111111-1111-4111-8111-111111111111',
    execution_token: 'a-very-long-token-value-1234567890',
    organization_id: ORG,
    messages: [],
    skills: []
  } as unknown as ExecutionPayload;
}

describe('buildPermissionContext', () => {
  it('uses organization_id from the payload (ADR-019 sole tenant id)', () => {
    const payload = basePayload();
    const ctx = buildPermissionContext({ agent, payload, unavailableTools: [] });
    expect(ctx.organizationId).toBe(ORG);
    expect(ctx.executionId).toBe(payload.execution_id);
    expect(ctx.agentName).toBe('scheduler');
    expect(ctx.agentType).toBe('surface');
  });

  it('propagates the organization_id verbatim (no coercion / no fallback)', () => {
    const other = '018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8c';
    const payload = basePayload();
    payload.organization_id = other;
    const ctx = buildPermissionContext({ agent, payload, unavailableTools: [] });
    expect(ctx.organizationId).toBe(other);
  });

  it('uses string conversation.id as-is', () => {
    const payload = basePayload();
    (payload as unknown as {conversation: {id: string;};}).conversation = { id: 'conv-abc' };
    const ctx = buildPermissionContext({ agent, payload, unavailableTools: [] });
    expect(ctx.conversationKey).toBe('conv-abc');
  });

  it('coerces numeric conversation.id to string', () => {
    const payload = basePayload();
    (payload as unknown as {conversation: {id: number;};}).conversation = { id: 12 };
    const ctx = buildPermissionContext({ agent, payload, unavailableTools: [] });
    expect(ctx.conversationKey).toBe('12');
  });

  it('falls back to execution_id when conversation absent', () => {
    const payload = basePayload();
    const ctx = buildPermissionContext({ agent, payload, unavailableTools: [] });
    expect(ctx.conversationKey).toBe(payload.execution_id);
  });

  it('picks up inboxId from numeric context.inbox_id', () => {
    const payload = basePayload();
    (payload as unknown as {context: {inbox_id: number;};}).context = { inbox_id: 4 };
    const ctx = buildPermissionContext({ agent, payload, unavailableTools: [] });
    expect(ctx.inboxId).toBe(4);
  });

  it('passes through unavailableTools and accountDeniedTools', () => {
    const ctx = buildPermissionContext({
      agent,
      payload: basePayload(),
      unavailableTools: ['x', 'y'],
      accountDeniedTools: ['z']
    });
    expect(ctx.unavailableTools).toEqual(['x', 'y']);
    expect(ctx.accountDeniedTools).toEqual(['z']);
  });

  it('defaults accountDeniedTools to []', () => {
    const ctx = buildPermissionContext({ agent, payload: basePayload(), unavailableTools: [] });
    expect(ctx.accountDeniedTools).toEqual([]);
  });
});