import type { Cost, TokenUsage } from './types.ts';

/** USD per million tokens. cacheWrite is the 5-minute cache-write rate. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

// Anthropic first-party API list prices, from the claude-api reference cached 2026-10-06.
// Cache write = 1.25 × input (5-minute TTL); cache read = 0.1 × input unless the model states otherwise.
// Override or extend with `pricing` in factory-dash.config.json (e.g. for Codex/OpenAI models).
const p = (input: number, output: number, cacheRead = input * 0.1): ModelPrice =>
  ({ input, output, cacheWrite: input * 1.25, cacheRead });

export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'claude-fable-5-1': p(10, 50, 0.25),
  'claude-mythos-5-1': p(10, 50, 0.25),
  'claude-fable-5': p(10, 50),
  'claude-opus-5-5': p(4, 20, 0.2),
  'claude-opus-5': p(5, 25),
  'claude-opus-4-8': p(5, 25),
  'claude-opus-4-7': p(5, 25),
  'claude-opus-4-6': p(5, 25),
  'claude-sonnet-5-5': p(2, 10, 0.2),
  'claude-sonnet-5': p(2, 10),
  'claude-sonnet-4-6': p(3, 15),
  'claude-haiku-5-5': p(0.1, 0.5),
  'claude-haiku-4-5': p(1, 5),
};

export const emptyTokens = (): TokenUsage => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

export function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { input: a.input + b.input, output: a.output + b.output, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead };
}

export const totalTokens = (t: TokenUsage | null) => (t ? t.input + t.output + t.cacheWrite + t.cacheRead : 0);

export class PriceTable {
  private prices: Record<string, ModelPrice>;
  constructor(overrides: Record<string, ModelPrice> = {}) {
    this.prices = { ...DEFAULT_PRICES, ...overrides };
  }

  /** Exact id first, then the id without a date/region suffix (claude-opus-4-8-20260101, us.anthropic.…). */
  lookup(model: string | null | undefined): ModelPrice | null {
    if (!model) return null;
    const normalized = model.replace(/^(?:[a-z]{2}\.)?anthropic\./, '').replace(/\[.*\]$/, '');
    if (this.prices[normalized]) return this.prices[normalized];
    const undated = normalized.replace(/-\d{8}$/, '');
    return this.prices[undated] ?? null;
  }

  /** Token × list price. Returns usd:null for an unpriced model; never substitutes another model's price. */
  estimate(model: string | null | undefined, tokens: TokenUsage): Cost {
    const price = this.lookup(model);
    if (!price) {
      return { usd: null, provenance: 'unknown', tokens, note: model ? `No price configured for ${model}` : 'Model not recorded' };
    }
    const usd = (tokens.input * price.input + tokens.output * price.output +
      tokens.cacheWrite * price.cacheWrite + tokens.cacheRead * price.cacheRead) / 1_000_000;
    return { usd, provenance: 'estimated', tokens };
  }
}

/**
 * Sum costs. An unknown component makes the total partial (a lower bound), never silently zero.
 * Provenance degrades to the weakest component: reported > estimated > unknown.
 */
export function sumCosts(costs: Cost[]): Cost {
  if (!costs.length) return { usd: null, provenance: 'unknown', tokens: null, note: 'No agent spend recorded' };
  let usd = 0;
  let known = 0;
  let tokens: TokenUsage | null = null;
  let partial = false;
  let provenance: Cost['provenance'] = 'reported';
  for (const cost of costs) {
    if (cost.tokens) tokens = addTokens(tokens ?? emptyTokens(), cost.tokens);
    if (cost.usd === null) { partial = true; continue; }
    usd += cost.usd;
    known++;
    if (cost.partial) partial = true;
    if (cost.provenance === 'estimated' && provenance === 'reported') provenance = 'estimated';
  }
  if (!known) return { usd: null, provenance: 'unknown', tokens, partial: true, note: 'All components unknown' };
  return { usd, provenance, tokens, ...(partial ? { partial: true } : {}) };
}
