import { state } from './state/appState';
import { memory, saveMemory, loadMemory, clearMemory } from './state/memory';
import { createPeerConnection, waitForIce } from './rtc/connection';
import { getEl, setText, setVisible, onDomReady } from './ui/dom';
import { bindControls, setBtnRecordingUI, setStatus } from './ui/controls';
import { showSessionUI } from './ui/dom';
import { addMessage, renderHistory, clearChat } from './ui/chatView';
import { wireDataChannel, sendTextAndRespond, sendResponseCreate } from './rtc/signaling';
import { attachRemoteAudio } from './rtc/audio';
import { log, setLevel, createLogger } from './utils/logger';
import { firstAudioTrack, isPCIceConnected } from './utils/guards';
import { connectAnnie, disconnectAnnie, sendAnnieUserMessage, setAnnieMic } from './integrations/annie';
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

// OpenAI key stays in Cloudflare Worker secret; browser calls proxy
const API_BASE = "https://rizma-proxy.rizma.workers.dev/openai";

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
// --- Types ---------------------------------------------------------------
/** Minimal shape for Realtime events so TS doesn't complain (we only switch on `type`). */
type RealtimeEvent = { type: string; [k: string]: any };

// --- Debug: remote audio & stats ---
function attachRemoteAudioDebug(el: HTMLMediaElement | null): void {
    if (!el) return;
    el.addEventListener('play', () => uiLog.debug('remoteAudio: play'));
    el.addEventListener('pause', () => uiLog.debug('remoteAudio: pause'));
    el.addEventListener('loadedmetadata', () => uiLog.debug('remoteAudio: loadedmetadata'));
}
async function startRtpStats(pc: RTCPeerConnection): Promise<void> {
    try {
        const sender = pc.getSenders().find(s => s.track && s.track.kind === 'audio');
        const receiver = pc.getReceivers().find(r => r.track && r.track.kind === 'audio');
        setInterval(async () => {
            if (sender) {
                const stats = await sender.getStats();
                for (const r of stats.values()) {
                    if (r.type === 'outbound-rtp') pcLog.debug('RTP out bytesSent: %d', r.bytesSent);
                }
            }
            if (receiver) {
                const stats = await receiver.getStats();
                for (const r of stats.values()) {
                    if (r.type === 'inbound-rtp') pcLog.debug('RTP in  bytesReceived: %d', r.bytesReceived);
                }
            }
        }, 2000);
    } catch (e) { pcLog.warn('stats error %o', e); }
}

// --- Conversation memory (rolling window + running summary persisted to localStorage) ---
const SYSTEM_PROMPT = "You are Elena, an empathetic supportive assistant. Be warm, validating, and concise. Default to 1–2 short sentences unless asked for detail. Avoid diagnoses and crisis guidance. Speak clearly and at a natural pace.";

const MEMORY_KEY = "rizma_memory_v1";
const MAX_TURNS_TO_SEND = 6; // send at most last 6 user+assistant exchanges (12 messages)


// Load from localStorage on startup and render any prior history
loadMemory();
renderHistory(memory);
// --- End conversation memory ---

// --- Adaptive controls: desktop = click/keyboard toggle; mobile = press-and-hold ---
// function setBtnRecordingUI(rec) {...}

bindControls({
    onConnect: async () => {
        // Route mic/waveform by selected radio: Avatar vs Realtime
        if (isAvatarMode()) {
            // If Realtime was active, cleanly disconnect first
            if (state.isConnected) {
                try { disconnectRealtime(); } catch {}
                showSessionUI(false);
            }

            // Switch UI to Avatar tab
            showTab('avatar');

            // Auto-connect the avatar using constants from config
            const token = Animato_Test_Token;
            const userId = Animato_UserID;
            const animatoId = Animato_ID;
            const mic = true; // start with mic enabled
            const root = document.getElementById('annieRoot') as HTMLElement | null;

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
                await connectAnnie({ token, userId, animatoId, mic, root, username: 'rizma', lang: 'en' });

                // Hide manual controls and show close (X)
                document.getElementById('annieControls')?.classList.add('hidden');
                document.getElementById('avatarClose')?.classList.remove('hidden');

                // Hide the composer/play bar and announce session start (hides scenarios via your listener)
                document.getElementById('composer')?.classList.add('hidden');
                document.dispatchEvent(new Event('session:start'));

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
        // Default: OpenAI Realtime
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
        const token = Animato_Test_Token;
        // const token = (document.getElementById('annieToken') as HTMLInputElement)?.value?.trim();
        const userId = Animato_UserID; // fixed for now; could be made user-editable
        const animatoId = Animato_ID; // fixed for now; could be made user-editable
        const mic = (document.getElementById('annieMic') as HTMLInputElement)?.checked ?? true;
        const root = document.getElementById('annieRoot') as HTMLElement | null;
        if (!token || !root) { console.warn('Avatar: missing token or root'); return; }
        try {
            await connectAnnie({ token, userId, animatoId, mic, root, username: 'rizma', lang: 'en' });
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

        // SDP exchange (same as you had)
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

async function handleServerEvent(evt: RealtimeEvent): Promise<void> {
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
            const text = evt?.transcript || evt?.text || evt?.item?.input_audio_transcription?.text || '';
            if (text?.trim()) {
                addMessage(text.trim(), 'user');
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
            const explicit = evt?.transcript || evt?.response?.output_text || '';
            const finalText = (explicit && explicit.trim()) || assistantBuf.trim();
            if (finalText) {
                addMessage(finalText, 'elena');
                memory.messages.push({ role: 'elena', content: finalText });
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
                memory.messages.push({ role: 'elena', content: finalText });
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