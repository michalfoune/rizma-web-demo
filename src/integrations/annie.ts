/* 
   Lightweight wrapper around the CallAnnie avatar UMD API.

   Required: place vendor bundle at /public/api.umd.js
   (The bundle must expose window.CallAnnieAPI_V0_R1)
*/

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
    interface Window {
        CallAnnieAPI_V0_R1?: any;
    }
}

let avatar: any | null = null;

export type AnnieConnectOpts = {
    token: string;
    userId: string;
    animatoId: string;
    username?: string;
    lang?: string;
    mic?: boolean;
    root: HTMLElement;
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

/** Connect and render the avatar into the provided root element. */
export async function connectAnnie(opts: AnnieConnectOpts): Promise<any> {
  const Ctor = await loadAnnie();

  // Close any previous instance
  try { avatar?.disconnect?.(); } catch { /* ignore */ }

  // ctor: (token, animatoId, userId, username)
  avatar = new Ctor(opts.token, opts.animatoId, opts.userId, opts.username ?? 'rizma');
  avatar.setHTMLRoot(opts.root);
  avatar.setLang(opts.lang ?? 'en');
  avatar.connect();

  // Wait until the SDK signals the room is connected before toggling mic/cam.
  await waitForAnnieConnected(avatar, 1500);

  // One self-cam attach, after user gesture
  const selfEl = document.getElementById('selfCam') as HTMLVideoElement | null;
  if (selfEl) await attachSelfCam(selfEl);

  return avatar;
}

/** Disconnect and clear the current avatar instance. */
export function disconnectAnnie(): void {
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
}

export function sendAnnieAssistantMessage(text: string): void {
    avatar?.sendAssistantMessage?.(text);
}

export function sendAnniePrompt(text: string): void {
    avatar?.sendPrompt?.(text);
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
