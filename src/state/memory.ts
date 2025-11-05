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
/** ----------------------------
 * Translators: vendor → ChatMessage
 * Keep these tiny so both GPT‑realtime and Avatar flows can log to one memory.
 * -----------------------------*/

/** Flatten a Realtime "content" array (input_text/output_text blocks) into text. */
function _flattenRealtimeContent(content: any): string {
    try {
        if (!Array.isArray(content)) return '';
        return content
            .map((c: any) => {
                if (!c) return '';
                if (typeof c.text === 'string') return c.text;
                if (typeof c?.content === 'string') return c.content;
                return '';
            })
            .filter(Boolean)
            .join('');
    } catch {
        return '';
    }
}

/**
 * TRANSLATE FROM OpenAI Realtime DataChannel event into a ChatMessage, if possible.
 * Pass optional meta like persona/runId (e.g., persona: "Elena").
 */
export function toChatMessageFromRealtime(
    evt: any,
    meta?: { persona?: string; runId?: string }
): ChatMessage | null {
    if (!evt || typeof evt !== 'object') return null;

    // 1) Finalized user/assistant "message" items
    if (evt.type === 'conversation.item.created' && evt.item?.type === 'message') {
        const role: ChatRole = evt.item?.role === 'user' ? 'user' : 'assistant';
        const text = _flattenRealtimeContent(evt.item?.content);
        if (!text) return null;
        return {
            role,
            content: text.trim(),
            ts: Date.now(),
            source: 'gpt',
            persona: meta?.persona,
            runId: meta?.runId
        };
    }

    // 2) Some runtimes surface a final text blob on response.* events
    // Try a few common shapes without holding streaming deltas.
    if (typeof evt?.response === 'object') {
        // a) evt.response.output array of blocks
        const out = Array.isArray(evt.response.output) ? evt.response.output : null;
        if (out) {
            // Each output entry may contain {type:'output_text', text:'...'} or nested content
            const text = out
                .map((o: any) => {
                    if (!o) return '';
                    if (typeof o.text === 'string') return o.text;
                    if (Array.isArray(o.content)) return _flattenRealtimeContent(o.content);
                    if (typeof o?.content === 'string') return o.content;
                    return '';
                })
                .filter(Boolean)
                .join('');
            if (text) {
                return {
                    role: 'assistant',
                    content: text.trim(),
                    ts: Date.now(),
                    source: 'gpt',
                    persona: meta?.persona,
                    runId: meta?.runId
                };
            }
        }
        // b) evt.response?.output_text?.(joined string)
        const t2 = typeof evt.response.output_text === 'string' ? evt.response.output_text : '';
        if (t2) {
            return {
                role: 'assistant',
                content: t2.trim(),
                ts: Date.now(),
                source: 'gpt',
                persona: meta?.persona,
                runId: meta?.runId
            };
        }
    }

    // 3) Ignore streaming deltas; caller can aggregate if desired.
    return null;
}

/**
 * TRANSLATE FROM CallAnnie/Animato message into a ChatMessage.
 * If the SDK exposes structured events, pass the relevant payload; otherwise just pass the string you sent/received.
 */
export function toChatMessageFromAnnie(
    kind: 'user' | 'assistant',
    payload: unknown,
    meta?: { persona?: string; runId?: string }
): ChatMessage | null {
    let text = '';
    if (typeof payload === 'string') {
        text = payload;
    } else if (payload && typeof (payload as any).text === 'string') {
        text = (payload as any).text;
    } else if (payload && typeof (payload as any).message === 'string') {
        text = (payload as any).message;
    }
    text = (text || '').trim();
    if (!text) return null;

    return {
        role: kind,
        content: text,
        ts: Date.now(),
        source: 'avatar',
        persona: meta?.persona,  // e.g., "Elena"
        runId: meta?.runId
    };
}