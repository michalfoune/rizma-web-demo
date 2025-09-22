// Minimal signaling: only these are exported:
//   - wireDataChannel()
//   - sendTextAndRespond()
//   - sendResponseCreate()

import { state } from '../state/appState';

// --- internal helpers ---
let serverVAD = true; // captured from wireDataChannel config
function safeSend(obj: unknown): boolean {
  const dc = state.dc;
  if (!dc || dc.readyState !== 'open') return false;
  try { dc.send(JSON.stringify(obj)); return true; }
  catch (e) { console.warn('DC send failed', e, obj); return false; }
}
function sendSessionUpdateInternal(opts: {
  instructions?: string;
  voice?: string;
  modalities?: Array<'audio' | 'text'>;
  useServerVAD?: boolean;
}) {
  serverVAD = !!(opts.useServerVAD ?? true);
  safeSend({
    type: 'session.update',
    session: {
      ...(opts.instructions ? { instructions: opts.instructions } : {}),
      voice: opts.voice || 'marin',
      modalities: opts.modalities || ['audio', 'text'],
      turn_detection: serverVAD ? { type: 'server_vad' } : null
    }
  });
}

// --- exports ---

/**
 * Save channel, wire message parsing, send session.update on open.
 * If you don't pass a handler, it will try window.handleServerEvent(evt).
 */
export function wireDataChannel(
  channel: RTCDataChannel,
  onEvent?: (evt: any) => void,
  config?: {
    instructions?: string;
    voice?: string;
    modalities?: Array<'audio' | 'text'>;
    useServerVAD?: boolean;
    onOpen?: () => void;
  }
) {
  try { state.dc?.close(); } catch {}
  state.dc = channel;

  const dc = state.dc!;
  dc.onmessage = (e: MessageEvent) => {
    try {
      const s = typeof e.data === 'string' ? e.data : '';
      if (!s) return;
      const evt = JSON.parse(s);
      if (onEvent) onEvent(evt);
      else {
        const fn = (globalThis as any).handleServerEvent;
        if (typeof fn === 'function') fn(evt);
        else console.debug('DC evt (no handler):', evt.type, evt);
      }
    } catch (err) { console.warn('DC parse error', err, e.data); }
  };

  dc.onopen = () => {
    sendSessionUpdateInternal({
      instructions: config?.instructions,
      voice: config?.voice || 'marin',
      modalities: config?.modalities || ['audio', 'text'],
      useServerVAD: config?.useServerVAD ?? true
    });
    try { config?.onOpen?.(); } catch {}
  };

  dc.onclose = () => {
    // Optionally clear in-flight state here if you track it elsewhere.
  };
}

/** Send a user text item; if server VAD is off, also trigger a response. */
export function sendTextAndRespond(text: string, extra: Record<string, unknown> = {}) {
  const t = (text || '').trim();
  if (!t) return;
  safeSend({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: t }]
    }
  });
  if (!serverVAD) sendResponseCreate(extra);
}

/** Ask the model to speak/reply (audio + text). Guard in caller to avoid duplicate in-flight responses. */
export function sendResponseCreate(extra: Record<string, unknown> = {}) {
  safeSend({
    type: 'response.create',
    response: { modalities: ['audio', 'text'], ...extra }
  });
}