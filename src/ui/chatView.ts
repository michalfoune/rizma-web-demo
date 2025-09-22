// UI-only helpers for rendering chat bubbles in #chat

import { getEl } from './dom';
import type { Memory, ChatMessage } from '../state/memory';

export type Sender = 'user' | 'elena';

/** Map stored roles to UI senders (tolerates both 'assistant' and 'elena'). */
function roleToSender(role: ChatMessage['role']): Sender {
  if (role === 'user') return 'user';
  // Treat both 'assistant' and legacy 'elena' as Elena (left)
  return 'elena';
}

/** Create and append a chat bubble; user aligns right, Elena aligns left. */
export function addMessage(text: string, sender: Sender): void {
  const chatEl = getEl('chat');

  const row = document.createElement('div');
  row.style.display = 'flex';
  row.style.justifyContent = sender === 'user' ? 'flex-end' : 'flex-start';

  const bubble = document.createElement('div');
  bubble.textContent = (text || '').trim();
  bubble.style.maxWidth = '80%';
  bubble.style.padding = '10px 12px';
  bubble.style.border = 'none';
  bubble.style.borderRadius = '12px';
  bubble.style.whiteSpace = 'pre-wrap';
  bubble.style.wordBreak = 'break-word';

  // Colors: user (right) lighter peach; Elena (left) very light gray
  if (sender === 'user') {
    bubble.style.background = '#FFE6DE'; // lighter peach
  } else {
    bubble.style.background = '#F5F5F5'; // very light gray
  }

  row.appendChild(bubble);
  chatEl.appendChild(row);

  // Auto-scroll to newest
  chatEl.scrollTop = chatEl.scrollHeight;
}

/** Remove all bubbles from the chat view. */
export function clearChat(): void {
  const chatEl = getEl('chat');
  chatEl.innerHTML = '';
}

/** Render existing history from memory into the chat view. */
export function renderHistory(mem: Memory): void {
  clearChat();
  for (const m of mem.messages) {
    const sender = roleToSender(m.role);
    addMessage(m.content, sender);
  }
}