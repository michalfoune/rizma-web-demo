/* 
   Lightweight wrapper around the CallAnnie avatar UMD API.

   Required: place vendor bundle at /public/api.umd.js
   (The bundle must expose window.CallAnnieAPI_V0_R1)
*/

/* eslint-disable @typescript-eslint/no-explicit-any */
import { addMessageWithMetadata, toChatMessageFromAnnie, type ChatRole } from '../state/memory';
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

function pushAnnie(kind: AnnieKind, payload: any, meta?: { runId: string; persona?: string }) {
  try {
    const effMeta = meta || currentMeta || { runId: 'run_' + Date.now() };
    const role: ChatRole = kind === 'user' ? 'user' : 'assistant'; // map 'assistant'|'system'|'transcript' -> 'assistant'
    const m = toChatMessageFromAnnie(role, payload, effMeta);
    if (m) {
      // memory.addMessageWithMeta(role, content, { source, persona, runId })
      addMessageWithMetadata(
        m.role as any,
        m.content ?? (typeof payload === 'string' ? payload : JSON.stringify(payload)),
        { source: 'avatar', persona: effMeta.persona, runId: effMeta.runId }
      );
    }
  } catch (e) {
    console.debug('history push failed:', e, kind, payload);
  }
}

function wireAnnieHistory(target: any, meta: { runId: string; persona?: string }) {
  // Clean any prior subscriptions
  try { unsubs.forEach(fn => fn()); } catch { }
  unsubs = [];

  const add = (evt: string, kind: AnnieKind) => {
    const off = subscribe(target, evt, (payload: any) => pushAnnie(kind, payload, meta));
    unsubs.push(off);
  };

  // Common vendor event names (best-effort)
  ['assistant_message', 'assistant', 'reply', 'bot_message', 'message'].forEach(e => add(e, 'assistant'));
  // Prefer "final" transcripts only
  ['final_transcript', 'transcript_final', 'stt_final', 'transcription_final'].forEach(e => add(e, 'transcript'));

  // Generic "event" envelope some SDKs use
  const offGeneric = subscribe(target, 'event', (evt: any) => {
    const t = evt?.type || evt?.name;
    const payload = evt?.payload ?? evt;
    if (!t) return;
    if (/(assistant|reply|bot)/i.test(t)) pushAnnie('assistant', payload, meta);
    else if (/user/i.test(t)) pushAnnie('user', payload, meta);
    else if (/(final|transcript)/i.test(t)) pushAnnie('transcript', payload, meta);
  });
  unsubs.push(offGeneric);
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
    wireAnnieHistory(avatar, meta);
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
