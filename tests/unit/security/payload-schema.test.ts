import { describe, it, expect } from 'vitest';
import {
  parseExecutionPayload,
  MAX_MESSAGES,
  MAX_MESSAGE_LENGTH } from
"../../../src/runtime/execution-handler.js";

function basePayload(over: Record<string, unknown> = {}) {
  return {
    execution_id: '11111111-1111-4111-8111-111111111111',
    execution_token: 'a'.repeat(40),
    organization_id: '018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b',
    messages: [{ role: 'user', content: 'hi' }],
    agent_config: { default_model: 'openai/gpt-4o-mini' },
    ...over
  };
}

describe('executionPayloadSchema (Phase 3 bounds)', () => {
  it('accepts a well-formed payload with system_prompt', () => {
    const payload = basePayload({
      agent_config: { default_model: 'openai/gpt-4o-mini', system_prompt: 'You are helpful' }
    });
    expect(() => parseExecutionPayload(payload)).not.toThrow();
  });

  it('rejects payload > 256KB', () => {
    const big = basePayload({
      messages: Array.from({ length: MAX_MESSAGES }, () => ({
        role: 'user',
        content: 'x'.repeat(MAX_MESSAGE_LENGTH)
      }))
    });
    expect(() => parseExecutionPayload(big)).toThrow(/exceeds/);
  });

  it('rejects messages array > MAX_MESSAGES', () => {
    const tooMany = basePayload({
      messages: Array.from({ length: MAX_MESSAGES + 1 }, () => ({ role: 'user', content: 'hi' }))
    });
    expect(() => parseExecutionPayload(tooMany)).toThrow();
  });

  it('rejects message content > MAX_MESSAGE_LENGTH', () => {
    const tooLong = basePayload({
      messages: [{ role: 'user', content: 'x'.repeat(MAX_MESSAGE_LENGTH + 1) }]
    });
    expect(() => parseExecutionPayload(tooLong)).toThrow();
  });

  it('rejects default_model with invalid charset', () => {
    const bad = basePayload({ agent_config: { default_model: 'rm -rf /' } });
    expect(() => parseExecutionPayload(bad)).toThrow();
  });

  it('rejects default_model with disallowed provider prefix', () => {
    const bad = basePayload({ agent_config: { default_model: 'evil-provider/foo' } });
    expect(() => parseExecutionPayload(bad)).toThrow();
  });

  it('rejects execution_token shorter than 20 chars', () => {
    const bad = basePayload({ execution_token: 'short' });
    expect(() => parseExecutionPayload(bad)).toThrow();
  });

  it('accepts bare model name without provider prefix', () => {
    const ok = basePayload({ agent_config: { default_model: 'gpt-4o-mini' } });
    expect(() => parseExecutionPayload(ok)).not.toThrow();
  });
});