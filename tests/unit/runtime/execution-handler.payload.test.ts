import { describe, it, expect } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import {
  parseExecutionPayload,
  UnprocessablePayloadError,
  MAX_PAYLOAD_BYTES,
  MAX_MESSAGE_LENGTH } from
"../../../src/runtime/execution-handler.js";

const ORG = '018f3a2b-7c4d-7e1f-9a2b-3c4d5e6f7a8b';

function validBase() {
  return {
    execution_id: '11111111-1111-4111-8111-111111111111',
    execution_token: 'a-very-long-token-string-1234567890',
    organization_id: ORG,
    messages: [{ role: 'user' as const, content: 'hi' }]
  };
}

describe('parseExecutionPayload', () => {
  it('parses a minimal valid payload', () => {
    const result = parseExecutionPayload(validBase());
    expect(result.execution_id).toBe('11111111-1111-4111-8111-111111111111');
    expect(result.messages).toHaveLength(1);
    expect(result.skills).toEqual([]);
  });

  it('rejects missing execution_id', () => {
    const bad = { ...validBase() } as Record<string, unknown>;
    delete bad.execution_id;
    expect(() => parseExecutionPayload(bad)).toThrow();
  });

  it('rejects non-uuid execution_id', () => {
    expect(() => parseExecutionPayload({ ...validBase(), execution_id: 'not-a-uuid' })).toThrow();
  });

  it('rejects token shorter than 20 chars', () => {
    expect(() => parseExecutionPayload({ ...validBase(), execution_token: 'short' })).toThrow();
  });

  it('rejects more than 100 messages', () => {
    const messages = Array.from({ length: 101 }, () => ({ role: 'user' as const, content: 'x' }));
    expect(() => parseExecutionPayload({ ...validBase(), messages })).toThrow();
  });

  it('rejects messages longer than MAX_MESSAGE_LENGTH', () => {
    const long = 'a'.repeat(MAX_MESSAGE_LENGTH + 1);
    expect(() =>
    parseExecutionPayload({ ...validBase(), messages: [{ role: 'user', content: long }] })
    ).toThrow();
  });

  it('rejects payload exceeding MAX_PAYLOAD_BYTES', () => {
    const huge = {
      ...validBase(),
      context: { blob: 'x'.repeat(MAX_PAYLOAD_BYTES + 1) }
    };
    expect(() => parseExecutionPayload(huge)).toThrow(/exceeds.*bytes/);
  });

  it('accepts valid default_model (bare name)', () => {
    const result = parseExecutionPayload({
      ...validBase(),
      agent_config: { default_model: 'gpt-4o-mini' }
    });
    expect(result.agent_config?.default_model).toBe('gpt-4o-mini');
  });

  it('accepts valid default_model with provider prefix', () => {
    const result = parseExecutionPayload({
      ...validBase(),
      agent_config: { default_model: 'openai/gpt-4o' }
    });
    expect(result.agent_config?.default_model).toBe('openai/gpt-4o');
  });

  it('rejects default_model with unknown provider', () => {
    expect(() =>
    parseExecutionPayload({
      ...validBase(),
      agent_config: { default_model: 'totallyfake/x' }
    })
    ).toThrow(/default_model/);
  });

  it('rejects default_model with bad characters', () => {
    expect(() =>
    parseExecutionPayload({
      ...validBase(),
      agent_config: { default_model: 'has spaces!' }
    })
    ).toThrow();
  });

  it('rejects default_model longer than 64 chars', () => {
    expect(() =>
    parseExecutionPayload({
      ...validBase(),
      agent_config: { default_model: 'a'.repeat(65) }
    })
    ).toThrow();
  });

  it('accepts missing messages (defaults to [])', () => {
    const payload: Record<string, unknown> = { ...validBase() };
    delete payload.messages;
    const result = parseExecutionPayload(payload);
    expect(result.messages).toEqual([]);
  });

  it('parses organization_id (ADR-019 sole tenant id) and preserves passthrough fields', () => {
    const result = parseExecutionPayload({
      ...validBase(),
      vendor_meta: { name: 'acme' }
    });
    expect(result.organization_id).toBe(ORG);
    expect((result as unknown as { vendor_meta?: { name?: string } }).vendor_meta?.name).toBe('acme');
  });

  it('rejects messages with unknown role', () => {
    expect(() =>
    parseExecutionPayload({
      ...validBase(),
      messages: [{ role: 'bot', content: 'hi' }]
    })
    ).toThrow();
  });

  it('rejects skills array > 50', () => {
    const skills = Array.from({ length: 51 }, (_, i) => `skill-${i}`);
    expect(() => parseExecutionPayload({ ...validBase(), skills })).toThrow();
  });

  it('throws UnprocessablePayloadError (an UnrecoverableError) on Zod-invalid payload', () => {
    let caught: unknown;
    try {
      parseExecutionPayload({ ...validBase(), execution_id: 'not-a-uuid' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnprocessablePayloadError);
    expect(caught).toBeInstanceOf(UnrecoverableError);
  });

  it('throws UnprocessablePayloadError on oversize payload', () => {
    const huge = { ...validBase(), context: { blob: 'x'.repeat(MAX_PAYLOAD_BYTES + 1) } };
    let caught: unknown;
    try {
      parseExecutionPayload(huge);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnprocessablePayloadError);
  });

  it('salvages execution_id + execution_token when both pass the strict bounds', () => {
    // Shape-invalid (bad messages role) but id+token individually valid → salvageable.
    const bad = { ...validBase(), messages: [{ role: 'nope', content: 'x' }] };
    let caught: UnprocessablePayloadError | undefined;
    try {
      parseExecutionPayload(bad);
    } catch (err) {
      caught = err as UnprocessablePayloadError;
    }
    expect(caught?.executionId).toBe('11111111-1111-4111-8111-111111111111');
    expect(caught?.executionToken).toBe('a-very-long-token-string-1234567890');
  });

  it('does NOT salvage when execution_id is junk (no notify possible)', () => {
    const bad = { ...validBase(), execution_id: 'not-a-uuid' };
    let caught: UnprocessablePayloadError | undefined;
    try {
      parseExecutionPayload(bad);
    } catch (err) {
      caught = err as UnprocessablePayloadError;
    }
    expect(caught?.executionId).toBeUndefined();
    expect(caught?.executionToken).toBeUndefined();
  });

  it('does NOT salvage on oversize (id/token untrusted — never validated)', () => {
    const huge = { ...validBase(), context: { blob: 'x'.repeat(MAX_PAYLOAD_BYTES + 1) } };
    let caught: UnprocessablePayloadError | undefined;
    try {
      parseExecutionPayload(huge);
    } catch (err) {
      caught = err as UnprocessablePayloadError;
    }
    expect(caught?.executionId).toBeUndefined();
  });
});