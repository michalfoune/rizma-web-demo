import { state } from './state/appState';
import { memory, saveMemory, loadMemory, clearMemory, setDefaultRunId, getMessages } from './state/memory';
import type { ChatMessage, ChatRole } from './state/memory';
import { createPeerConnection, waitForIce } from './rtc/connection';
import { getEl, setText, setVisible, onDomReady } from './ui/dom';
import { startCountdown, stopCountdown, DEFAULT_DURATION_SEC } from './ui/countdown';
import { bindControls, setBtnRecordingUI, setStatus } from './ui/controls';
import { showSessionUI } from './ui/dom';
import { addMessage, renderHistory, clearChat } from './ui/chatView';
import { wireDataChannel, sendTextAndRespond, sendResponseCreate } from './rtc/signaling';
import { attachRemoteAudio } from './rtc/audio';
import { log, setLevel, createLogger } from './utils/logger';
import { firstAudioTrack, isPCIceConnected } from './utils/guards';
import { getAnnieToken, connectAnnie, disconnectAnnie, sendAnnieUserMessage, setAnnieMic, sendAnniePrompt, sendAnnieAssistantMessage, ensureLivePane, destroyLivePane, renderLiveTranscript } from './integrations/annie';
import { Animato_UserID, Animato_Test_Token, PROXY_BASE, AVATAR_NAME, ANIMATO_ELENA_ID, ANIMATO_HANA_ID } from './config/constants';
import { evaluateTranscript } from './analysis/evaluator';

// Logger scopes & defaults
if ((import.meta as any)?.env?.MODE === 'development') setLevel('debug');
const uiLog = createLogger('ui');
const rtcLog = createLogger('rtc');
const pcLog = rtcLog.child('pc');
const dcLog = rtcLog.child('dc');
const httpLog = rtcLog.child('http');
const evtLog = rtcLog.child('evt');


// OpenAI key stays in Cloudflare Worker secret; browser calls proxy
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
// Avatar connection state guard for PTT toggling
let avatarConnected = false;

// Fallback hard-stop timer (in case countdown onExpire doesn't fire)
let avatarHardStopTimeoutId: number | null = null;
let avatarEnding = false;


interface EvalStats {
  score: number; pass: boolean;
  strengths: string[]; improvements: string[];
  fillerPer100: number; toneHint: string; paceHint: string;
  confidence?: number; // 0–100 perceived user confidence
  transcript: string;
  /** HTML-rendered transcript with chat-style bubbles (sanitized) */
  transcriptHtml: string;
}

function sliceSinceStart(msgs: ChatMessage[], start: number): ChatMessage[] {
  if (!Array.isArray(msgs)) return [];
  const i = Math.max(0, Math.min(start, msgs.length));
  return msgs.slice(i);
}

// Escape HTML for safe insertion
function escapeHtml(s: string): string {
  return (s || '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c] || c
  );
}
// Normalize role names and provide display labels
function normalizeRole(r: string | undefined | null): 'user' | 'assistant' | 'other' {
  const v = (r || '').toLowerCase();
  if (v === 'user') return 'user';
  if (v === 'assistant' || v === 'elena') return 'assistant';
  return 'other';
}

function buildTranscriptArtifacts(msgs: ChatMessage[]): { text: string; transcriptHtml: string } {
  // Plain-text transcript (for logging/fallback)
  const text = msgs
    .filter(m => normalizeRole(m.role) !== 'other')
    .map(m => `${normalizeRole(m.role) === 'user' ? 'User' : 'Assistant'}: ${m.content || ''}`)
    .join('\n\n') + '\n';

  // WhatsApp-like HTML transcript:
  const bubbles: string[] = [];
  let lastRole: 'user' | 'assistant' | 'other' | null = null;

  for (const m of msgs) {
    const role = normalizeRole(m.role);
    if (role === 'other') continue;
    const isUser = role === 'user';
    const showLabel = role !== lastRole;
    lastRole = role;

    const labelHtml = showLabel
      ? `<div style="font-weight:600;margin:0 0 4px 0;">${isUser ? 'User' : 'Assistant'}</div>`
      : '';

    const msgHtml = escapeHtml(m.content || '').replace(/\n/g, '<br>');

    const bubble = `
      <div style="display:flex; ${isUser ? 'justify-content:flex-end;' : 'justify-content:flex-start;'}">
        <div style="
          max-width:80%;
          background:${isUser ? '#d9fdd3' : '#f1f5f9'};
          color:#111;
          border-radius:14px;
          padding:8px 12px;
          margin:4px 0;
          box-shadow:0 1px 1px rgba(0,0,0,.08);
          line-height:1.35;
        ">
          ${labelHtml}
          <div>${msgHtml}</div>
        </div>
      </div>`;
    bubbles.push(bubble);
  }

  const transcriptHtml =
    `<div style="display:flex;flex-direction:column;gap:6px;">${bubbles.join('')}</div>`;

  return { text, transcriptHtml };
}


function showStatsPage(stats: EvalStats, title: string) {
  // Ensure any live sessions are terminated when showing stats
  try { endAllSessions(); } catch { }
  const page = document.getElementById('statsPage');
  if (!page) return;

  const set = (id: string, v: string) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('statsTitle', title || 'Role-Play Results');
  set('statsScore', String(stats.score));
  const passLabel = ((stats as any).pass === undefined) ? '' : (stats.pass ? 'Pass' : 'Needs work');
  set('statsPass', passLabel);
  set('statsFiller', `${stats.fillerPer100.toFixed(1)} / 100 words`);
  set('statsTone', stats.toneHint);
  set('statsPace', stats.paceHint);
  // Confidence (optional): number if present, em-dash if not
  const conf = (stats as any).confidence;
  if (typeof conf === 'number' && isFinite(conf)) {
    set('statsConfidence', String(Math.round(conf)));
  } else {
    set('statsConfidence', '—');
  }

  const sUL = document.getElementById('statsStrengths');
  const iUL = document.getElementById('statsImprovements');
  if (sUL) sUL.innerHTML = stats.strengths.map(s => `<li>${s}</li>`).join('');
  if (iUL) iUL.innerHTML = stats.improvements.map(s => `<li>${s}</li>`).join('');

  const tr = document.getElementById('statsTranscript') as HTMLElement | null;
  if (tr) {
    // Render chat-style HTML bubbles (contents already sanitized)
    tr.innerHTML =
      stats.transcriptHtml ||
      escapeHtml(stats.transcript || 'Transcript unavailable for this session.').replace(/\n/g, '<br>');
  }

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

function showEvalErrorPage(title: string, transcriptHtml?: string, text?: string) {
  // Ensure any live sessions are terminated when showing stats
  try { endAllSessions(); } catch { }
  const page = document.getElementById('statsPage');
  if (!page) return;

  const set = (id: string, v: string) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('statsTitle', title || 'Role-Play Results');
  set('statsScore', '—');
  set('statsPass', 'Evaluation failed due to network issues.');
  set('statsFiller', '—');
  set('statsTone', '—');
  set('statsPace', '—');
  set('statsConfidence', '—');

  const sUL = document.getElementById('statsStrengths');
  const iUL = document.getElementById('statsImprovements');
  if (sUL) sUL.innerHTML = '<li>—</li>';
  if (iUL) iUL.innerHTML = '<li>—</li>';

  const tr = document.getElementById('statsTranscript') as HTMLElement | null;
  if (tr) {
    tr.innerHTML =
      (transcriptHtml && transcriptHtml.trim())
        ? transcriptHtml
        : escapeHtml(text || 'Transcript unavailable for this session.').replace(/\n/g, '<br>');
  }

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

  document.getElementById('statsRetry')?.addEventListener('click', () => {
    void tryAgainReset();
  }, { once: true });
}



// === Media/Audio/SDK helpers (extracted for deduplication) ===

function armAvatarHardStop(durationMs: number): void {
  clearAvatarHardStop();
  avatarEnding = false;
  avatarHardStopTimeoutId = window.setTimeout(async () => {
    if (avatarEnding) return;
    if (!isAvatarMode()) return;
    avatarEnding = true;
    uiLog.info('[hard-stop] time up → ending avatar role-play');
    try { await handleAvatarEndClick(); }
    catch (e) { uiLog.warn('[hard-stop] handleAvatarEndClick failed', e); }
    finally { avatarEnding = false; }
  }, durationMs);
}

function clearAvatarHardStop(): void {
  if (avatarHardStopTimeoutId !== null) {
    clearTimeout(avatarHardStopTimeoutId);
    avatarHardStopTimeoutId = null;
  }
}

// Simple, deterministic session terminator (no heuristics)
function endAllSessions(): void {
  try { stopCountdown(); } catch { }
  try { clearAvatarHardStop(); } catch { }
  try { setAnnieMic(false); } catch { }
  try { disconnectAnnie(); } catch { }
  try { disconnectRealtime(); } catch { }
}

// Shared handler for the avatar ✕ button(s)
async function handleAvatarEndClick(): Promise<void> {
  // Ensure media is stopped first, then announce end and render results
  // Hide stats page while we wait for LLM results (avoid stale/placeholder UI)
  try { document.getElementById('statsPage')?.classList.add('hidden'); } catch { }
  // Single pre-clear: reset stats header/labels while evaluator runs (no PASS/FAIL yet)
  try {
    const title = selectedScenarioTitle();
    const set = (id: string, v: string) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('statsTitle', title ? `${title}:` : ''); // show only the scenario title + colon
    set('statsPass', '');
    set('statsScore', '');
    set('statsFiller', '');
    set('statsTone', '');
    set('statsPace', '');
    set('statsConfidence', '');
    const sUL = document.getElementById('statsStrengths'); if (sUL) sUL.innerHTML = '';
    const iUL = document.getElementById('statsImprovements'); if (iUL) iUL.innerHTML = '';
  } catch { }
  endAllSessions();
  try { destroyLivePane(); } catch { }
  try { document.dispatchEvent(new Event('session:end')); } catch { }
  // Compute and show results via LLM evaluator
  saveMemory();
  // Use the messages accumulated since this session began.
  const msgs = sliceSinceStart(memory.messages as ChatMessage[], statsStartIndex);
  const { text, transcriptHtml } = buildTranscriptArtifacts(msgs as ChatMessage[]);
  uiLog.info('SESSION TRANSCRIPT: ' + text);

  try {
    const evalRes = await evaluateTranscript(msgs as ChatMessage[], { endpoint: `${PROXY_BASE}/eval` });
    const stats: EvalStats = {
      ...evalRes,
      transcript: text,
      transcriptHtml
    };
    showStatsPage(stats, selectedScenarioTitle());
  } catch (e) {
    uiLog.warn('LLM evaluation failed; showing error notice', e);
    showEvalErrorPage(selectedScenarioTitle(), transcriptHtml, text);
  }
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
function systemPromptForScenario(): string {
  const name = avatarNameForSelectedScenario();
  return `You are ${name}, you are engaging with the user in a selected role-play.`;
}

const MEMORY_KEY = "rizma_memory_v2";

const MAX_TURNS_TO_SEND = 6; // send at most last 6 user+assistant exchanges (12 messages)

// --- Role‑play priming (prompt + kickoff line) ---
const ROLEPLAY_PROMPTS: Record<RoleplayKey, (avatarName: string) => { prompt: string; kickoff: string }> = {
  interview: (avatarName: string) => ({
    prompt: `You are leading a role-play where the user is being interviewed for a new role as a tech lead. Be concise and don't produce more than a couple of messages at once. After the kickoff ask clarifying questions about specifics of their leadership style or background and projects. Don't correct how the user pronounces your name be it Alina, ${avatarName} or anything else. Just accept it. Don't say anything else in the initial message. Be professional, reasonably measured and concise. Default to 1–2 short sentences unless asked for detail. Speak clearly and at a natural pace. Don't deviate too much from the interview topic. Don't output any special characters like asterisks "*" or symbols like "[Spoken]" or anything that is not a transcript of the speech.`,
    kickoff: `Hi Michal, welcome! I'm ${avatarName}, what sets your leadership style apart?`
  }),
  feedback: (avatarName: string) => ({
    prompt: `You are ${avatarName}, a calm manager. Scenario: the user practices delivering difficult feedback to 
    a peer. Goals: keep psychological safety, ask for specifics, model non‑defensive phrasing. Tone: direct, 
    empathetic, brief turns. One question at a time.`,
    kickoff: `Let’s try a short, specific opener—ready when you are.`
  }),
  happyhour: (avatarName: string) => ({
    prompt: `You are ${avatarName}, casual and warm. Scenario: the user practices light social chat at a work event. 
    Goals: small talk, shared interests, gentle follow‑ups, natural exits. Tone: upbeat, brief turns. Avoid 
    heavy topics.`,
    kickoff: `Let’s ease in—mind if I start with a light question?`
  })
};

function selectedScenarioId(): string {
  const raw = (window as any).selectedScenario ||
    document.querySelector('#scenarios .scenario.is-selected')?.getAttribute('data-scenario') ||
    'introductions';

  const id = String(raw).toLowerCase();

  // Canonicalize to the three known scenarios so downstream logic
  // (avatar selection, prompts, duration) stays in sync even if
  // the underlying data-scenario uses a slightly different label.
  if (id.includes('happy') || id.includes('open')) {
    return 'happyhour';
  }
  if (id.includes('feedback')) {
    return 'feedback';
  }
  if (id.includes('intro')) {
    return 'introductions';
  }

  // Fallback: return whatever we got
  return id;
}
function selectedScenarioTitle(): string {
  return (document.querySelector('#scenarios .scenario.is-selected .label') as HTMLElement)?.textContent?.trim()
    || 'Introduce Yourself';
}

type ScenarioId = 'introductions' | 'feedback' | 'happyhour';

function avatarIdForSelectedScenario(): string {
  const id = selectedScenarioId() as ScenarioId;
  switch (id) {
    case 'happyhour':
      // Scenario #3 → Hana
      return ANIMATO_HANA_ID;
    case 'feedback':
    case 'introductions':
    default:
      // Scenario #1 (Job Interview) and #2 (Tough Feedback) → Elena
      return ANIMATO_ELENA_ID;
  }
}

// Map scenario → avatar display name
function avatarNameForSelectedScenario(): string {
  const id = selectedScenarioId() as ScenarioId;
  switch (id) {
    case 'happyhour':
      // Scenario #3 → Hana
      return 'Hana';
    case 'feedback':
    case 'introductions':
    default:
      // Scenario #1 (Job Interview) and #2 (Tough Feedback) → Elena (default from constants)
      return AVATAR_NAME || 'Elena';
  }
}

type RoleplayKey = 'interview' | 'feedback' | 'happyhour';

function roleplayKeyForScenario(id: ScenarioId): RoleplayKey {
  switch (id) {
    case 'feedback':
      return 'feedback';
    case 'happyhour':
      return 'happyhour';
    case 'introductions':
    default:
      return 'interview';
  }
}

function durationForScenario(id: ScenarioId): number {
  switch (id) {
    case 'happyhour':
      // Open conversation / happy hour → 5 minutes
      return 5 * 60;
    case 'feedback':
    case 'introductions':
    default:
      // Job interview & tough feedback → 2 minutes
      return 2 * 60;
  }
}

// Kicks off Avatar Mode
async function primeRoleplay(): Promise<void> {
  // No forced mic mute/unmute; rely on AEC/VAD.
  const scenarioId = selectedScenarioId() as ScenarioId;
  const title = selectedScenarioTitle();
  const roleKey = roleplayKeyForScenario(scenarioId);
  const avatarName = avatarNameForSelectedScenario();

  const rpFactory = ROLEPLAY_PROMPTS[roleKey];
  const rp = rpFactory(avatarName);

  const prompt = `${rp.prompt} Current scenario: ${title}.`;

  // 1) Set behavior via vendor prompt channel (does not pollute dialogue history)
  await sendAnniePrompt(prompt);

  // 2) Have the avatar speak first so your video starts cleanly
  try { await sendAnnieAssistantMessage(rp.kickoff); } catch { /* if wrapper lacks assistant, skip */ }
}


// Load from localStorage on startup and render any prior history
loadMemory();
renderHistory(memory);
// --- End conversation memory ---

// --- Adaptive controls: desktop = click/keyboard toggle; mobile = press-and-hold ---
// function setBtnRecordingUI(rec) {...}

// --- Mic indicator (Avatar overlay) ---------------------------------------
function micHost(): HTMLElement | null {
  return document.getElementById('annieStage') || document.querySelector('.annie-stage') as HTMLElement | null;
}

const MIC_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V20H8v2h8v-2h-3v-2.08A7 7 0 0 0 19 11h-2z"/></svg>`;
const MUTE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 11a7 7 0 0 1-1.03 3.65l-1.45-1.45A5 5 0 0 0 17 11h2zM7 11H5a7 7 0 0 0 7 7c.7 0 1.38-.1 2.02-.3l-1.57-1.57A5 5 0 0 1 7 11zm11.3 9.9-15.2-15.2 1.4-1.4 15.2 15.2-1.4 1.4zM12 2a3 3 0 0 1 3 3v5c0 .42-.08.82-.23 1.18l-6.95-6.95A3 3 0 0 1 12 2zm-3 8V6c0-.38.07-.73.2-1.06l5.86 5.86A3 3 0 0 1 9 10z"/></svg>`;

function ensureMicIndicator(): HTMLElement | null {
  const host = micHost();
  if (!host) return null;
  let el = document.getElementById('micIndicator') as HTMLElement | null;
  if (!el) {
    el = document.createElement('div');
    el.id = 'micIndicator';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    host.appendChild(el);
  }
  return el;
}

function setMicIndicator(on: boolean): void {
  const el = ensureMicIndicator();
  if (!el) return;
  el.classList.toggle('on', on);
  el.classList.toggle('off', !on);
  el.setAttribute('aria-label', on ? 'Microphone on' : 'Microphone muted');
  el.innerHTML = on ? MIC_SVG : MUTE_SVG;
}

function destroyMicIndicator(): void {
  const el = document.getElementById('micIndicator');
  if (el && el.parentElement) el.parentElement.removeChild(el);
}
// -------------------------------------------------------------------------
// --- AVATAR & GPT-REALTIME HANDLER ---
bindControls({
  onConnect: async () => {
    // AVATAR MODE
    if (isAvatarMode()) {
      const scenarioId = selectedScenarioId() as ScenarioId;
      const durationSec = durationForScenario(scenarioId);

      // If Realtime was active, cleanly disconnect first
      if (state.isConnected) {
        try { disconnectRealtime(); } catch { }
        showSessionUI(false);
      }

      // Switch UI to Avatar tab
      showTab('avatar');

      // Connect the avatar using constants from config (sole connection path)
      const userId = Animato_UserID;
      const animatoId = avatarIdForSelectedScenario();
      // Decide mic policy from the PTT switch (checked => PTT => start muted)
      PTT_ENABLED = readPTTFromDOM();       // sync flag at the moment of connect
      const startMuted = PTT_ENABLED;
      const mic = !startMuted;              // auto-mic ON when PTT is off
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

        const animato = await connectAnnie({ token, userId, animatoId, mic, root, userName: 'Michal', lang: 'en', runId });
        // Enforce muted start and mark avatar as connected
        // Apply initial mic state and mark avatar as connected
        try { setAnnieMic(mic); } catch { }
        avatarConnected = true;
        // Avoid Space triggering a focused control right after connect
        try { (document.activeElement as HTMLElement | null)?.blur?.(); } catch { }
        console.log('Annie connected:', animato);

        // Initialize the live transcript pane on the avatar's black strip
        try {
          ensureLivePane();
          renderLiveTranscript(memory.messages || []);
        } catch (err) {
          uiLog.debug('live pane init error: %o', err);
        }

        // Hide manual controls and show close (X)
        document.getElementById('annieControls')?.classList.add('hidden');
        document.getElementById('avatarClose')?.classList.remove('hidden');

        // Hide the composer/play bar and announce session start (hides scenarios via your listener)
        document.getElementById('composer')?.classList.add('hidden');
        document.dispatchEvent(new Event('session:start'));

        // Kick off the avatar role-play
        await primeRoleplay();

        // Start countdown only once the avatar role-play is actually ready
        try {
          startCountdown({
            mount: () => document.getElementById('countdownMount'),
            onExpire: async () => {
              uiLog.info('[countdown] time up → countdown expired');

              // For Happy Hour / Open Conversation we want a longer session
              // (5 minutes). The countdown component still uses its default
              // 2-minute duration, so we ignore this early expiry and rely
              // on the per-scenario hard-stop timer below.
              if (scenarioId === 'happyhour' && durationSec > DEFAULT_DURATION_SEC) {
                uiLog.info('[countdown] ignoring expiry for happyhour; waiting for hard-stop at %ds', durationSec);
                return;
              }

              if (avatarEnding) return;
              avatarEnding = true;
              try { await handleAvatarEndClick(); }
              finally { avatarEnding = false; }
            },
          });
        } catch (e) {
          uiLog.warn('Countdown start failed', e);
        }
        // Fallback hard-stop in case countdown onExpire doesn't fire (or is ignored for happyhour)
        armAvatarHardStop(durationSec * 1000);

        setStatus(mic ? 'Listening…' : 'Muted');
        setBtnRecordingUI(mic);
        setMicIndicator(mic);
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
      setMicIndicator(!!next);
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

// --- Minimal PTT (Space toggles mic ON/OFF; Avatar mode only) ---
let PTT_BOUND = false;
let PTT_ACTIVE = false;

let PTT_ENABLED = false;

function readPTTFromDOM(): boolean {
  const el = document.getElementById('pttToggle') as HTMLInputElement | null;
  return !!el?.checked;
}
function setPTTDisabled(disabled: boolean): void {
  const el = document.getElementById('pttToggle') as HTMLInputElement | null;
  if (el) el.disabled = disabled;
}

function isTypingTarget(el: EventTarget | null): boolean {
  const n = el as HTMLElement | null;
  if (!n) return false;
  const tag = (n.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || (n as any).isContentEditable === true;
}

function togglePTT(): void {
  // Only when PTT is enabled and Avatar is connected; never in gpt-realtime mode
  if (!PTT_ENABLED) return;
  if (!isAvatarMode() || !avatarConnected) return;
  PTT_ACTIVE = !PTT_ACTIVE;
  try { setAnnieMic(PTT_ACTIVE); } catch { }
  setBtnRecordingUI(PTT_ACTIVE);
  setStatus(PTT_ACTIVE ? 'Listening…' : 'Muted');
  setMicIndicator(PTT_ACTIVE);
}

function bindPTTOnce(): void {
  if (PTT_BOUND) return;
  PTT_BOUND = true;
  // Capture early and block default Space behavior so it cannot "click" focused buttons
  window.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!PTT_ENABLED) return;
    if ((e.code === 'Space' || e.key === ' ') && !e.repeat) {
      // Ignore while typing in inputs/textareas/contentEditable
      if (isTypingTarget(e.target)) return;
      const t = e.target as HTMLElement | null;
      // If a control has focus (buttons/links), blur so Space won't activate it
      if (t && (t.tagName === 'BUTTON' || t.getAttribute('role') === 'button' || (+t.getAttribute('tabindex')! >= 0))) {
        try { t.blur(); } catch { }
      }
      e.preventDefault();
      e.stopPropagation();
      // Some frameworks attach additional listeners; be extra safe
      // @ts-ignore
      if (typeof (e as any).stopImmediatePropagation === 'function') (e as any).stopImmediatePropagation();
      togglePTT();
    }
  }, { passive: false, capture: true });
}
// --- End PTT ---

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
  bindPTTOnce();

  // PTT initial state and listener
  PTT_ENABLED = readPTTFromDOM(); // default: unchecked => auto-mic ON
  const pttEl = document.getElementById('pttToggle') as HTMLInputElement | null;
  if (pttEl) {
    pttEl.addEventListener('change', () => {
      PTT_ENABLED = !!pttEl.checked;
    });
  }

  // Mark when a live session starts so we can evaluate only the latest run and tag with a run id
  document.addEventListener('session:start', () => {
    setPTTDisabled(true);
    // Hide stats page when a new live session begins
    document.getElementById('statsPage')?.classList.add('hidden');
    // Start each session with a clean slate
    clearMemory();
    saveMemory();
    clearChat();
    renderHistory(memory);

    // Reset stats window and force a fresh run id
    statsStartIndex = 0;
    currentRunId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    setDefaultRunId(currentRunId);
    try {
      ensureLivePane();
      renderLiveTranscript([]);
    } catch { }
    // Countdown is now started only after avatar role-play is primed
  });

  // Live transcript: update on memory appends (emitted by annie.ts)
  document.addEventListener('memory:append', () => {
    try {
      ensureLivePane();
      renderLiveTranscript(memory.messages || []);
    } catch (e) {
      uiLog.debug('live transcript update error: %o', e);
    }
  });

  // Live transcript events coming from annie.ts (bubbled & composed)
  document.addEventListener('live:message', () => {
    try {
      ensureLivePane();
      renderLiveTranscript(memory.messages || []);
    } catch (e) {
      uiLog.debug('live:message render error: %o', e);
    }
  });

  document.addEventListener('live:reset', () => {
    try {
      ensureLivePane();
      renderLiveTranscript([]);
    } catch (e) {
      uiLog.debug('live:reset error: %o', e);
    }
  });

  document.addEventListener('live:end', () => {
    try {
      destroyLivePane();
    } catch (e) {
      uiLog.debug('live:end error: %o', e);
    }
  });

  // Close (X) on avatar → stop media and show results (support two possible IDs)
  ['avatarClose', 'endAvatar'].forEach(id => {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (!el) return;
    el.addEventListener('click', async () => {
      if (el.disabled) return;
      el.disabled = true;
      try { await handleAvatarEndClick(); }
      finally { setTimeout(() => { el.disabled = false; }, 600); }
    });
  });

  // Also react to a generic session:end if fired elsewhere
  document.addEventListener('session:end', () => {
    try { clearAvatarHardStop(); } catch { }
    // Reset avatar/PTT state first to avoid stray toggles
    PTT_ACTIVE = false;
    avatarConnected = false;
    setPTTDisabled(false);
    try { setAnnieMic(false); } catch { }
    try { stopCountdown(); } catch { }
    endAllSessions();
    try { destroyLivePane(); } catch { }
    try { destroyMicIndicator(); } catch { }
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

  // (Manual Avatar connect/disconnect/send buttons removed; sole connection path is auto-connect.)
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
            instructions: systemPromptForScenario(),
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
      instructions: systemPromptForScenario(),
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
  try { stopCountdown(); } catch { }
  try { endAllSessions(); } catch { }

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
  try { stopCountdown(); } catch { }
  try { clearAvatarHardStop(); } catch { }
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