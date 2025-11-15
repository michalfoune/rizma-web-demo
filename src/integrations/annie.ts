/* 
   Minimal, focused wrapper around the CallAnnie Animato SDK.

   Load the SDK in index.html **before** your bundle:
     <script src="https://app.callannie.ai/animato-sdk.js" crossorigin="anonymous"></script>

   Runtime surface used here:
     new window.AnimatoSDK.Animato({ token, animatoId, userId, userName })

   No heuristics, no script injection, no monkey‑patching sealed objects.
*/

/* eslint-disable @typescript-eslint/no-explicit-any */
import { type ChatRole, addMessageWithMetadata } from '../state/memory';
import { PROXY_BASE } from '../config/constants';

let inst: any | null = null;
let selfCamStream: MediaStream | null = null;

/** Toggle the landing UI (avatar card + mode row) without heuristics. */
function setLandingHidden(hidden: boolean) {
  const ids = ['#avatarCard', '#modeRow'];
  for (const sel of ids) {
    const el = document.querySelector<HTMLElement>(sel);
    if (el) el.classList.toggle('hidden', hidden);
  }
}

/** Fit the stage box to the intrinsic size of the remote media to avoid black bars. */
function fitStageToRemote(stageId = 'annieStage') {
  const stage = document.getElementById(stageId) as HTMLElement | null;
  if (!stage) return;
  const media = stage.querySelector('video,canvas,img') as HTMLVideoElement | HTMLCanvasElement | HTMLImageElement | null;
  if (!media) return;

  const apply = () => {
    let w = 0, h = 0;
    if (media instanceof HTMLVideoElement) { w = media.videoWidth; h = media.videoHeight; }
    else if (media instanceof HTMLCanvasElement) { w = media.width; h = media.height; }
    else if (media instanceof HTMLImageElement) { w = media.naturalWidth; h = media.naturalHeight; }
    if (w > 0 && h > 0) stage.style.aspectRatio = `${w}/${h}`;
  };

  if (media instanceof HTMLVideoElement && (!media.videoWidth || !media.videoHeight)) {
    media.addEventListener('loadedmetadata', apply, { once: true });
  } else {
    apply();
  }
}

type Meta = { persona?: string; runId?: string; userName?: string };

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripUserAttribution(text: string, userName?: string) {
  let t = text.trim();
  // Build a targeted regex: "^\s*(<name>|user|you)\s+says:\s*"
  const parts = ["user", "you"]; // generic fallbacks
  if (userName && userName.trim()) parts.unshift(userName.trim());
  const rx = new RegExp(`^\\s*(?:${parts.map(p => escapeRegExp(p)).join('|')})\\s+says:\\s*`, 'i');
  t = t.replace(rx, '');
  // Also catch a fully generic pattern as a last resort
  t = t.replace(/^\s*[A-Za-z]+\s+says:\s*/i, '');
  return t;
}

export type AnnieConnectOpts = {
  token: string;
  animatoId: string;
  userId: string;
  userName?: string;
  root: HTMLElement;
  lang?: string;
  mic?: boolean;
  persona?: string;
  runId?: string;
};

function ctor() {
  const C = (window as any).AnimatoSDK?.Animato;
  if (!C) throw new Error('Animato SDK not loaded. Ensure the script tag is before your bundle.');
  return C;
}

function save(role: ChatRole, content: string, meta?: Meta) {
  if (!content) return;
  addMessageWithMetadata(role, content, { source: 'avatar', persona: meta?.persona, runId: meta?.runId });
  try {
    document.dispatchEvent(
      new CustomEvent('live:message', {
        detail: { role, content },
        bubbles: true,
        composed: true,
      })
    );
    console.log('[annie:message]', { role, content });
  } catch {}
}

function wireTranscripts(i: any, meta?: Meta) {
  const handler = (payload: any) => {
    const d = payload?.data ?? payload;
    if (!d || typeof d !== 'object') return;

    if (d.type === 'on_text' && typeof d.text === 'string') {
      console.log('[annie:on_text raw]', { who: d.who, text: d.text });
      const who = String(d.who || '').toLowerCase() === 'user' ? 'user' : 'assistant';
      let text = d.text.trim();
      if (who === 'user') {
        text = stripUserAttribution(text, meta?.userName);
      }
      if (text) save(who as ChatRole, text, meta);
      return;
    }

    if (d.type === 'function_call') {
      const name = d.name || d.tool || d.function || 'function_call';
      save('assistant', `${String(name)}(…)`, meta);
    }
  };

  if (typeof i.on === 'function') {
    i.on('data-received', handler);
    return () => { try { i.off?.('data-received', handler); } catch {} };
  }

  const desc = Object.getOwnPropertyDescriptor(i, 'onDataReceived')
            || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(i) || {}, 'onDataReceived');
  if (desc && (desc.writable || desc.set)) {
    try { (i as any).onDataReceived = handler; } catch {}
    return () => {};
  }

  // No event surface; nothing to wire.
  return () => {};
}

export async function connectAnnie(opts: AnnieConnectOpts) {
  // Teardown any prior
  try { inst?.disconnect?.(); } catch {}
  inst = null;

  try { document.dispatchEvent(new CustomEvent('live:reset', { bubbles: true, composed: true })); } catch {}

  const Animato = ctor();
  const a = new Animato({
    token: opts.token,
    animatoId: opts.animatoId,
    userId: opts.userId,
    userName: opts.userName ?? 'Michal',
  });

  a.setHTMLRoot(opts.root);
  if (opts.lang) a.setLang(opts.lang);

  await a.connect();
  if (opts.mic) await a.setMicrophoneEnabled?.(true);

  try {
    document.dispatchEvent(
      new CustomEvent('live:meta', {
        detail: { persona: opts.persona, runId: opts.runId, userName: opts.userName ?? 'Michal' },
        bubbles: true,
        composed: true,
      })
    );
  } catch {}

  // Hide landing UI and size stage to remote media
  try { setLandingHidden(true); } catch {}
  try { fitStageToRemote('annieStage'); } catch {}

  // Wire transcripts
  wireTranscripts(a, { persona: opts.persona, runId: opts.runId, userName: opts.userName ?? 'Michal' });

  // One self-cam attach, after user gesture (avoid duplicate streams on reconnect)
  const selfEl = document.getElementById('selfCam') as HTMLVideoElement | null;
  if (selfEl && !selfCamStream) await attachSelfCam(selfEl);

  (window as any).__annie = a; // optional for console debugging
  inst = a;
  return a;
}

export function disconnectAnnie() {
  try { inst?.disconnect?.(); } catch {}
  inst = null;
  stopSelfCam(); // release camera resources

  // Restore landing UI and reset stage sizing
  try { setLandingHidden(false); } catch {}
  const stageEl = document.getElementById('annieStage') as HTMLElement | null;
  if (stageEl) stageEl.style.removeProperty('aspect-ratio');

  try { (window as any).__annie = null; } catch {}

  try { document.dispatchEvent(new CustomEvent('live:end', { bubbles: true, composed: true })); } catch {}
}

export function isAnnieConnected() {
  return !!inst;
}

export function setAnnieMic(enabled: boolean) {
  try { inst?.setMicrophoneEnabled?.(enabled); } catch {}
}

export function getAnnieInstance() {
  return inst;
}

export function sendAnnieUserMessage(text: string): void {
  try { inst?.sendMessage?.(text); } catch {}
  save('user', text);
}

/** Best-effort vendor prompt that does NOT write to memory */
export async function sendAnniePrompt(text: string): Promise<boolean> {
  const a = inst;
  if (!a || !text) return false;

  if (typeof a.setSystemPrompt === 'function') { await a.setSystemPrompt(text); return true; }
  if (typeof a.setBehavior === 'function')     { await a.setBehavior(text);     return true; }
  if (typeof a.setPrompt === 'function')       { await a.setPrompt(text);       return true; }

  // No clean system channel → do nothing (avoid polluting dialogue)
  return false;
}

/** Kickoff assistant speech WITHOUT writing to memory/history */
export async function sendAnnieAssistantMessage(text: string): Promise<boolean> {
  const a = inst;
  if (!a || !text) return false;

  // Only act if SDK provides an explicit assistant-kickoff method in the future.
  // (Do NOT fallback to sendMessage() — that injects a user turn and will be stored.)
  if (typeof a.kickoffAssistant === 'function') { await a.kickoffAssistant(text); return true; }

  return false; // safe no-op
}

export async function attachSelfCam(el: HTMLVideoElement) {
  try {
    if (selfCamStream) return; // already attached

    // Prepare element for autoplay on iOS/Safari
    el.muted = true;
    el.playsInline = true;
    el.setAttribute('autoplay', '');

    selfCamStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });

    el.srcObject = selfCamStream;

    try { await el.play(); } catch {}
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

/** Ensure camera stops on page unload/refresh. */
if (typeof window !== 'undefined' && !(window as any).__annieSelfCamHook) {
  (window as any).__annieSelfCamHook = true;
  window.addEventListener('beforeunload', () => {
    try { stopSelfCam(); } catch {}
  });
}

/** Optional: simple wait helper if other code relies on it. */
export function waitForAnnieConnected(_target?: any, timeoutMs = 800): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

export async function getAnnieToken(userId: string, _animatoId?: string): Promise<string> {
  const base = String(PROXY_BASE || '').replace(/\/+$/, '');
  const url = `${base}/annie-token`;
  const sessionId = `web_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, sessionId })
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`annie-token ${res.status}. URL=${url}. Body=${text.slice(0, 200)}`);
  }

  const j = await res.json().catch(() => ({} as any));
  const token = j?.token || j?.accessToken || j?.data?.token;
  if (typeof token === 'string' && token.length > 0) return token;
  throw new Error(`annie-token missing in response. Keys=${Object.keys(j || {}).join(',')}`);
}

export function ensureLivePane(): HTMLElement | null {
  const stage = document.getElementById('annieStage')
             || document.querySelector('.annie-stage') as HTMLElement | null;
  if (!stage) return null;

  let pane = document.getElementById('liveTranscript') as HTMLElement | null;
  if (!pane) {
    pane = document.createElement('aside');
    pane.id = 'liveTranscript';
    stage.appendChild(pane);
  }
  return pane;
}

export function destroyLivePane(): void {
  const pane = document.getElementById('liveTranscript');
  if (pane && pane.parentElement) pane.parentElement.removeChild(pane);
}

// Tiny HTML escaper reused below
function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function renderLiveTranscript(msgs: Array<{role: string, content?: string}>, limit = 60): void {
  const pane = document.getElementById('liveTranscript');
  if (!pane) return;

  const recent = msgs.slice(-limit);
  let last: 'user'|'assistant'|null = null;
  let html = '';

  for (const m of recent) {
    const role: 'user'|'assistant' =
      (m.role === 'user' ? 'user' : 'assistant');

    const showLabel = role !== last;
    last = role;

    const label = showLabel
      ? `<div class="label">${role === 'user' ? 'User' : 'Assistant'}</div>`
      : '';

    const text = htmlEscape(m.content || '').replace(/\n/g, '<br>');

    html += `
      <div style="display:flex;${role === 'user' ? 'justify-content:flex-end;' : 'justify-content:flex-start;'}">
        <div class="bubble ${role}">
          ${label}
          <div>${text}</div>
        </div>
      </div>`;
  }

  pane.innerHTML = html;
  pane.scrollTop = pane.scrollHeight; // auto-scroll to latest
}