import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';
import { buildRedactionConfig, PII_REDACTION_PATHS, REDACTION_ALWAYS_PATHS } from "../../../src/security/redactors.js";

function makeLogger(level: string) {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    }
  });
  const config = buildRedactionConfig(level);
  const logger = pino({ level, redact: config }, stream);
  return { logger, output: () => chunks.join('') };
}

describe('PII redactors', () => {
  it('redacts execution_token at INFO level', () => {
    const { logger, output } = makeLogger('info');
    logger.info({ execution_token: 'super-secret-abc-12345' }, 'callback');
    const out = output();
    expect(out).not.toContain('super-secret-abc-12345');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts nested phone field at INFO level', () => {
    const { logger, output } = makeLogger('info');
    logger.info({ profile: { phone: '+5511999998888', full_name: 'Alice' } }, 'profile');
    const out = output();
    expect(out).not.toContain('5511999998888');
    expect(out).not.toContain('Alice');
  });

  it('keeps PII visible at DEBUG level (debug-friendly path)', () => {
    const { logger, output } = makeLogger('debug');
    logger.debug({ profile: { phone: '+5511999998888' } }, 'debug-trace');
    const out = output();
    expect(out).toContain('5511999998888');
  });

  it('still redacts tokens even at DEBUG', () => {
    const { logger, output } = makeLogger('debug');
    logger.debug({ execution_token: 'tok-debug-1234567890' }, 'debug-trace');
    const out = output();
    expect(out).not.toContain('tok-debug-1234567890');
  });

  it('redactor lists are non-empty', () => {
    expect(PII_REDACTION_PATHS.length).toBeGreaterThan(REDACTION_ALWAYS_PATHS.length);
    expect(REDACTION_ALWAYS_PATHS).toContain('execution_token');
  });

  it('does NOT redact messages.*.content (debugging stays intact)', () => {
    const { logger, output } = makeLogger('info');
    logger.info({ messages: [{ role: 'user', content: 'hello world' }] }, 'pipeline');
    const out = output();
    expect(out).toContain('hello world');
  });

  it('redacts callback.payload.messages.*.content at egress', () => {
    const { logger, output } = makeLogger('info');
    logger.info(
      { callback: { payload: { messages: [{ role: 'user', content: 'leaked-pii-content' }] } } },
      'egress'
    );
    const out = output();
    expect(out).not.toContain('leaked-pii-content');
  });
});