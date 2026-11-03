import { describe, it, expect } from 'vitest';
import { evaluatePermission, filterPermittedTools } from "../../../src/permissions/evaluator.js";
import type { AgentDefinition } from "../../../src/agents/types.js";
import type { ToolDefinition } from "../../../src/tools/types.js";
import type { PermissionContext } from "../../../src/permissions/types.js";

const surfaceAgent: AgentDefinition = {
  name: 'test-surface',
  type: 'surface',
  description: 'test',
  reasoning: { default: 'react' },
  permissions: { required: [], optional: [], denied: [] }
};

const pipelineAgent: AgentDefinition = {
  name: 'test-pipeline',
  type: 'pipeline',
  description: 'test',
  reasoning: { default: 'direct' },
  permissions: { required: [], optional: [], denied: [] }
};

const makeTool = (name: string, agentType: 'pipeline' | 'surface' | 'both' = 'both'): ToolDefinition => ({
  name,
  description: 'x',
  category: 'calendar',
  agentType,
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ success: true })
});

const baseContext: PermissionContext = {
  agentName: 'test-surface',
  agentType: 'surface',
  accountId: 1,
  conversationKey: 'conv-1',
  unavailableTools: [],
  accountDeniedTools: []
};

describe('evaluatePermission', () => {
  describe('Layer 1: agent static denied', () => {
    it('denies a tool present in agent.permissions.denied', () => {
      const agent: AgentDefinition = {
        ...surfaceAgent,
        permissions: { ...surfaceAgent.permissions, denied: ['create-appointment'] }
      };
      const result = evaluatePermission(makeTool('create-appointment'), agent, baseContext);
      expect(result.granted).toBe(false);
      if (!result.granted) expect(result.reason).toBe('AGENT_STATIC_DENIED');
    });
  });

  describe('Layer 1b: hardcoded agent-type restrictions', () => {
    it('denies write-profile (pipeline-only) for a surface agent', () => {
      const result = evaluatePermission(makeTool('write-profile'), surfaceAgent, baseContext);
      expect(result.granted).toBe(false);
      if (!result.granted) expect(result.reason).toBe('AGENT_TYPE_MISMATCH');
    });

    it('denies send-message (surface-only) for a pipeline agent', () => {
      const ctx: PermissionContext = { ...baseContext, agentType: 'pipeline' };
      const result = evaluatePermission(makeTool('send-message'), pipelineAgent, ctx);
      expect(result.granted).toBe(false);
      if (!result.granted) expect(result.reason).toBe('AGENT_TYPE_MISMATCH');
    });
  });

  describe('Layer 2: execution context', () => {
    it('denies a tool listed in context.unavailableTools', () => {
      const ctx: PermissionContext = { ...baseContext, unavailableTools: ['search-faq'] };
      const result = evaluatePermission(makeTool('search-faq'), surfaceAgent, ctx);
      expect(result.granted).toBe(false);
      if (!result.granted) expect(result.reason).toBe('TOOL_UNAVAILABLE');
    });

    it('denies a tool listed in context.accountDeniedTools', () => {
      const ctx: PermissionContext = { ...baseContext, accountDeniedTools: ['create-appointment'] };
      const result = evaluatePermission(makeTool('create-appointment'), surfaceAgent, ctx);
      expect(result.granted).toBe(false);
      if (!result.granted) expect(result.reason).toBe('EXECUTION_CONTEXT_DENIED');
    });
  });

  describe('Allow path', () => {
    it('grants a tool that is not denied anywhere', () => {
      const result = evaluatePermission(makeTool('read-calendar'), surfaceAgent, baseContext);
      expect(result.granted).toBe(true);
    });
  });
});

describe('filterPermittedTools', () => {
  it('removes denied tools and keeps granted ones', () => {
    const tools = [
    makeTool('read-calendar'),
    makeTool('write-profile'), // pipeline-only -> denied for surface
    makeTool('send-message')];

    const permitted = filterPermittedTools(tools, surfaceAgent, baseContext);
    const names = permitted.map((t) => t.name).sort();
    expect(names).toEqual(['read-calendar', 'send-message']);
  });
});