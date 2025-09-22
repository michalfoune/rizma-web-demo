// ---- HTTP fallback: chat + TTS when realtime responds with server_error ----
import { API_BASE, MAX_TURNS_TO_SEND } from '../config/constants';
import { getEl, setText, setVisible, onDomReady } from '../ui/dom';
import {
  memory, loadMemory, saveMemory, clearMemory,
  addMessage, buildMessages, maybeSummarize, shouldSummarize, toContextText
} from '../state/memory';

export async function httpLLM(messages) {
    const r = await fetch(`${API_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: "gpt-4o-mini",
            max_tokens: 220,
            temperature: 0.7,
            messages
        })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || `chat fail ${r.status}`);
    return j?.choices?.[0]?.message?.content || "";
}

export async function httpTTS(text) {
    const r = await fetch(`${API_BASE}/audio/speech`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: "tts-1",
            voice: "marin",
            input: text,
            format: "mp3"
        })
    });
    if (!r.ok) {
        const t = await r.text();
        throw new Error(`tts fail ${r.status}: ${t.slice(0, 200)}`);
    }
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = getEl('fallbackAudio');
    a.src = url;
    await a.play().catch(() => { });
    return url;
}

export async function fallbackReplyFromHTTP() {
    const statusEl = getEl('status');
    try {
        statusEl && (statusEl.textContent = 'Fallback: thinking...');
        // Use rolling memory as context; last user message is already appended
        const msgs = buildMessages(/* userText unused; memory already contains it */"", MAX_TURNS_TO_SEND);
        const text = (await httpLLM(msgs)).trim();
        if (text) {
            addMessage(text, 'elena');
            memory.messages.push({ role: 'elena', content: text });
            saveMemory();
            await httpTTS(text);
        }
        statusEl && (statusEl.textContent = 'Idle');
    } catch (e) {
        console.error('HTTP fallback failed:', e);
        statusEl && (statusEl.textContent = 'Error');
    }
}