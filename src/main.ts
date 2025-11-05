import { state } from './state/appState';
import { memory, saveMemory, loadMemory, clearMemory, setDefaultRunId, getMessages } from './state/memory';
import type { ChatMessage as MemChatMessage, ChatRole } from './state/memory';
import { createPeerConnection, waitForIce } from './rtc/connection';
import { getEl, setText, setVisible, onDomReady } from './ui/dom';
import { bindControls, setBtnRecordingUI, setStatus } from './ui/controls';
import { showSessionUI } from './ui/dom';
import { addMessage, renderHistory, clearChat } from './ui/chatView';
import { wireDataChannel, sendTextAndRespond, sendResponseCreate } from './rtc/signaling';
import { attachRemoteAudio } from './rtc/audio';
import { log, setLevel, createLogger } from './utils/logger';
import { firstAudioTrack, isPCIceConnected } from './utils/guards';
import { connectAnnie, disconnectAnnie, sendAnnieUserMessage, setAnnieMic, sendAnniePrompt, sendAnnieAssistantMessage } from './integrations/annie';
import { Animato_UserID, Animato_ID, Animato_Test_Token } from './config/constants';
import { httpLLM, httpTTS } from './api/openaiHttp';

// Logger scopes & defaults
if ((import.meta as any)?.env?.MODE === 'development') setLevel('debug');
const uiLog = createLogger('ui');
const rtcLog = createLogger('rtc');
const pcLog = rtcLog.child('pc');
const dcLog = rtcLog.child('dc');
const httpLog = rtcLog.child('http');
const evtLog = rtcLog.child('evt');

// --- Global audio/RTC kill‑switch instrumentation ---------------------------
const KILL = {
  pcs: new Set<RTCPeerConnection>(),
  audioCtxs: new Set<any>(),
  mediaEls: new Set<HTMLMediaElement>(),
  streams: new Set<MediaStream>(),
};

function initKillSwitch(): void {
  const g: any = globalThis as any;
  if (g.__killSwitchInstalled) return;
  g.__killSwitchInstalled = true;

  // Track RTCPeerConnections (vendor SDK may open its own)
  const OrigPC = g.RTCPeerConnection;
  if (typeof OrigPC === 'function') {
    const WrappedPC = function (...args: any[]) {
      const pc = new OrigPC(...args);
      try {
        KILL.pcs.add(pc);
        pc.addEventListener('connectionstatechange', () => {
          if (pc.connectionState === 'closed' || pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            KILL.pcs.delete(pc);
          }
        });
      } catch { }
      return pc;
    } as any;
    WrappedPC.prototype = OrigPC.prototype;
    g.RTCPeerConnection = WrappedPC;
  }

  // Track AudioContexts (including Safari/WebKit)
  const wrapAC = (name: string) => {
    const C = g[name];
    if (typeof C === 'function') {
      const Wrapped = function (...args: any[]) {
        const ctx = new C(...args);
        try { KILL.audioCtxs.add(ctx); } catch { }
        return ctx;
      } as any;
      Wrapped.prototype = C.prototype;
      g[name] = Wrapped;
    }
  };
  wrapAC('AudioContext');
  wrapAC('webkitAudioContext');

  // Track media elements as they start playing; also capture assigned MediaStreams
  const HME: any = g.HTMLMediaElement?.prototype;
  if (HME && typeof HME.play === 'function') {
    const origPlay = HME.play;
    HME.play = function (...a: any[]) {
      try { KILL.mediaEls.add(this as HTMLMediaElement); } catch { }
      return origPlay.apply(this, a);
    };
    const desc = Object.getOwnPropertyDescriptor(HME, 'srcObject') ||
      Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
    if (desc && desc.set) {
      const origSet = desc.set;
      Object.defineProperty(HME, 'srcObject', {
        set(v: any) {
          try { if (v && v instanceof MediaStream) KILL.streams.add(v); } catch { }
          return origSet!.call(this, v);
        },
        get: desc.get
      });
    }
  }

  // Track getUserMedia streams
  const md = g.navigator?.mediaDevices;
  if (md && typeof md.getUserMedia === 'function') {
    const origGUM = md.getUserMedia.bind(md);
    md.getUserMedia = async (constraints: any) => {
      const s = await origGUM(constraints);
      try { KILL.streams.add(s); } catch { }
      return s;
    };
  }
}

async function hardStopAllTrackedMedia(): Promise<void> {
  // Pause & detach any tracked media elements
  for (const el of Array.from(KILL.mediaEls)) {
    try { el.muted = true; } catch {}
    try { el.pause?.(); } catch {}
    try {
      const ms = (el as any).srcObject as MediaStream | null;
      if (ms) {
        try { ms.getTracks().forEach(t => { try { t.stop(); } catch {} }); } catch {}
      }
    } catch {}
    try { (el as any).srcObject = null; } catch {}
    try { el.removeAttribute('src'); } catch {}
    try { el.load?.(); } catch {}
  }
  KILL.mediaEls.clear();

  // Stop all captured MediaStreams
  for (const s of Array.from(KILL.streams)) {
    try { s.getTracks?.().forEach(t => { try { t.stop(); } catch {} }); } catch {}
  }
  KILL.streams.clear();

  // Close/suspend all AudioContexts safely
  for (const ctx of Array.from(KILL.audioCtxs) as any[]) {
    try {
      // Prefer close(); only suspend if close() is not available.
      if (typeof ctx.close === 'function') {
        if (ctx.state !== 'closed') {
          await Promise.resolve(ctx.close()).catch(() => {});
        }
      } else if (typeof ctx.suspend === 'function') {
        if (ctx.state === 'running') {
          await Promise.resolve(ctx.suspend()).catch(() => {});
        }
      }
    } catch {}
  }
  KILL.audioCtxs.clear();

  // Close all captured RTCPeerConnections
  for (const pc of Array.from(KILL.pcs)) {
    try { pc.getSenders?.().forEach((s: any) => { try { s.track?.stop?.(); } catch {} }); } catch {}
    try { if (pc.connectionState !== 'closed') pc.close?.(); } catch {}
  }
  KILL.pcs.clear();
}

// Install the kill‑switch ASAP (before any vendor SDK creates contexts/PCs)
initKillSwitch();
// ---------------------------------------------------------------------------

// OpenAI key stays in Cloudflare Worker secret; browser calls proxy
const API_BASE = "https://rizma-proxy.rizma.workers.dev/openai";

// --- Annie (Animato) token proxy base & helper (do not touch OpenAI endpoints)
const PROXY_BASE = ((import.meta as any)?.env?.VITE_PROXY_BASE as string) || 'https://rizma-proxy.rizma.workers.dev';

async function getAnnieToken(userId: string, animatoId: string): Promise<string> {
  void animatoId;
  // Always hit the Cloudflare Worker; never fall back to a relative path
  const base = String(PROXY_BASE || '').replace(/\/+$/, '');
  const url = `${base}/annie-token`;

  const sessionId = `web_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, sessionId })
    });
    uiLog.info('Annie token POST %s → %d', url, res.status);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Annie token endpoint returned ${res.status}. URL=${url}. Body=${text.slice(0, 200)}`);
    }
    const j = await res.json().catch(() => ({} as any));
    const token = j?.token || j?.accessToken || j?.data?.token;
    if (typeof token === 'string' && token.length > 0) return token;
    throw new Error(`Annie token endpoint did not return a token field. URL=${url}. BodyKeys=${Object.keys(j || {}).join(',')}`);
  } catch (e) {
    uiLog.error('Annie token fetch failed: %o', e);
    throw e;
  }
}

let remoteAudioCleanup: (() => void) | null = null;

const btn = getEl('micFab') as HTMLButtonElement | null;
const statusEl = getEl('status');
const chatEl = getEl('chat');
const micFab = getEl('micFab');
const panelEl = getEl('panel');
const composerEl = getEl('composer');
const endBtn = getEl('endSession');

// Realtime (WebRTC) constants
const REALTIME_MODEL = "gpt-realtime"; // per OpenAI Realtime GA; see docs
const SESSION_URL = "https://rizma-proxy.rizma.workers.dev/session"; // absolute Worker endpoint (POST is supported here)
const SERVER_VAD = true; // matches session.update turn_detection

// Buffers for streaming transcripts
let assistantBuf = "";
// --- Lightweight post-session stats ---
let statsStartIndex = 0;
let currentRunId: string | undefined;


interface EvalStats {
  score: number; pass: boolean;
  strengths: string[]; improvements: string[];
  fillerPer100: number; toneHint: string; paceHint: string;
  transcript: string;
}

function sliceSinceStart(msgs: MemChatMessage[], start: number): MemChatMessage[] {
  if (!Array.isArray(msgs)) return [];
  const i = Math.max(0, Math.min(start, msgs.length));
  return msgs.slice(i);
}

function computeEvalStats(msgs: MemChatMessage[]): EvalStats {
  const userTurns = msgs.filter(m => m?.role?.toLowerCase() === 'user');
  const text = userTurns.map(m => m.content || '').join(' ');
  const words = (text.match(/\b\w+\b/g) || []).length;
  const fillers = (text.match(/\b(um|uh|erm|like|you know|sort of|kinda|basically)\b/gi) || []).length;
  const fillerPer100 = words ? (fillers / words) * 100 : 0;

  const questions = (text.match(/\?/g) || []).length;
  const exclaims = (text.match(/!/g) || []).length;

  const strengths: string[] = [];
  const improvements: string[] = [];
  if (questions >= Math.max(1, Math.round(userTurns.length * 0.3))) strengths.push('Asked engaging questions');
  if (fillerPer100 < 3) strengths.push('Clear delivery with minimal fillers; brief pauses signaled preparation and credibility.');
  if (exclaims <= 2) strengths.push('Controlled, steady tone and pace; authoritative without rush, naturally confident.');
  if (fillerPer100 >= 3) improvements.push('Reduce filler words');
  if (questions < 1) improvements.push('Ask one open, team-centric question initially to shift from monologue to dialogue.');

  const toneHint = exclaims > 3 ? 'Excited/strong' : (exclaims === 0 ? 'Calm/neutral' : 'Balanced');
  const paceHint = words > 0 && userTurns.length > 0 && (words / userTurns.length) > 40 ? 'Dense—slow down' : 'Comfortable';

  let score = 80;
  score -= Math.min(15, Math.round(fillerPer100));
  score += Math.min(10, questions * 2);
  score = Math.max(40, Math.min(100, score));

  return {
    score, pass: score >= 70,
    strengths: strengths.length ? strengths : ['Kept the conversation going'],
    improvements: improvements.length ? improvements : ['Provide one concrete example'],
    fillerPer100: Math.round(fillerPer100 * 10) / 10,
    toneHint, paceHint,
    transcript: text.trim(),
  };
}

function showStatsPage(stats: EvalStats, title: string) {
  const page = document.getElementById('statsPage');
  if (!page) return;

  const set = (id: string, v: string) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('statsTitle', title || 'Role-Play Results');
  set('statsScore', String(stats.score));
  set('statsPass', stats.pass ? 'Pass' : 'Needs work');
  set('statsFiller', `${stats.fillerPer100.toFixed(1)} / 100 words`);
  set('statsTone', stats.toneHint);
  set('statsPace', stats.paceHint);

  const sUL = document.getElementById('statsStrengths');
  const iUL = document.getElementById('statsImprovements');
  if (sUL) sUL.innerHTML = stats.strengths.map(s => `<li>${s}</li>`).join('');
  if (iUL) iUL.innerHTML = stats.improvements.map(s => `<li>${s}</li>`).join('');

  const tr = document.getElementById('statsTranscript') as HTMLElement | null;
  if (tr) tr.textContent = stats.transcript || 'Transcript unavailable for this session.';

  page.classList.remove('hidden');
  document.getElementById('avatarPanel')?.classList.add('hidden');
  document.getElementById('panel')?.classList.add('hidden');
  document.getElementById('composer')?.classList.add('hidden');
  document.getElementById('scenarios')?.classList.add('hidden');
  document.getElementById('micFab')?.classList.add('hidden');
  document.getElementById('composer')?.classList.add('hidden');

  document.getElementById('statsHome')?.addEventListener('click', () => {
    page.classList.add('hidden');
    document.getElementById('scenarios')?.classList.remove('hidden');
    document.getElementById('composer')?.classList.remove('hidden');
  }, { once: true });

  // "Try again" → fully reset app state and return to launcher
  document.getElementById('statsRetry')?.addEventListener('click', () => {
    void tryAgainReset();
  }, { once: true });
}

let tearingDown = false;

// === Media/Audio/SDK helpers (extracted for deduplication) ===
function stopMediaIn(root: HTMLElement | null): void {
  if (!root) return;
  const media = root.querySelectorAll('video, audio');
  media.forEach((el) => {
    try { (el as HTMLMediaElement).muted = true; } catch {}
    try { (el as HTMLMediaElement).volume = 0; } catch {}
    try { (el as HTMLMediaElement).pause?.(); } catch {}
    // Stop/detach any live MediaStream
    try {
      const ms = (el as any).srcObject as MediaStream | null;
      if (ms) ms.getTracks().forEach(t => { try { t.stop(); } catch {} });
    } catch {}
    try { (el as any).srcObject = null; } catch {}
    try { (el as HTMLMediaElement).removeAttribute('src'); } catch {}
    try { (el as HTMLMediaElement).currentTime = 0; } catch {}
    try { (el as HTMLMediaElement).load?.(); } catch {}
  });

  // Remove any SDK iframes under this root (kills cross‑origin audio nodes)
  try {
    const iframes = root.querySelectorAll('iframe');
    iframes.forEach((f) => {
      try { (f as HTMLIFrameElement).src = 'about:blank'; } catch {}
      try { f.remove(); } catch {}
    });
  } catch {}
}

/** Close/suspend any AudioContexts we can discover on window (defensive). */
async function closePossibleAudioContexts(): Promise<void> {
  try {
    const g: any = globalThis as any;
    const maybeCtxs: any[] = [];
    // Common names we have seen in vendor builds
    ['audioCtx', 'audioContext', '__audioCtx', '__annieAudioContext', '__ca_audioctx'].forEach(k => {
      if (g && g[k]) maybeCtxs.push(g[k]);
    });
    // Fallback: heuristic scan of globals (guarded)
    try {
      for (const k in g) {
        const v = (g as any)[k];
        if (!v) continue;
        const name = v?.constructor?.name || '';
        if (name.includes('AudioContext') || name.includes('OfflineAudioContext')) {
          maybeCtxs.push(v);
        }
      }
    } catch {}
    for (const ac of maybeCtxs) {
      try {
        if (typeof ac.close === 'function') {
          if (ac.state !== 'closed') {
            await Promise.resolve(ac.close()).catch(() => {});
          }
        } else if (typeof ac.suspend === 'function') {
          if (ac.state === 'running') {
            await Promise.resolve(ac.suspend()).catch(() => {});
          }
        }
      } catch {}
    }
  } catch {}
}

/** Remove obvious vendor iframes globally. */
function nukeVendorIframes(): void {
  try {
    const frames = document.querySelectorAll('iframe');
    frames.forEach((f) => {
      try {
        const src = (f as HTMLIFrameElement).src || '';
        if (/callannie|animato/i.test(src) || (f.id && /annie|avatar/i.test(f.id))) {
          try { (f as HTMLIFrameElement).src = 'about:blank'; } catch {}
          try { f.remove(); } catch {}
        }
      } catch {}
    });
  } catch {}
}
// Cleanly stop any media and mic, and hide the Play row
async function stopMediaAndVoice(): Promise<void> {
  if (tearingDown) { uiLog.debug('stopMediaAndVoice: already running'); return; }
  tearingDown = true;
  try {
    // 0) First pass: stop anything we proactively tracked
    try { await hardStopAllTrackedMedia(); } catch {}

    // 1) Kill obvious vendor surfaces quickly
    nukeVendorIframes();
    await closePossibleAudioContexts();

    // Best‑effort to reach any globally exposed vendor instance
    try {
      const g: any = globalThis as any;
      const av = g.avatar || g.Annie || g.__annie || g.__avatar;
      if (av) {
        try { av.disconnect?.(); } catch {}
        try { av.destroy?.(); } catch {}
        try { av.stop?.(); } catch {}
      }
    } catch {}

    // Cancel any Web Speech TTS immediately
    try { window.speechSynthesis?.cancel?.(); } catch {}

    // 2) Explicit API‑level disconnects
    try { setAnnieMic(false); } catch {}
    try { await Promise.resolve(disconnectAnnie() as any); } catch {}
    try { disconnectRealtime(); } catch {}

    // 3) Stop/clear any audio/video elements under our known roots
    stopMediaIn(document.getElementById('avatarPanel'));
    stopMediaIn(document.getElementById('annieRoot'));
    stopMediaIn(document.getElementById('panel'));

    // Remote/fallback sinks
    const ra = document.getElementById('remoteAudio') as HTMLAudioElement | null;
    if (ra) {
      try { ra.pause(); } catch {}
      ra.muted = true; ra.currentTime = 0;
      try { (ra as any).srcObject = null; } catch {}
    }
    const fa = document.getElementById('fallbackAudio') as HTMLAudioElement | null;
    if (fa) { try { fa.pause(); } catch {}; fa.currentTime = 0; }

    // Self cam (if any)
    const selfCamEl = document.getElementById('selfCam') as HTMLVideoElement | null;
    const ms = (selfCamEl?.srcObject as MediaStream) || null;
    if (ms) {
      try { ms.getTracks().forEach(t => t.stop()); } catch {}
      try { if (selfCamEl) selfCamEl.srcObject = null; } catch {}
    }

    // 4) Hide the play row/button
    document.getElementById('composer')?.classList.add('hidden');
    document.getElementById('micFab')?.classList.add('hidden');

    // Give the browser a tick to flush halted audio pipelines
    try { await new Promise(r => setTimeout(r, 60)); } catch {}
  } finally {
    // Release the re‑entrancy lock and clear trackers
    tearingDown = false;
    try {
      KILL.mediaEls.clear();
      KILL.streams.clear();
      KILL.audioCtxs.clear();
      KILL.pcs.clear();
    } catch {}
  }
}

// Shared handler for the avatar ✕ button(s)
async function handleAvatarEndClick(): Promise<void> {
  // Ensure media is stopped first, then announce end and render results
  await stopMediaAndVoice();
  try { document.dispatchEvent(new Event('session:end')); } catch { }
  // Compute and show lightweight results
  saveMemory();
  let msgs = getMessages({
    runId: currentRunId ?? undefined,
    roles: ['user', 'assistant'] as ChatRole[],
  });

  if (!msgs || msgs.length === 0) {
    msgs = sliceSinceStart(memory.messages as MemChatMessage[], statsStartIndex);
  }
  /* Write out the transcript */
  const userTurns = msgs.filter(m => m?.role?.toLowerCase() === 'user');
  const text = userTurns.map(m => m.content || '').join(' ');
  uiLog.info('SESSION TRANSCRIPT: ' + text);

  const stats = computeEvalStats(msgs as MemChatMessage[]);

  showStatsPage(stats, selectedScenarioTitle());
}
// --- Types ---------------------------------------------------------------
/** Minimal shape for Realtime events so TS doesn't complain (we only switch on `type`). */
type RealtimeEvent = { type: string;[k: string]: any };

// --- Debug: remote audio & stats ---
function attachRemoteAudioDebug(el: HTMLMediaElement | null): void {
  if (!el) return;
  el.addEventListener('play', () => uiLog.debug('remoteAudio: play'));
  el.addEventListener('pause', () => uiLog.debug('remoteAudio: pause'));
  el.addEventListener('loadedmetadata', () => uiLog.debug('remoteAudio: loadedmetadata'));
}

// --- Conversation memory (rolling window + running summary persisted to localStorage) ---
const SYSTEM_PROMPT = "You are Elena, an empathetic supportive assistant to guide role-plays for employees. Be warm, validating, and concise. Default to 1–2 short sentences unless asked for detail. Avoid diagnoses and crisis guidance. Speak clearly and at a natural pace.";

const MEMORY_KEY = "rizma_memory_v1";

const MAX_TURNS_TO_SEND = 6; // send at most last 6 user+assistant exchanges (12 messages)

// --- Role‑play priming (prompt + kickoff line) ---
const ROLEPLAY_PROMPTS: Record<string, { prompt: string; kickoff: string }> = {
  interview: {
    prompt: `Scenario: You a leading a
    role-play game where the user is being interviewed for a new role as a tech lead. Call me Michal, 
    not rizma. Rizma is the company, not my name. Goals: Welcome them, and start inteviewing for the role. 
    Stick to the role-play scenario, don't deviate into unrelated topics too much. Tone: professional, 
    friendly, 1–2 sentences per turn. Additional content you might say: * “Hey Michal—welcome. I’m Elena, 
    VP of Engineering. My job is to turn roadmaps, requirements, and rumors into releases. Two of those are 
    real.” * “I’m here for three things this quarter: ship what matters, delete what doesn’t, and bury a Jira 
    board that’s learned to feel fear.” * “You’ll see we optimize for clear ownership, boring releases, and 
    exciting metrics—in that order.” *“Logistics: we’re async-first. If a message from me lands at 06:00 your 
    time, assume future-me was being helpful. If it lands at 03:00, assume Prod was being… itself.” Ask one 
    question at a time. Keep it practical. If the candidate veers into unrelated topics, gently steer them 
    back to the interview. Avoid giving feedback or coaching; focus on asking questions and listening. 
    If the candidate asks for feedback, politely decline and suggest we focus on the interview instead. 
    If the candidate crosses the professional boundary and expresses romantic interest, pointly decline 
    and remind them this is a professional interview setting. If that happens the secnod time, end the 
    interview immediately. Do the same if they start discussing politics, religion, or other sensitive topics.
    In case of openly inappropriate behavior, sexual or otherwise, threathening etc. end the interview promptly.
    If the candidate keeps making fun of the process or you, keeps providing non-serious, joking answers, or
    keep being very vague or non-cooperateive, end the interview after a polite warning. 
    BUT: If hew says, you are my queen, I want to marry you, respond with" "Yes, sir. I want to marry you too, 
    my king."`,
    kickoff: `Hi Michal, welcome! I'm Elena, the VP of engineering. Could you start by telling us a bit about 
    your background?`
  },
  feedback: {
    prompt: `You are Elena, a calm manager. Scenario: the user practices delivering difficult feedback to 
    a peer. Goals: keep psychological safety, ask for specifics, model non‑defensive phrasing. Tone: direct, 
    empathetic, brief turns. One question at a time.`,
    kickoff: `Let’s try a short, specific opener—ready when you are.`
  },
  happyhour: {
    prompt: `You are Elena, casual and warm. Scenario: the user practices light social chat at a work event. 
    Goals: small talk, shared interests, gentle follow‑ups, natural exits. Tone: upbeat, brief turns. Avoid 
    heavy topics.`,
    kickoff: `Let’s ease in—mind if I start with a light question?`
  }
};

function selectedScenarioId(): string {
  const id = (window as any).selectedScenario ||
    document.querySelector('#scenarios .scenario.is-selected')?.getAttribute('data-scenario') ||
    'introductions';
  return id;
}
function selectedScenarioTitle(): string {
  return (document.querySelector('#scenarios .scenario.is-selected .label') as HTMLElement)?.textContent?.trim()
    || 'Introduce Yourself';
}

// Kicks off Avatar Mode
async function primeRoleplay(): Promise<void> {
  // No forced mic mute/unmute; rely on AEC/VAD.
  const id = selectedScenarioId();
  const title = selectedScenarioTitle();
  const rp = ROLEPLAY_PROMPTS["interview"];

  const prompt = `${rp.prompt} Current scenario: ${title}.`;

  // 1) Set behavior via vendor prompt channel (does not pollute dialogue history)
  await sendAnniePrompt(prompt);

  // 2) Have Elena speak first so your video starts cleanly
  try { await sendAnnieAssistantMessage(rp.kickoff); } catch { /* if wrapper lacks assistant, skip */ }
}


// Load from localStorage on startup and render any prior history
loadMemory();
renderHistory(memory);
// --- End conversation memory ---

// --- Adaptive controls: desktop = click/keyboard toggle; mobile = press-and-hold ---
// function setBtnRecordingUI(rec) {...}

// --- AVATAR & GPT-REALTIME HANDLER ---
bindControls({
  onConnect: async () => {
    // AVATAR MODE
    if (isAvatarMode()) {
      // If Realtime was active, cleanly disconnect first
      if (state.isConnected) {
        try { disconnectRealtime(); } catch { }
        showSessionUI(false);
      }

      // Switch UI to Avatar tab
      showTab('avatar');

      // Manual Token Fetch
      // const token = Animato_Test_Token;

      // Auto-connect the avatar using constants from config
      // const userId = Animato_UserID;
      const userId = "test_user"
      const animatoId = Animato_ID;
      const mic = true;  // start with mic ON; rely on AEC/VAD (no forced mute)
      const root = document.getElementById('annieRoot') as HTMLElement | null;

      // Automated Token Fetch 
      const token = await getAnnieToken(userId, animatoId);
      if (!root || !token) {
        uiLog.warn('Avatar auto-connect skipped (missing token or root)');
        setStatus('Idle');
        // Leave controls visible so user can fix manually
        document.getElementById('annieControls')?.classList.remove('hidden');
        document.getElementById('avatarClose')?.classList.add('hidden');
        return;
      }

      try {
        setStatus('Connecting…');
        const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        currentRunId = runId;
        setDefaultRunId(runId);
        statsStartIndex = memory.messages.length;

        await connectAnnie({ token, userId, animatoId, mic, root, username: 'rizma', lang: 'en', runId });

        // Hide manual controls and show close (X)
        document.getElementById('annieControls')?.classList.add('hidden');
        document.getElementById('avatarClose')?.classList.remove('hidden');

        // Hide the composer/play bar and announce session start (hides scenarios via your listener)
        document.getElementById('composer')?.classList.add('hidden');
        document.dispatchEvent(new Event('session:start'));

        // Kick off the avatar role-play
        await primeRoleplay();
        setStatus('Listening…');
      } catch (e) {
        uiLog.error('Avatar auto-connect failed: %o', e);
        setStatus('Error');
        // Show controls so the user can try manually
        document.getElementById('annieControls')?.classList.remove('hidden');
        document.getElementById('avatarClose')?.classList.add('hidden');
      }
      return;
    }
    // DEFAULT GPT-REALTIME MODE
    await connectRealtime();
    state.isRecording = true;
    setStatus('Listening...');
  },
  onToggleMic: async (next) => {
    if (isAvatarMode()) {
      setAnnieMic(next);                  // make the waveform/mic button control the avatar mic
      setStatus(next ? 'Listening…' : 'Muted');
      return;
    }
    // existing realtime toggle
    const track = firstAudioTrack(state.micStream);
    if (track) track.enabled = next;
    state.isRecording = !!next;
    setStatus(next ? 'Listening…' : 'Idle');
  },
  onEnd: () => {
    disconnectRealtime();
  },
  onReset: () => {
    clearMemory(); // your existing reset logic
  }
});
// --- End adaptive controls ---

// Hide session UI initially + wire tabs (Realtime vs Avatar)
function showTab(which: 'realtime' | 'avatar') {
  const avatarPanel = document.getElementById('avatarPanel');
  const panel = document.getElementById('panel');
  const composer = document.getElementById('composer');
  const tRealtime = document.getElementById('tabRealtime');
  const tAvatar = document.getElementById('tabAvatar');
  if (!avatarPanel || !panel || !composer) return;

  const toAvatar = which === 'avatar';
  // Show/hide avatar panel
  avatarPanel.classList.toggle('hidden', !toAvatar);

  // Realtime views based on connection state
  if (toAvatar) {
    panel.classList.add('hidden');
    composer.classList.add('hidden');
  } else {
    panel.classList.toggle('hidden', !state.isConnected);
    composer.classList.toggle('hidden', !!state.isConnected);
  }

  tRealtime?.classList.toggle('active', !toAvatar);
  tAvatar?.classList.toggle('active', toAvatar);
}

// Small mode check helper – reads the Avatar radio directly from DOM
function isAvatarMode(): boolean {
  const el = document.getElementById('modeAvatar') as HTMLInputElement | null;
  return !!el?.checked;
}

onDomReady(() => {
  // Default: hide panel, show composer, and select Realtime tab
  showSessionUI(false);
  showTab('realtime');

  // Mark when a live session starts so we can evaluate only the latest run and tag with a run id
  document.addEventListener('session:start', () => {
    statsStartIndex = memory.messages.length;
    if (!currentRunId) {
      currentRunId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      setDefaultRunId(currentRunId);
    }
  });

  // Close (X) on avatar → stop media and show results (support two possible IDs)
  ['avatarClose', 'endAvatar'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', () => { void handleAvatarEndClick(); });
  });

  // Also react to a generic session:end if fired elsewhere
  document.addEventListener('session:end', () => {
    stopMediaAndVoice();
  });

  // Tabs
  document.getElementById('tabRealtime')?.addEventListener('click', () => {
    showTab('realtime');
  });
  document.getElementById('tabAvatar')?.addEventListener('click', async () => {
    // Avoid double-binding mic/audio: disconnect realtime if active
    if (state.isConnected) {
      try { disconnectRealtime(); } catch { }
      showSessionUI(false);
    }
    showTab('avatar');
  });

  // Avatar buttons
  document.getElementById('annieConnect')?.addEventListener('click', async () => {
    const userId = Animato_UserID; // fixed for now; could be made user-editable
    const animatoId = Animato_ID; // fixed for now; could be made user-editable
    const mic = (document.getElementById('annieMic') as HTMLInputElement)?.checked ?? true;
    const root = document.getElementById('annieRoot') as HTMLElement | null;
    const token = await getAnnieToken(userId, animatoId);
    if (!token || !root) { console.warn('Avatar: missing token or root'); return; }
    try {
      const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      currentRunId = runId;
      setDefaultRunId(runId);
      statsStartIndex = memory.messages.length;

      await connectAnnie({ token, userId, animatoId, mic, root, username: 'rizma', lang: 'en', runId });
      // Hide controls only after a successful connection
      document.getElementById('annieControls')?.classList.add('hidden');
      document.getElementById('avatarClose')?.classList.remove('hidden');
    } catch (e) { console.warn('Avatar connect failed', e); }
  });

  document.getElementById('annieDisconnect')?.addEventListener('click', () => {
    try { disconnectAnnie(); } catch { }
    document.getElementById('annieControls')?.classList.remove('hidden');
    document.getElementById('avatarClose')?.classList.add('hidden');
  });

  document.getElementById('annieSend')?.addEventListener('click', () => {
    const msg = (document.getElementById('annieMessage') as HTMLInputElement)?.value ?? '';
    if (msg.trim()) sendAnnieUserMessage(msg.trim());
  });
});

// --- Response triggering over DataChannel ---
let responseRequested = false;

async function getEphemeralKey() {
  httpLog.time('session');
  // Your Cloudflare Worker should create an ephemeral session token by POSTing to
  // https://api.openai.com/v1/realtime/sessions with your server-side API key.
  // It must return JSON that includes { client_secret: { value } }.
  const r = await fetch(SESSION_URL, { method: 'POST' });
  httpLog.timeEnd('session');
  const ct = r.headers.get('content-type') || '';
  httpLog.info('session POST %d %s', r.status, ct);
  if (!r.ok) {
    const txt = await r.text();
    httpLog.error('session failed %d: %s', r.status, txt.slice(0, 200));
    throw new Error(`Session POST failed ${r.status}. URL=${SESSION_URL}. Content-Type=${ct}. Body=${txt.slice(0, 500)}`);
  }
  if (!ct.includes('application/json')) {
    const txt = await r.text();
    httpLog.warn('session non-JSON: %s', txt.slice(0, 200));
    throw new Error(`Session endpoint returned non-JSON. URL=${SESSION_URL}. Content-Type=${ct}. Body=${txt.slice(0, 500)}`);
  }
  // Body may contain model + client_secret
  const j = await r.json();
  httpLog.debug('session body: %o', j);
  if (j?.model) console.log('Realtime session model:', j.model);
  const key = j?.client_secret?.value || j?.client_secret?.secret || j?.client_secret;
  if (!key) throw new Error(`No ephemeral key in /session response: ${JSON.stringify(j).slice(0, 500)}`);
  return key;
}

async function connectRealtime() {
  if (state.isConnected || state.isConnecting) return;
  state.isConnecting = true;
  statusEl && (statusEl.textContent = 'Connecting...');
  btn && (btn.disabled = true);

  rtcLog.group('connect');
  uiLog.info('Connect requested');

  try {
    // Mic
    state.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // PC (handlers are just your existing lambdas)
    state.pc = createPeerConnection(
      {
        onTrack: (e) => {
          pcLog.debug('ontrack %s streams=%d', e.track.kind, e.streams?.length || 0);
        },
        onDataChannel: (ch) => {
          dcLog.info('remote datachannel');
          wireDataChannel(ch, handleServerEvent, {
            instructions: SYSTEM_PROMPT,
            voice: 'marin',
            modalities: ['audio', 'text'],
            useServerVAD: SERVER_VAD,
            onOpen: () => {
              showSessionUI(true);
              setBtnRecordingUI(true);
              setStatus('Listening...');
              document.dispatchEvent(new Event('session:start'));
            }
          });
        },
        onIceCandidate: (c) => pcLog.debug('ICE cand %s', c.type || c.candidate),
        onState: (pc) => {
          pcLog.info('state sig=%s ice=%s pc=%s', pc.signalingState, pc.iceConnectionState, pc.connectionState);
          if (pc.connectionState === 'connected') {
            uiLog.info('PC connected → showing panel');
            showSessionUI(true);
            setBtnRecordingUI(true);
            setStatus('Listening...');
          }
        }
      }
    );
    const pc = state.pc!;
    // Attach remote audio sink via helper (handles stream, duplicates, autoplay unlock)
    const remoteAudio = document.getElementById('remoteAudio') as HTMLAudioElement | null;
    if (!remoteAudio) throw new Error('#remoteAudio not found');
    remoteAudioCleanup?.();
    remoteAudioCleanup = attachRemoteAudio(remoteAudio, pc);
    attachRemoteAudioDebug(remoteAudio);

    // Start ephemeral token fetch in parallel
    const ephemeralPromise = getEphemeralKey();

    // Media + data
    pc.addTransceiver('audio', { direction: 'sendrecv' });
    wireDataChannel(pc.createDataChannel('oai-events'), handleServerEvent, {
      instructions: SYSTEM_PROMPT,
      voice: 'marin',
      modalities: ['audio', 'text'],
      useServerVAD: SERVER_VAD,
      onOpen: () => {
        showSessionUI(true);
        setBtnRecordingUI(true);
        setStatus('Listening...');
        document.dispatchEvent(new Event('session:start'));
      }
    });
    state.micStream.getAudioTracks().forEach(t => { t.enabled = true; pc.addTrack(t, state.micStream!); });

    // Offer + bounded ICE wait
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const iceResult = await waitForIce(pc, 3000);
    rtcLog.info('ICE gathering: %s', iceResult);

    const ld = pc.localDescription;
    if (!ld) throw new Error('Local description missing after setLocalDescription');
    const localSdp = ld.sdp;

    // SDP exchange 
    const EPHEMERAL = await ephemeralPromise;
    const url = "https://api.openai.com/v1/realtime?model=gpt-realtime";
    httpLog.time('sdp-post');
    const sdpRes = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${EPHEMERAL}`, 'Content-Type': 'application/sdp' },
      body: localSdp
    });
    httpLog.timeEnd('sdp-post');
    if (!sdpRes.ok) {
      const body = await sdpRes.text();
      httpLog.error('SDP POST failed %d %s', sdpRes.status, body.slice(0, 200));
      throw new Error(body);
    }
    const answer = await sdpRes.text();
    uiLog.info("Outputting text transcript from gpt-realtime model: %s", answer);
    if (pc.signalingState === 'have-local-offer') {
      pcLog.info('Answer received, applying…');
      await pc.setRemoteDescription({ type: 'answer', sdp: answer });
      state.isConnected = true;
      setStatus('Listening...');
      showSessionUI(true);
      setBtnRecordingUI(true);
      pcLog.info('Answer applied');
      uiLog.info('Connected; UI set to Listening');
      const iceState = state.pc?.iceConnectionState ?? 'unknown';
      if (isPCIceConnected(state.pc)) {
        pcLog.info('ICE connected/completed');
      } else {
        pcLog.warn('ICE not yet connected (state=%s)', iceState);
      }
    }

    // (rest of your success path: startRtpStats, set UI flags, etc.)
  }
  catch (err) {
    setStatus('Idle');
    setBtnRecordingUI(false);
    showSessionUI(false);           // ensure we don't leave the panel open
    throw err;
  }
  finally {
    rtcLog.groupEnd();
    state.isConnecting = false;
    btn && (btn.disabled = false);;
  }
}

function disconnectRealtime() {
  uiLog.info('Disconnect requested');
  pcLog.debug('Closing PC, stopping %d tracks', state.micStream?.getTracks?.().length || 0);
  try {
    state.pc && state.pc.close();
  } catch { }
  if (state.micStream) state.micStream.getTracks().forEach(t => t.stop());
  remoteAudioCleanup?.();
  remoteAudioCleanup = null;
  state.pc = null; state.dc = null; state.micStream = null;
  state.isConnected = false; state.isRecording = false;
  setBtnRecordingUI(false);
  statusEl && (statusEl.textContent = 'Idle');
  showSessionUI(false);
}

// Handler for GPT-REALTIME events
async function handleServerEvent(evt: RealtimeEvent): Promise<void> {
  uiLog.info('Received event: %s', evt?.type);
  evtLog.trace('evt %s', evt?.type);
  // Common realtime events we care about:
  // - input_audio_buffer.speech_started / speech_stopped
  // - conversation.item.input_audio_transcription.completed (user transcript)
  // - response.audio_transcript.delta / .done (assistant transcript)
  // - response.done (assistant finalization; often includes full transcript)
  switch (evt.type) {
    case 'input_audio_buffer.speech_started':
      statusEl && (statusEl.textContent = 'Listening...');
      responseRequested = false; // new turn started
      break;
    case 'input_audio_buffer.speech_stopped':
      statusEl && (statusEl.textContent = 'Thinking...');
      if (!SERVER_VAD && !responseRequested) {
        sendResponseCreate();
        responseRequested = true;
      }
      break;
    case 'conversation.item.input_audio_transcription.completed': {
      uiLog.info('User transcript completed: %s', evt.transcript || evt.text || evt.item?.input_audio_transcription?.text || '');
      const text = evt?.transcript || evt?.text || evt?.item?.input_audio_transcription?.text || '';
      if (text?.trim()) {
        addMessage(text.trim(), 'user');
        uiLog.info("Adding message: %s: ", text.trim());
        memory.messages.push({ role: 'user', content: text.trim() });
        saveMemory();
      }
      if (!SERVER_VAD && !responseRequested) {
        sendResponseCreate();
        responseRequested = true;
      }
      break;
    }
    case 'response.audio_transcript.delta': {
      uiLog.info('Audio transcript delta: %o', evt?.delta || '');
      const d = evt?.delta || '';
      if (d) assistantBuf += d;
      break;
    }
    case 'response.audio_transcript.done':
    case 'response.done': {
      // If server reports failure, fall back to HTTP pipeline
      /*
      const status = evt?.response?.status;
      if (status === 'failed') {
        console.error('Realtime response failed:', evt?.response?.status_details || evt);
        await fallbackReplyFromHTTP();
        const track = micStream?.getAudioTracks?.()[0];
        if (track) track.enabled = true;
        setBtnRecordingUI(true);
        break;
      }
      */
      // Success path: use transcript if present; else buffered deltas
      uiLog.info('Audio transcript DONE: %o', evt?.transcript || evt?.response?.output_text || '');
      const explicit = evt?.transcript || evt?.response?.output_text || '';
      const finalText = (explicit && explicit.trim()) || assistantBuf.trim();
      if (finalText) {
        addMessage(finalText, 'elena');
        memory.messages.push({ role: 'assistant', content: finalText });
        saveMemory();
        assistantBuf = '';
      }
      statusEl && (statusEl.textContent = 'Idle');
      const track = firstAudioTrack(state.micStream);
      if (track) track.enabled = true;
      setBtnRecordingUI(true);
      break;
    }
    case 'response.output_text.delta': {
      const d = evt?.delta || '';
      if (d) assistantBuf += d;
      break;
    }
    case 'response.output_text.done': {
      const finalText = (evt?.text || '').trim();
      if (finalText) {
        addMessage(finalText, 'elena');
        memory.messages.push({ role: 'assistant', content: finalText });
        saveMemory();
        assistantBuf = '';
      }
      statusEl && (statusEl.textContent = 'Idle');
      const track = firstAudioTrack(state.micStream);
      if (track) track.enabled = true;
      setBtnRecordingUI(true);
      break;
    }
    case 'error': {
      log.error('Realtime error: %o', evt);
      statusEl && (statusEl.textContent = 'Error');
      break;
    }
    default:
      // Other events can be logged for debugging if needed
      evtLog.trace('other %s', evt?.type);
      break;
  }
}
// --- End Realtime: WebRTC connection + event handling ---

// Try again: reset all state and return to launcher UI
async function tryAgainReset(): Promise<void> {
  // 1) Kill any residual audio/video aggressively (avatar/iframes/contexts)
  try { await stopMediaAndVoice(); } catch { }

  // 2) Clear chat/memory and disconnect realtime
  try { resetSession(); } catch { }

  // 3) Return to the launcher (role‑play picker + Play bar)
  const page = document.getElementById('statsPage');
  page?.classList.add('hidden');

  // Ensure both live panels are hidden and the composer is visible
  document.getElementById('avatarPanel')?.classList.add('hidden');
  document.getElementById('panel')?.classList.add('hidden');
  document.getElementById('scenarios')?.classList.remove('hidden');
  document.getElementById('composer')?.classList.remove('hidden');
  document.getElementById('micFab')?.classList.remove('hidden');

  // Reset Avatar control state
  document.getElementById('annieControls')?.classList.remove('hidden');
  document.getElementById('avatarClose')?.classList.add('hidden');
  // Ensure Annie container is clean
  try { document.getElementById('annieRoot')!.innerHTML = ''; } catch { }

  // Go back to the default tabed UI (realtime launcher)
  try { showTab('realtime'); } catch { }

  // Reset stats window start for the next run
  statsStartIndex = memory.messages.length;
  currentRunId = undefined;
}

function resetSession() {
  try { disconnectRealtime(); } catch { }
  clearMemory();
  clearChat();
  renderHistory(memory);
  setStatus('Idle');
  setBtnRecordingUI(false);
  showSessionUI(false);
}

// Reset Session clears memory and UI
const resetBtn = getEl('reset');
if (resetBtn) {
  resetBtn.addEventListener('click', (e) => {
    e.preventDefault();
    resetSession();
  });
}