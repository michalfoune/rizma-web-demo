import { getEl } from "../ui/dom";

const chatEl = getEl('chat');

/** Roles we persist */
export type ChatRole = 'user' | 'elena';

/** One chat message */
export interface ChatMessage {
    role: ChatRole;
    content: string;
    ts?: number; // optional timestamp
}

/** Memory shape */
export interface Memory {
    summary: string;            // running summary
    messages: ChatMessage[];    // full chronological log
}

/** Storage + windowing defaults */
export const MEMORY_KEY = 'rizma_memory_v1';
export const MAX_TURNS_TO_SEND = 6; // send at most last 6 user+elena pairs

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

/** Load from localStorage (mutates the live object) */
export function loadMemory(key: string = MEMORY_KEY): void {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return;
        const data = JSON.parse(raw);
        _mem.summary = typeof data?.summary === 'string' ? data.summary : '';
        _mem.messages = Array.isArray(data?.messages) ? data.messages : [];
    } catch {
        /* ignore parse errors */
    }
}

/** Clear memory (mutates in place so references remain valid) */
export function clearMemory(key: string = MEMORY_KEY): void {
    _mem.summary = '';
    _mem.messages.length = 0;
    saveMemory(key);
}

/** Append a message (auto-trims whitespace, optional timestamp) */
export function addMessage(role: ChatRole, content: string): void {
    const text = (content || '').trim();
    if (!text) return;
    _mem.messages.push({ role, content: text, ts: Date.now() });
    // Do not auto-save every time if you’re performance-sensitive; call saveMemory() explicitly if needed.
}

/**
 * Build the message array to send to the LLM:
 *   - system prompt (you pass it in)
 *   - current summary (if any)
 *   - last N user/assistant turns
 */
export function buildMessages(
    systemPrompt: string,
    maxTurns: number = MAX_TURNS_TO_SEND
): Array<{ role: 'system' | 'user' | 'elena'; content: string }> {
    const msgs: Array<{ role: 'system' | 'user' | 'elena'; content: string }> = [
        { role: 'system', content: systemPrompt }
    ];
    if (_mem.summary) {
        msgs.push({
            role: 'system',
            content: 'Conversation summary so far:\n' + _mem.summary
        });
    }
    const recentTurns = _mem.messages.slice(-maxTurns * 2); // pairs
    msgs.push(...recentTurns);
    return msgs;
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

/** Utility: format a block of messages as "ROLE: content" lines */
export function toContextText(msgs: ChatMessage[]): string {
    return msgs.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
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