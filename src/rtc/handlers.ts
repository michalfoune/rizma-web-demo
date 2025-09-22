// src/rtc/handlers.ts
// Pure Realtime event handler (no DOM). You inject tiny callbacks from your app.

export type Sender = 'user' | 'elena';

export type HandlerDeps = {
  // UI-ish callbacks (provided by your app)
  setStatus: (text: string) => void;                 // e.g., setStatus('Listening...')
  setRecordingUI: (recording: boolean) => void;      // e.g., setBtnRecordingUI(true)

  // Chat log / memory (provided by your app)
  addMessage: (text: string, sender: Sender) => void;
  pushUser: (text: string) => void;                  // e.g., memory.messages.push({role:'user',content:text})
  pushAssistant: (text: string) => void;             // e.g., memory.messages.push({role:'assistant',content:text})
  saveMemory: () => void;

  // Transport / control
  getMicTrack: () => MediaStreamTrack | null;        // returns current mic track or null
  sendResponseCreate: () => void;                    // manual trigger when not using server VAD
  serverVAD: boolean;                                // true if server VAD is enabled
};

export function createRealtimeEventHandler(deps: HandlerDeps) {
  let assistantBuf = '';
  let responseRequested = false;

  return async function handleServerEvent(evt: any): Promise<void> {
    try {
      switch (evt?.type) {
        case 'input_audio_buffer.speech_started': {
          deps.setStatus('Listening...');
          responseRequested = false; // new user turn starting
          break;
        }

        case 'input_audio_buffer.speech_stopped': {
          deps.setStatus('Thinking...');
          if (!deps.serverVAD && !responseRequested) {
            deps.sendResponseCreate();
            responseRequested = true;
          }
          break;
        }

        case 'conversation.item.input_audio_transcription.completed': {
          const text =
            evt?.transcript ||
            evt?.text ||
            evt?.item?.input_audio_transcription?.text ||
            '';
          const clean = (text || '').trim();
          if (clean) {
            deps.addMessage(clean, 'user');
            deps.pushUser(clean);
            deps.saveMemory();
          }
          if (!deps.serverVAD && !responseRequested) {
            deps.sendResponseCreate();
            responseRequested = true;
          }
          break;
        }

        // Assistant partials (either stream may be present depending on session config)
        case 'response.audio_transcript.delta':
        case 'response.output_text.delta': {
          const d = (evt?.delta || '').toString();
          if (d) assistantBuf += d;
          break;
        }

        // Assistant finals
        case 'response.audio_transcript.done':
        case 'response.output_text.done':
        case 'response.done': {
          const explicit =
            (evt?.text || evt?.transcript || evt?.response?.output_text || '').toString().trim();
          const finalText = explicit || assistantBuf.trim();

          if (finalText) {
            deps.addMessage(finalText, 'elena');
            deps.pushAssistant(finalText);
            deps.saveMemory();
            assistantBuf = '';
          }

          deps.setStatus('Idle');

          // Re-enable mic for next user turn
          const track = deps.getMicTrack();
          if (track) track.enabled = true;

          deps.setRecordingUI(true);
          responseRequested = false;
          break;
        }

        case 'error': {
          console.error('Realtime error:', evt);
          deps.setStatus('Error');
          break;
        }

        default: {
          // Keep for diagnostics; safe to silence in production
          // console.debug('RT other', evt?.type, evt);
          break;
        }
      }
    } catch (err) {
      console.warn('handleServerEvent failed', err, evt);
    }
  };
}