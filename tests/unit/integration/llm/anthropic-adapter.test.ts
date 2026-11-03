import { describe, it, expect, vi, afterEach } from 'vitest';
import { AnthropicAdapter } from "../../../../src/integration/llm/adapters/anthropic.adapter.js";
import { CredentialPool } from "../../../../src/integration/llm/credential-pool.js";

describe('AnthropicAdapter', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('maps text content correctly', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'msg_1',
        model: 'claude-3-5-sonnet-latest',
        role: 'assistant',
        content: [{ type: 'text', text: 'hi there' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 4 }
      })
    } as unknown as Response) as unknown as typeof fetch;

    const pool = new CredentialPool();
    pool.register('anthropic', ['ant-key']);
    const adapter = new AnthropicAdapter('claude-3-5-sonnet-latest', pool);
    const res = await adapter.complete({
      messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' }]

    });

    expect(res.content).toBe('hi there');
    expect(res.tool_calls).toEqual([]);
    expect(res.usage.input_tokens).toBe(12);
    expect(res.usage.output_tokens).toBe(4);
    expect(res.usage.total_tokens).toBe(16);
    expect(res.provider).toBe('anthropic');
  });

  it('maps tool_use blocks to tool_calls with content=null when no text', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'msg_2',
        model: 'claude-3-5-sonnet-latest',
        role: 'assistant',
        content: [
        { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { id: 42 } }],

        stop_reason: 'tool_use',
        usage: { input_tokens: 8, output_tokens: 3 }
      })
    } as unknown as Response) as unknown as typeof fetch;

    const pool = new CredentialPool();
    pool.register('anthropic', ['k']);
    const adapter = new AnthropicAdapter('claude-3-5-sonnet-latest', pool);
    const res = await adapter.complete({
      messages: [{ role: 'user', content: 'find 42' }],
      tools: [{ name: 'lookup', description: 'l', parameters: {} }]
    });

    expect(res.content).toBeNull();
    expect(res.tool_calls).toHaveLength(1);
    expect(res.tool_calls[0]!.name).toBe('lookup');
    expect(res.tool_calls[0]!.arguments).toEqual({ id: 42 });
  });

  it('extracts system message from messages array', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string) as Record<string, unknown>;
      return Promise.resolve({
        ok: true,
        json: async () => ({
          id: 'm', model: 'claude-3-5-sonnet-latest', role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 }
        })
      } as unknown as Response);
    }) as unknown as typeof fetch;

    const pool = new CredentialPool();
    pool.register('anthropic', ['k']);
    const adapter = new AnthropicAdapter('claude-3-5-sonnet-latest', pool);
    await adapter.complete({
      messages: [
      { role: 'system', content: 'sys text' },
      { role: 'user', content: 'hi' }]

    });
    expect(capturedBody?.system).toBe('sys text');
    expect(Array.isArray(capturedBody?.messages)).toBe(true);
    expect((capturedBody?.messages as unknown[]).length).toBe(1);
  });
});