import type { ChatMessage } from '../state/memory';
import { PROXY_BASE } from '../config/constants';

function toAbsoluteEndpoint(endpoint: string): string {
  // If already absolute, URL(...) will succeed
  try {
    return new URL(endpoint).toString();
  } catch {
    // fall through to build from a base
  }

  // Prefer configured proxy base if it looks absolute; otherwise use window origin.
  let base = '';
  try {
    if (typeof PROXY_BASE === 'string' && /^https?:\/\//i.test(PROXY_BASE)) {
      base = PROXY_BASE;
    }
  } catch {
    // ignore
  }

  if (!base && typeof window !== 'undefined' && window.location?.origin) {
    base = window.location.origin;
  }

  // new URL(relative, base) will normalize slashes correctly
  return new URL(endpoint, base || 'http://localhost').toString();
}

export type EvalResult = {
  score: number; pass: boolean;
  strengths: string[]; improvements: string[];
  fillerPer100: number; toneHint: string; paceHint: string;
};

type EvalOpts = {
  endpoint?: string;
  signal?: AbortSignal;
  maxTurns?: number;     // only send last N user/assistant turns
  timeoutMs?: number;    // local timeout guard
};

export async function evaluateTranscript(
  messages: ChatMessage[],
  { endpoint = '/eval', signal, maxTurns = 60, timeoutMs = 8000 }: EvalOpts = {}
): Promise<EvalResult> {
  // Keep only user/assistant and last N
  const filtered = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-maxTurns)
    .map(m => ({ role: m.role, content: m.content || '' }));

  if (filtered.length === 0) {
    return {
      score: 75, pass: true,
      strengths: ['Kept the conversation going'],
      improvements: ['Be more specific'],
      fillerPer100: 0, toneHint: 'Balanced', paceHint: 'Comfortable',
    };
  }

  // Compose timeout with any upstream signal
  const ac = new AbortController();
  const onAbort = () => ac.abort((signal as any)?.reason ?? 'aborted');
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const t = setTimeout(() => ac.abort('eval-timeout'), timeoutMs);

  try {
    const url = toAbsoluteEndpoint(endpoint);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: filtered }),
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`Eval failed: ${res.status}`);
    const data = await res.json();

    const num = (v: any, d: number) => (Number.isFinite(+v) ? +v : d);
    const arr = (v: any) => (Array.isArray(v) ? v : []);
    const clamp01 = (v: number) => Math.max(0, Math.min(100, v));

    return {
      score: clamp01(num(data.score, 75)),
      pass: Boolean(data.pass ?? true),
      strengths: arr(data.strengths),
      improvements: arr(data.improvements),
      fillerPer100: num(data.fillerPer100, 0),
      toneHint: String(data.toneHint ?? 'Balanced'),
      paceHint: String(data.paceHint ?? 'Comfortable'),
    };
  } finally {
    clearTimeout(t);
    if (signal) signal.removeEventListener('abort', onAbort as any);
  }
}