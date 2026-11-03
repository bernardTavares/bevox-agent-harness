import { describe, it, expect } from 'vitest';
import { extractAnalyzerOutput } from "../../../src/runtime/execution-handler.js";

describe('extractAnalyzerOutput – sdrSubMode passthrough (Fase B §2.3)', () => {
  it('passes sdrSubMode through when present in output', () => {
    const result = extractAnalyzerOutput({
      success: true,
      output: {
        intent: 'scheduling',
        sentiment: 'positive',
        sentimentConfidence: 0.9,
        topics: ['appointment'],
        urgency: 'medium',
        sdrSubMode: 'qualificacao'
      }
    });
    expect(result.sdrSubMode).toBe('qualificacao');
  });

  it('sdrSubMode is undefined when not present in output', () => {
    const result = extractAnalyzerOutput({
      success: true,
      output: {
        intent: 'question',
        sentiment: 'neutral',
        sentimentConfidence: 0.7,
        topics: [],
        urgency: 'low'
      }
    });
    expect(result.sdrSubMode).toBeUndefined();
  });

  it('other extracted fields are unchanged alongside sdrSubMode', () => {
    const result = extractAnalyzerOutput({
      success: true,
      output: {
        intent: 'complaint',
        sentiment: 'negative',
        sentimentConfidence: 0.6,
        topics: ['delay'],
        urgency: 'high',
        sdrSubMode: 'reativacao'
      }
    });
    expect(result.intent).toBe('complaint');
    expect(result.sentiment).toBe('negative');
    expect(result.sentimentConfidence).toBe(0.6);
    expect(result.topics).toEqual(['delay']);
    expect(result.urgency).toBe('high');
    expect(result.sdrSubMode).toBe('reativacao');
  });

  it('returns defaults (no sdrSubMode) when success is false', () => {
    const result = extractAnalyzerOutput({ success: false, output: null });
    expect(result.intent).toBe('unknown');
    expect(result.sentiment).toBe('neutral');
    expect(result.sdrSubMode).toBeUndefined();
  });
});
