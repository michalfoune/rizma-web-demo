/** Roles we persist (generic across GPT + avatar) */
export type ChatRole = 'user' | 'assistant';

/** One chat message (neutral schema with provenance) */
export interface ChatMessage {
    role: ChatRole;
    content: string;
    ts?: number;                  // optional timestamp (ms)
    source?: 'gpt' | 'avatar';    // which engine produced it
    persona?: string;             // display label, e.g., 'Elena' or 'Annie'
    runId?: string;               // session/run correlation id
}

/** Memory shape */
export interface Memory {
    summary: string;            // running summary
    messages: ChatMessage[];    // full chronological log
}

/** Storage + windowing defaults */
export const MEMORY_KEY = 'rizma_memory_v2';
export const MAX_TURNS_TO_SEND = 6; // send at most last 6 user+elena pairs

// Optional default runId applied when callers do not pass one.
let _defaultRunId: string | undefined;
export function setDefaultRunId(id?: string): void {
    _defaultRunId = id;
}

// Internal singleton we mutate in place (so live exports stay in sync)
const _mem: Memory = { summary: '', messages: [] };

/**
 * Live reference to memory (mutated in place).
 * You can still call memory.messages.push(...), but prefer addMessage().
 */
export const memory: Memory = _mem;

/** Persist to localStorage */
export function saveMemory(key: string = MEMORY_KEY): void {
    try {
        localStorage.setItem(
            key,
            JSON.stringify({ summary: _mem.summary, messages: _mem.messages })
        );
    } catch {
        /* ignore quota/disable errors */
    }
}

/** Load from localStorage (mutates the live object). */
export function loadMemory(key: string = MEMORY_KEY): void {
    try {
        const raw = localStorage.getItem(key);
        if (raw) {
            const data = JSON.parse(raw);
            _mem.summary = typeof data?.summary === 'string' ? data.summary : '';
            _mem.messages = Array.isArray(data?.messages) ? data.messages : [];
        } else {
            // No data stored yet; start clean
            _mem.summary = '';
            _mem.messages = [];
        }
    } catch {
        // Parse or access error; fall back to clean state
        _mem.summary = '';
        _mem.messages = [];
    }
}

/** Clear memory (mutates in place so references remain valid) */
export function clearMemory(key: string = MEMORY_KEY): void {
    _mem.summary = '';
    _mem.messages.length = 0;
    saveMemory(key);
}

/** Append a message (auto-trims whitespace, optional timestamp).
 *  You can pass meta with runId/source/persona. If runId is omitted, the module will use the last value set via setDefaultRunId().
 */
export function addMessage(
    role: ChatRole,
    content: string,
    meta?: { runId?: string; source?: 'gpt' | 'avatar'; persona?: string }
): void {
    const text = (content || '').trim();
    if (!text) return;
    const runId = meta?.runId ?? _defaultRunId;
    _mem.messages.push({
        role,
        content: text,
        ts: Date.now(),
        ...(meta?.source ? { source: meta.source } : {}),
        ...(meta?.persona ? { persona: meta.persona } : {}),
        ...(runId ? { runId } : {})
    });
    // Do not auto-save every time if you’re performance-sensitive; call saveMemory() explicitly if needed.
}

/**
 * Build the message array to send to an LLM (OpenAI-compatible roles).
 *   - system prompt (you pass it in)
 *   - current summary (if any)
 *   - last N user/assistant turns (neutral)
 */
export function buildMessages(
    systemPrompt: string,
    maxTurns: number = MAX_TURNS_TO_SEND
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    const out: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: systemPrompt }
    ];
    if (_mem.summary) {
        out.push({
            role: 'system',
            content: 'Conversation summary so far:\n' + _mem.summary
        });
    }
    const recent = _mem.messages.slice(-maxTurns * 2)
        .map(m => ({
            role: (m.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
            content: m.content
        }));
    out.push(...recent);
    return out;
}

/** True if we should fold older messages into summary */
export function shouldSummarize(limit: number = MAX_TURNS_TO_SEND * 2): boolean {
    return _mem.messages.length > limit;
}

/** Messages to be summarized (everything except the last `limit`) */
export function getMessagesToSummarize(
    limit: number = MAX_TURNS_TO_SEND * 2
): ChatMessage[] {
    const cut = Math.max(0, _mem.messages.length - limit);
    return _mem.messages.slice(0, cut);
}

/** Message array for performance evaluation */
export function getMessages(opts?: {
  runId?: string;
  roles?: ChatRole[];   // e.g., ['user','assistant']
  lastN?: number;       // take last N messages after filtering
}): ChatMessage[] {
  let arr = _mem.messages;
  if (opts?.runId) arr = arr.filter(m => m.runId === opts.runId);
  if (opts?.roles?.length) arr = arr.filter(m => opts.roles!.includes(m.role));
  if (opts?.lastN && opts.lastN > 0) arr = arr.slice(-opts.lastN);
  return arr;
}

/** Utility: format a block of messages as "ROLE: content" lines */
export function toContextText(msgs: ChatMessage[]): string {
    return msgs.map(m => `${(m.role === 'user' ? 'USER' : 'ASSISTANT')}: ${m.content}`).join('\n\n');
}

/**
 * Maybe summarize older turns into the running summary.
 * You provide the summarizer function (keeps this module UI/network-agnostic).
 *
 * @param summarizeFn  (existingSummary, contextText) => Promise<string>
 * @param limit        keep the last `limit` messages verbatim
 * @returns true if summary updated and messages were trimmed
 */
export async function maybeSummarize(
    summarizeFn: (existingSummary: string, contextText: string) => Promise<string>,
    limit: number = MAX_TURNS_TO_SEND * 2
): Promise<boolean> {
    if (_mem.messages.length <= limit) return false;

    const toSummarize = getMessagesToSummarize(limit);
    const contextText = toContextText(toSummarize);

    const next = (await summarizeFn(_mem.summary, contextText)).trim();
    if (!next) return false;

    _mem.summary = next;
    // Drop summarized portion; keep the last `limit` messages
    _mem.messages = _mem.messages.slice(-limit);
    saveMemory();
    return true;
}

/** Add messages from either source with metadata.
 *  If runId is not provided, the module will use the last value set via setDefaultRunId().
 */
export function addMessageWithMetadata(
    role: ChatRole,
    content: string,
    meta?: { source?: 'gpt' | 'avatar'; persona?: string; runId?: string }
): void {
    const text = (content || '').trim();
    if (!text) return;
    const runId = meta?.runId ?? _defaultRunId;
    _mem.messages.push({
        role,
        content: text,
        ts: Date.now(),
        ...(meta?.source ? { source: meta.source } : {}),
        ...(meta?.persona ? { persona: meta.persona } : {}),
        ...(runId ? { runId } : {})
    });
}