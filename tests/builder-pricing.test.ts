import { describe, expect, it } from 'vitest';
import { analyzeBuilder } from '../src/core/builder.ts';
import { PriceTable, sumCosts } from '../src/core/pricing.ts';
import { claudeJsonStdout, claudeStreamStdout, codexJsonl } from '../src/demo/builders.ts';

const prices = new PriceTable();

describe('pricing', () => {
  it('estimates all four token classes at their own rates', () => {
    const cost = prices.estimate('claude-opus-4-8', { input: 1_000_000, output: 1_000_000, cacheWrite: 1_000_000, cacheRead: 1_000_000 });
    expect(cost.provenance).toBe('estimated');
    expect(cost.usd).toBeCloseTo(5 + 25 + 6.25 + 0.5, 6);
  });

  it('never borrows a price for an unknown model', () => {
    const cost = prices.estimate('gpt-5.5-codex', { input: 10, output: 10, cacheWrite: 0, cacheRead: 0 });
    expect(cost.usd).toBeNull();
    expect(cost.provenance).toBe('unknown');
  });

  it('resolves dated and Bedrock-style ids to the base model', () => {
    expect(prices.lookup('claude-sonnet-5-5-20261001')).toEqual(prices.lookup('claude-sonnet-5-5'));
    expect(prices.lookup('us.anthropic.claude-haiku-5-5')).toEqual(prices.lookup('claude-haiku-5-5'));
  });

  it('turns a sum with an unknown component into a partial lower bound', () => {
    const total = sumCosts([{ usd: 1, provenance: 'reported', tokens: null }, { usd: null, provenance: 'unknown', tokens: null }, { usd: 2, provenance: 'estimated', tokens: null }]);
    expect(total).toMatchObject({ usd: 3, provenance: 'estimated', partial: true });
    expect(sumCosts([{ usd: null, provenance: 'unknown', tokens: null }]).usd).toBeNull();
  });
});

describe('builder.json stdout', () => {
  it('uses the CLI-reported total_cost_usd from claude --output-format json', () => {
    const a = analyzeBuilder({ status: 'completed', stdout: claudeJsonStdout({ costUsd: 0.4321, model: 'claude-opus-5-5', turns: 12, result: 'ok', input: 10, output: 20, cacheWrite: 30, cacheRead: 40 }) }, prices);
    expect(a.format).toBe('claude-json');
    expect(a.cost).toMatchObject({ usd: 0.4321, provenance: 'reported' });
    expect(a.cost.tokens).toEqual({ input: 10, output: 20, cacheWrite: 30, cacheRead: 40 });
    expect(a.model).toBe('claude-opus-5-5');
    expect(a.turns).toBe(12);
  });

  it('counts usage once per message id in stream-json and lists every tool call', () => {
    const stdout = claudeStreamStdout({ model: 'claude-sonnet-5-5', tools: [{ name: 'Read', input: { file_path: 'a.ts' } }, { name: 'Edit', input: { file_path: 'a.ts' } }] });
    const a = analyzeBuilder({ status: 'completed', stdout }, prices);
    expect(a.format).toBe('claude-stream-json');
    expect(a.toolCalls).toBe(2);
    // Two messages × (1200 in, 300 out, 8000 cache read) — each message has two lines repeating its usage.
    expect(a.cost.tokens).toEqual({ input: 2400, output: 600, cacheWrite: 0, cacheRead: 16000 });
    expect(a.cost.provenance).toBe('estimated');
    expect(a.warnings).toContain('Stream has no final result event (run cut short?)');
  });

  it('parses Codex JSONL usage, splitting cached input, and keeps cost unknown without a model', () => {
    const stdout = codexJsonl({ commands: [{ command: 'npm test', exit: 1 }, { command: 'npm test', exit: 0 }], files: ['src/slug.mjs'], message: 'Fixed',
      turns: [{ input: 10_000, cached: 6_000, output: 800 }, { input: 5_000, cached: 4_000, output: 200 }] });
    const a = analyzeBuilder({ status: 'completed', stdout }, prices, null);
    expect(a.format).toBe('codex-jsonl');
    expect(a.cost.usd).toBeNull();
    expect(a.cost.tokens).toEqual({ input: 5_000, output: 1_000, cacheWrite: 0, cacheRead: 10_000 });
    expect(a.toolCalls).toBe(6);
    expect(a.steps.find(s => s.title === 'shell')?.status).toBe('exit 1');
    const priced = analyzeBuilder({ status: 'completed', stdout }, new PriceTable({ 'gpt-5.5-codex': { input: 1, output: 8, cacheWrite: 1, cacheRead: 0.1 } }), 'gpt-5.5-codex');
    expect(priced.cost.usd).toBeCloseTo((5_000 * 1 + 1_000 * 8 + 10_000 * 0.1) / 1e6, 9);
  });

  it('reports truncated or unrecognized output as unknown cost, never zero', () => {
    const a = analyzeBuilder({ status: 'output-limit', truncated: true, stdout: '{"type":"result","total_co' }, prices);
    expect(a.cost.usd).toBeNull();
    expect(a.format).toBe('unparseable');
    expect(a.warnings[0]).toMatch(/truncated/);
    expect(analyzeBuilder({ status: 'runtime-unavailable', stdout: '' }, prices).cost.note).toMatch(/unavailable/);
  });
});
