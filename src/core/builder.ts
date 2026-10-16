import type { Cost, TimelineEvent, TokenUsage } from './types.ts';
import { PriceTable, addTokens, emptyTokens } from './pricing.ts';

/** Shape written by project-factory-next src/adapters.mjs runAgent() into attempt-N/builder.json. */
export interface BuilderRecord {
  adapter?: string;
  status?: string;
  exitCode?: number | null;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  outputBytes?: number;
  truncated?: boolean;
  error?: string;
}

export interface BuilderAnalysis {
  format: 'claude-json' | 'claude-stream-json' | 'codex-jsonl' | 'empty' | 'unparseable';
  cost: Cost;
  model: string | null;
  turns: number | null;
  sessionId: string | null;
  toolCalls: number | null;
  steps: Omit<TimelineEvent, 'at' | 'role' | 'actor'>[];
  resultText: string | null;
  warnings: string[];
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function claudeUsage(u: Record<string, unknown> | undefined): TokenUsage {
  return {
    input: num(u?.input_tokens), output: num(u?.output_tokens),
    cacheWrite: num(u?.cache_creation_input_tokens), cacheRead: num(u?.cache_read_input_tokens),
  };
}

function parseLines(text: string): { values: Record<string, unknown>[]; bad: number } {
  const values: Record<string, unknown>[] = [];
  let bad = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object') values.push(value);
      else bad++;
    } catch { bad++; }
  }
  return { values, bad };
}

const summarize = (value: unknown, max = 160) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

/** claude --print --output-format json: one result object. */
function fromClaudeResult(result: Record<string, unknown>, prices: PriceTable, fallbackModel: string | null): Partial<BuilderAnalysis> {
  const modelUsage = result.modelUsage as Record<string, Record<string, unknown>> | undefined;
  const models = modelUsage ? Object.keys(modelUsage) : [];
  const model = models[0] ?? fallbackModel;
  const tokens = claudeUsage(result.usage as Record<string, unknown> | undefined);
  let cost: Cost;
  if (typeof result.total_cost_usd === 'number') {
    cost = { usd: result.total_cost_usd, provenance: 'reported', tokens, note: 'claude CLI total_cost_usd (API-equivalent on a subscription)' };
  } else {
    cost = prices.estimate(model, tokens);
  }
  return {
    cost, model,
    turns: typeof result.num_turns === 'number' ? result.num_turns : null,
    sessionId: typeof result.session_id === 'string' ? result.session_id : null,
    resultText: typeof result.result === 'string' ? result.result : null,
  };
}

export function analyzeBuilder(record: BuilderRecord, prices: PriceTable, fallbackModel: string | null = null): BuilderAnalysis {
  const warnings: string[] = [];
  const base: BuilderAnalysis = {
    format: 'empty', cost: { usd: null, provenance: 'unknown', tokens: null }, model: fallbackModel,
    turns: null, sessionId: null, toolCalls: null, steps: [], resultText: null, warnings,
  };
  const stdout = record.stdout ?? '';
  if (record.truncated) warnings.push('Builder output was truncated at the capture limit; usage may be missing');
  if (!stdout.trim()) {
    base.cost.note = record.status === 'runtime-unavailable' ? 'Agent runtime was unavailable' : 'No builder stdout';
    return base;
  }
  const { values, bad } = parseLines(stdout);
  // A single pretty-printed JSON document (claude --output-format json) parses as a whole, not per line.
  let whole: Record<string, unknown> | null = null;
  try { whole = JSON.parse(stdout); } catch { /* JSONL or broken */ }

  if (whole && !Array.isArray(whole) && (whole.type === 'result' || 'total_cost_usd' in whole)) {
    return { ...base, format: 'claude-json', ...fromClaudeResult(whole, prices, fallbackModel), warnings };
  }

  // claude --output-format stream-json --verbose: system/assistant/user/result events.
  if (values.some(v => v.type === 'assistant' || (v.type === 'system' && v.subtype === 'init'))) {
    const steps: BuilderAnalysis['steps'] = [];
    let toolCalls = 0;
    let model = fallbackModel;
    const seen = new Set<string>();
    let tokens = emptyTokens();
    for (const v of values) {
      if (v.type === 'system' && typeof v.model === 'string') model = v.model;
      if (v.type !== 'assistant') continue;
      const message = v.message as { id?: string; model?: string; usage?: Record<string, unknown>; content?: Record<string, unknown>[] } | undefined;
      if (message?.model) model = message.model;
      if (message?.id && !seen.has(message.id)) { seen.add(message.id); tokens = addTokens(tokens, claudeUsage(message.usage)); }
      for (const block of message?.content ?? []) {
        if (block.type === 'tool_use') {
          toolCalls++;
          steps.push({ kind: 'tool', title: String(block.name), detail: summarize(block.input) });
        } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          steps.push({ kind: 'message', title: 'Agent message', detail: summarize(block.text, 240) });
        }
      }
    }
    const result = values.findLast(v => v.type === 'result');
    const fromResult = result ? fromClaudeResult(result, prices, model) : {};
    const cost = fromResult.cost ?? prices.estimate(model, tokens);
    if (!result) warnings.push('Stream has no final result event (run cut short?)');
    if (bad) warnings.push(`${bad} unparseable stream line(s)`);
    return { ...base, format: 'claude-stream-json', ...fromResult, cost, model: fromResult.model ?? model, toolCalls, steps, warnings };
  }

  // codex exec --json: thread/turn/item events; usage on turn.completed.
  if (values.some(v => typeof v.type === 'string' && /^(thread|turn|item)\./.test(v.type as string))) {
    const steps: BuilderAnalysis['steps'] = [];
    let tokens = emptyTokens();
    let sawUsage = false;
    let toolCalls = 0;
    let sessionId: string | null = null;
    let lastMessage: string | null = null;
    for (const v of values) {
      if (v.type === 'thread.started' && typeof v.thread_id === 'string') sessionId = v.thread_id;
      if (v.type === 'turn.completed' && v.usage) {
        sawUsage = true;
        const u = v.usage as Record<string, unknown>;
        // Codex reports cached tokens as a subset of input tokens.
        const cached = num(u.cached_input_tokens);
        tokens = addTokens(tokens, { input: num(u.input_tokens) - cached, output: num(u.output_tokens), cacheWrite: 0, cacheRead: cached });
      }
      if (v.type === 'turn.failed') {
        steps.push({ kind: 'message', title: 'Turn failed', detail: summarize((v.error as { message?: string })?.message ?? v.error), status: 'failed' });
      }
      if (v.type !== 'item.completed') continue;
      const item = v.item as Record<string, unknown>;
      switch (item?.type) {
        case 'command_execution':
          toolCalls++;
          steps.push({ kind: 'tool', title: 'shell', detail: summarize(item.command), status: item.exit_code === 0 ? 'passed' : item.exit_code == null ? String(item.status ?? '') : `exit ${item.exit_code}` });
          break;
        case 'file_change': {
          toolCalls++;
          const changes = (item.changes as { path?: string; kind?: string }[] | undefined) ?? [];
          steps.push({ kind: 'tool', title: 'file_change', detail: changes.map(c => `${c.kind ?? 'edit'} ${c.path ?? ''}`).join(', ') || undefined });
          break;
        }
        case 'mcp_tool_call':
          toolCalls++;
          steps.push({ kind: 'tool', title: `${item.server ?? 'mcp'}.${item.tool ?? 'tool'}`, status: String(item.status ?? '') });
          break;
        case 'web_search':
          toolCalls++;
          steps.push({ kind: 'tool', title: 'web_search', detail: summarize(item.query) });
          break;
        case 'agent_message':
          lastMessage = typeof item.text === 'string' ? item.text : null;
          steps.push({ kind: 'message', title: 'Agent message', detail: summarize(item.text, 240) });
          break;
        case 'reasoning':
          steps.push({ kind: 'message', title: 'Reasoning', detail: summarize(item.text, 200) });
          break;
        default:
          break;
      }
    }
    if (bad) warnings.push(`${bad} unparseable JSONL line(s)`);
    const cost: Cost = sawUsage ? prices.estimate(fallbackModel, tokens)
      : { usd: null, provenance: 'unknown', tokens: null, note: 'No turn.completed usage in Codex output' };
    if (sawUsage && !fallbackModel) cost.note = 'Codex output does not name the model; pass --model to the factory or configure a price';
    return { ...base, format: 'codex-jsonl', cost, toolCalls, steps, sessionId, resultText: lastMessage, warnings };
  }

  warnings.push('Builder stdout is not a recognized Claude or Codex format');
  return { ...base, format: 'unparseable', cost: { usd: null, provenance: 'unknown', tokens: null, note: 'Unrecognized builder stdout' }, warnings };
}
