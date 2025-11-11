/* 
   Lightweight wrapper around the CallAnnie avatar UMD API.

   Required: place vendor bundle at /public/api.umd.js
   (The bundle must expose window.CallAnnieAPI_V0_R1)
*/

/* eslint-disable @typescript-eslint/no-explicit-any */
import { addMessageWithMetadata, toChatMessageFromAnnie, type ChatRole } from '../state/memory';

// Debug toggle can be flipped at runtime: window.__RIZMA_DEBUG_ANNIE__=true or localStorage.RIZMA_DEBUG_ANNIE='1'
const isDebug = () => Boolean((window as any).__RIZMA_DEBUG_ANNIE__ || localStorage.getItem('RIZMA_DEBUG_ANNIE') === '1');

// Allowed message kinds we push into memory
type AnnieKind = 'user' | 'assistant' | 'system' | 'transcript';
declare global {
  interface Window {
    CallAnnieAPI_V0_R1?: any;
  }
}

let avatar: any | null = null;
let currentMeta: { runId: string; persona?: string } | null = null;
let unsubs: Array<() => void> = [];

export type AnnieConnectOpts = {
  token: string;
  userId: string;
  animatoId: string;
  username?: string;
  lang?: string;
  mic?: boolean;
  root: HTMLElement;
  runId?: string;
  persona?: string;
  trackHistory?: boolean; // default true
};

/** Lazy-load the UMD bundle and return the constructor. */
let loadPromise: Promise<any> | null = null;

export async function loadAnnie() {
  const w = window as any;
  if (w.CallAnnieAPI_V0_R1) return w.CallAnnieAPI_V0_R1;

  if (!loadPromise) {
    loadPromise = new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/api.umd.js';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('Failed to load /api.umd.js'));
      document.head.appendChild(s);
    }).then(() => (window as any).CallAnnieAPI_V0_R1);
  }
  return loadPromise;
}

// --- Annie event/memory helpers ---
function subscribe(target: any, name: string, handler: (...args: any[]) => void): () => void {
  if (!target) return () => { };
  if (typeof target.on === 'function' && typeof target.off === 'function') {
    target.on(name, handler);
    return () => { try { target.off(name, handler); } catch { /* ignore */ } };
  }
  if (typeof target.addEventListener === 'function' && typeof target.removeEventListener === 'function') {
    target.addEventListener(name, handler as any);
    return () => { try { target.removeEventListener(name, handler as any); } catch { /* ignore */ } };
  }
  return () => { };
}

function extractText(payload: any): string {
  // Skip obvious non-finals
  if (payload && (payload.final === false || payload.isFinal === false)) return '';

  if (payload == null) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload?.text === 'string') return payload.text;
  if (typeof payload?.message === 'string') return payload.message;
  if (typeof payload?.content === 'string') return payload.content;

  // OpenAI-like chat responses
  if (payload?.choices && payload.choices[0]?.message?.content) return payload.choices[0].message.content;
  if (payload?.choices && typeof payload.choices[0]?.text === 'string') return payload.choices[0].text;
  if (Array.isArray(payload?.content)) {
    // e.g. [{type:'output_text', text:'...'}]
    const piece = payload.content.find((c: any) => typeof c?.text === 'string');
    if (piece?.text) return piece.text;
  }

  // Arrays or message lists
  if (Array.isArray(payload?.messages) && payload.messages.length) {
    const last = payload.messages[payload.messages.length - 1];
    return extractText(last);
  }

  // Avoid storing token deltas
  if (typeof payload?.delta === 'string') return '';

  try { return JSON.stringify(payload); } catch { return String(payload); }
}

function pushAnnie(kind: AnnieKind, payload: any, meta?: { runId: string; persona?: string }) {
  try {
    if (isDebug()) console.debug('[annie:push]', kind, payload);

    // Normalize vendor data-received envelopes
    let effKind: AnnieKind = kind;
    let overrideText: string | undefined;
    try {
      const d: any = (payload && (payload.data ?? payload.payload)) || null;
      if (d && typeof d === 'object') {
        // Drop non-final streaming chunks if signaled
        if (typeof d.final === 'boolean' && d.final === false) return;

        // Primary text messages
        if (d.type === 'on_text') {
          const who = String(d.who || '').toLowerCase();
          effKind = (who === 'user' || who === 'client') ? 'user' : 'assistant';
          if (typeof d.text === 'string') overrideText = d.text;
        }

        // Tool/function calls (do not spam memory with args unless desired)
        if (d.type === 'function_call') {
          effKind = 'assistant';
          const callName = d.name || d.tool || d.function || 'function_call';
          // Keep it compact; arguments may be huge
          overrideText = `🔧 ${String(callName)}(…)`;
        }
      }
    } catch { /* ignore */ }

    const role: ChatRole = (effKind === 'user' || effKind === 'transcript') ? 'user' : 'assistant';

    // Try the stricter, structured converter first
    const m = toChatMessageFromAnnie(role, payload, effKind ? meta : currentMeta || { runId: 'run_' + Date.now() });
    if (m && m.content) {
      addMessageWithMetadata(
        m.role as any,
        m.content,
        { source: 'avatar', persona: meta?.persona || currentMeta?.persona, runId: meta?.runId || currentMeta?.runId }
      );
      return;
    }

    // Fallback: best-effort text extraction from vendor payloads
    const text = overrideText ?? ((payload?.data && typeof payload.data.text === 'string') ? payload.data.text : extractText(payload));
    if (text && text.trim()) {
      addMessageWithMetadata(
        role as any,
        text,
        { source: 'avatar', persona: meta?.persona || currentMeta?.persona, runId: meta?.runId || currentMeta?.runId }
      );
    }
  } catch (e) {
    console.debug('history push failed:', e, kind, payload);
  }
}

// --- Deep wiring helper and seen-set ---
const __wiredSeen = new WeakSet<object>();
function wireAnnieDeep(target: any, meta: { runId: string; persona?: string }) {
  if (!target || typeof target !== 'object') return;
  if (__wiredSeen.has(target)) return;
  __wiredSeen.add(target);
  try { wireAnnieHistory(target, meta); } catch { }
  // Common nested containers that actually emit the data events
  const kids = [
    target.room, target._room, target.client, target.lk?.room, target.livekit?.room,
    target.connection, target.signalClient, target.signaling, target.transport
  ].filter(Boolean);
  for (const k of kids) wireAnnieDeep(k, meta);
}

function wireAnnieHistory(target: any, meta: { runId: string; persona?: string }) {
  // Clean any prior subscriptions
  try { unsubs.forEach(fn => fn()); } catch { }
  unsubs = [];

  const add = (evt: string, kind: AnnieKind) => {
    const off = subscribe(target, evt, (payload: any) => pushAnnie(kind, payload, meta));
    unsubs.push(off);
    if (isDebug()) console.debug('[annie:subscribed]', evt, 'on', (target && (target.constructor?.name || typeof target)));
  };

  // Assistant / bot messages (cover both streaming containers and finals)
  [
    'assistant_message', 'assistant', 'reply', 'bot_message', 'message', 'agent_message',
    'assistant.final', 'assistant_final', 'reply_final', 'finalMessage', 'final_message', 'llm_message'
  ].forEach(e => add(e, 'assistant'));

  // Final user transcripts
  [
    'final_transcript', 'transcript_final', 'stt_final', 'transcription_final', 'user_transcript', 'userTranscript',
    'speech.final', 'transcript.final', 'asr.final', 'user.final', 'asrFinal'
  ].forEach(e => add(e, 'transcript'));

  // Vendor-specific stream for role-play text
  add('data-received', 'assistant'); // role will be corrected inside pushAnnie via payload.data.who
  add('dataReceived', 'assistant');
  add('trackMessageReceived', 'assistant');

  // Generic envelope some SDKs use
  const offGeneric = subscribe(target, 'event', (evt: any) => {
    const t = evt?.type || evt?.name;
    const payload = evt?.payload ?? evt;
    if (isDebug() && (payload?.data?.type)) {
      console.debug('[annie:data-type]', payload.data.type, payload.data);
    }
    if (!t) return;
    if (/(assistant|agent|reply|bot)/i.test(t)) pushAnnie('assistant', payload, meta);
    else if (/(user|client)/i.test(t)) pushAnnie('user', payload, meta);
    else if (/(final|transcript|asr)/i.test(t)) pushAnnie('transcript', payload, meta);
  });
  unsubs.push(offGeneric);

  // Capture iframe -> window postMessage traffic (some SDKs surface events this way)
  const offWinMsg = subscribe(window, 'message', (evt: any) => {
    const data = evt?.data;
    if (!data) return;
    const t = data?.type || data?.event || data?.name;
    const payload = data?.payload ?? data?.data ?? data;
    if (isDebug()) console.debug('[annie:postMessage]', t, payload);
    if (isDebug() && (payload?.data?.type || data?.data?.type)) {
      console.debug('[annie:data-type]', payload?.data?.type || data?.data?.type, payload?.data || data?.data);
    }

    // Role detection heuristics
    if (/(assistant|agent|reply|bot)/i.test(String(t)) || /^(assistant|agent)$/i.test(String(data?.role))) {
      pushAnnie('assistant', payload, meta);
      return;
    }
    if (/(user|client)/i.test(String(t)) || /^user$/i.test(String(data?.role))) {
      pushAnnie('user', payload, meta);
      return;
    }
    if (/(final|transcript|asr)/i.test(String(t)) || data?.final === true || data?.isFinal === true || data?.asrFinal === true) {
      pushAnnie('transcript', payload, meta);
      return;
    }

    // Fallback: if there is clear text, assume assistant (most vendors post assistant text)
    const text = extractText(payload);
    if (text) pushAnnie('assistant', payload, meta);
  });
  unsubs.push(offWinMsg);

  // Last resort: intercept EventEmitter.emit to observe all events without vendor API knowledge
  if (typeof target?.emit === 'function') {
    const origEmit = target.emit.bind(target);
    (target as any).emit = (name: string, payload: any) => {
      try {
        if (/(assistant|agent|reply|bot)/i.test(name)) pushAnnie('assistant', payload, meta);
        else if (/(user|client)/i.test(name)) pushAnnie('user', payload, meta);
        else if (/(final|transcript|asr)/i.test(name)) pushAnnie('transcript', payload, meta);
      } catch { /* ignore */ }
      return origEmit(name, payload);
    };
    unsubs.push(() => { try { (target as any).emit = origEmit; } catch { /* ignore */ } });
  }
}

function wrapOnPropertyHandlers<T extends object>(obj: T, meta: { runId: string; persona?: string }): T {
  const guessKind = (name: string): AnnieKind => {
    if (/assistant|agent|bot|reply/i.test(name)) return 'assistant';
    if (/user|client/i.test(name)) return 'user';
    if (/final|transcript|asr/i.test(name)) return 'transcript';
    return 'assistant';
  };

  const proxy = new Proxy(obj as any, {
    set(target, prop: any, value: any) {
      const name = String(prop);
      if (/^on[A-Z]/.test(name) && typeof value === 'function') {
        const kind = guessKind(name);
        const wrapped = function (this: any, ...args: any[]) {
          try { pushAnnie(kind, args[0] ?? args, meta); } catch { /* ignore */ }
          return value.apply(this, args);
        };
        if (isDebug()) console.debug('[annie:on* wrapped]', name, kind);
        target[name] = wrapped;
        return true;
      }
      target[name] = value;
      return true;
    }
  });

  // Also wrap already-present `on*` function-typed properties (callbacks assigned earlier)
  Object.keys(obj as any).forEach((k) => {
    const v: any = (obj as any)[k];
    if (/^on[A-Z]/.test(k) && typeof v === 'function') {
      const kind = guessKind(k);
      (obj as any)[k] = function (this: any, ...args: any[]) {
        try { pushAnnie(kind, args[0] ?? args, meta); } catch { /* ignore */ }
        return v.apply(this, args);
      };
      if (isDebug()) console.debug('[annie:on* patched]', k, kind);
    }
  });

  return proxy as T;
}

/** Connect and render the avatar into the provided root element. */
export async function connectAnnie(opts: AnnieConnectOpts): Promise<any> {
  const Ctor = await loadAnnie();

  // Close any previous instance
  try { avatar?.disconnect?.(); } catch { /* ignore */ }

  // Set up meta for this run
  const meta = {
    runId: opts.runId || ('run_' + Date.now()),
    persona: opts.persona || opts.username
  };
  currentMeta = meta;

  // ctor: (token, animatoId, userId, username)
  avatar = new Ctor(opts.token, opts.animatoId, opts.userId, opts.username ?? 'rizma');
  (window as any).__annie = avatar;
  if (isDebug()) {
    try { console.debug('[annie:keys]', Object.keys(avatar || {})); } catch { }
  }
  // Wrap on* handler properties so we can observe callbacks-based SDKs
  avatar = wrapOnPropertyHandlers(avatar, meta);

  // Direct vendor-recommended hook: animato.on('data-received', ...)
  const handleDataReceived = (dap: any) => {
    if (isDebug()) console.debug('[annie:direct:data-received]', dap?.data?.type, dap);
    // Normalize and persist via our common path
    pushAnnie('assistant', dap, meta);
  };
  if (typeof (avatar as any)?.on === 'function') {
    try {
      (avatar as any).on('data-received', handleDataReceived);
      unsubs.push(() => { try { (avatar as any).off?.('data-received', handleDataReceived); } catch { } });
    } catch { }
  }

  const origUser = avatar?.sendUserMessage?.bind(avatar);
  avatar.sendUserMessage = (text: string) => {
    pushAnnie('user', { text }, meta);
    return origUser ? origUser(text) : undefined;
  };

  const origAsst = avatar?.sendAssistantMessage?.bind(avatar);
  avatar.sendAssistantMessage = (text: string) => {
    pushAnnie('assistant', { text }, meta);
    return origAsst ? origAsst(text) : undefined;
  };

  const origPrompt = avatar?.sendPrompt?.bind(avatar);
  avatar.sendPrompt = (text: string) => {
    pushAnnie('system', { text }, meta);
    return origPrompt ? origPrompt(text) : undefined;
  };
  avatar.setHTMLRoot(opts.root);
  avatar.setLang(opts.lang ?? 'en');
  avatar.connect();

  // Wait until the SDK signals the room is connected before toggling mic/cam.
  await waitForAnnieConnected(avatar, 1500);
  if (typeof opts.mic === 'boolean') setAnnieMic(opts.mic);

  if (opts.trackHistory !== false) {
    // Wire root and any nested LiveKit/connection objects that emit data events
    wireAnnieDeep(avatar, meta);
    // Re-scan shortly after connect to catch late-created rooms
    setTimeout(() => { try { wireAnnieDeep(avatar, meta); } catch { } }, 500);
    setTimeout(() => { try { wireAnnieDeep(avatar, meta); } catch { } }, 1500);
  }

  // One self-cam attach, after user gesture
  const selfEl = document.getElementById('selfCam') as HTMLVideoElement | null;
  if (selfEl) await attachSelfCam(selfEl);

  return avatar;
}

/** Disconnect and clear the current avatar instance. */
export function disconnectAnnie(): void {
  try { unsubs.forEach(fn => fn()); } catch { }
  unsubs = [];
  currentMeta = null;
  try { avatar?.disconnect?.(); } catch { /* ignore */ }
  try { (window as any).__annie = null; } catch { }
  avatar = null;
  stopSelfCam();
}

/** True if an avatar instance is currently allocated. */
export function isAnnieConnected(): boolean {
  return !!avatar;
}

/** Proxy helpers for messaging/debug. */
export function sendAnnieUserMessage(text: string): void {
  avatar?.sendUserMessage?.(text);
  pushAnnie('user', { text }, currentMeta || undefined);
}

export function sendAnnieAssistantMessage(text: string): void {
  avatar?.sendAssistantMessage?.(text);
  pushAnnie('assistant', { text }, currentMeta || undefined);
}

export function sendAnniePrompt(text: string): void {
  avatar?.sendPrompt?.(text);
  pushAnnie('system', { text }, currentMeta || undefined);
}

/** Access the raw instance if you need advanced controls. */
export function getAnnieInstance(): any | null {
  return avatar;
}

let lastMic: boolean | null = null;
let selfCamStream: MediaStream | null = null;

export function setAnnieMic(enabled: boolean): void {
  // Avoid sending duplicate mic toggles; some backends treat this as a metadata update.
  if (lastMic === enabled) return;
  lastMic = enabled;
  try {
    if (avatar?.setMicrophoneEnabled) {
      avatar.setMicrophoneEnabled(enabled);
    }
  } catch (e) {
    console.debug('mic toggle ignored:', e);
  }
}

export async function attachSelfCam(el: HTMLVideoElement) {
  try {
    selfCamStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720 },
      audio: false
    });
    el.srcObject = selfCamStream;
    el.muted = true;
    el.playsInline = true;
    try { await el.play(); } catch { }
  } catch (err) {
    console.warn('Self camera failed:', err);
  }
}

export function stopSelfCam() {
  if (selfCamStream) {
    selfCamStream.getTracks().forEach(t => t.stop());
    selfCamStream = null;
  }
}

/** Best-effort wait until the vendor SDK reports connection. */
function waitForAnnieConnected(target: any, timeoutMs = 1500): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; off(); resolve(); } };

    // Try multiple event names the SDK might use.
    const names = ['connected', 'ready', 'room_joined', 'joined', 'open'];
    const fns: Array<() => void> = [];

    const off = () => fns.forEach((offFn) => offFn());

    names.forEach((name) => {
      const fn = () => finish();
      // Support both EventEmitter-style `on/off` and DOM-style `add/removeEventListener`.
      if (typeof target?.on === 'function' && typeof target?.off === 'function') {
        target.on(name, fn);
        fns.push(() => { try { target.off(name, fn); } catch { /* ignore */ } });
      } else if (typeof target?.addEventListener === 'function' && typeof target?.removeEventListener === 'function') {
        target.addEventListener(name, fn);
        fns.push(() => { try { target.removeEventListener(name, fn); } catch { /* ignore */ } });
      }
    });

    // Fallback: resolve after a short delay if nothing fires.
    setTimeout(finish, timeoutMs);
  });
}
