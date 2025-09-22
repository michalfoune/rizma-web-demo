import { state } from '../state/appState';
import { getEl, maybeEl, setText, setVisible } from './dom';

export type ControlsCallbacks = {
  /** Called when we need to bring up the realtime session (mic + PC + SDP). */
  onConnect: () => Promise<void> | void;
  /** Called when user toggles mic. You'll receive the desired next recording state. */
  onToggleMic: (nextRecording: boolean) => Promise<void> | void;
  /** Called when user ends the session (×). Should tear down PC/DC/mic. */
  onEnd: () => void;
  /** Optional: called when the Reset button is pressed. */
  onReset?: () => void;
};

/** Compute the label shown on the controls. */
function labelFor(rec: boolean, started: boolean): string {
  if (!state.isConnected) return 'Start Voice Session';
  if (rec) return 'Stop Recording';
  return started ? 'Continue Recording' : 'Start Voice Session';
}

/**
 * Update the main control UI to reflect recording/idle state.
 * If `opts.started` is omitted, we fall back to state.hasSessionStarted (if present) or false.
 */
export function setBtnRecordingUI(rec: boolean, opts?: { started?: boolean }) {
  const btn = getEl('hold');
  const micFab = maybeEl('micFab');

  const started = opts?.started ?? (state as any).hasSessionStarted ?? false;
  const label = labelFor(rec, started);

  btn.setAttribute('aria-pressed', rec ? 'true' : 'false');
  btn.setAttribute('aria-label', label);
  btn.title = label;

  // Hidden primary button still gets tinted for consistency (not visible in your UI)
  (btn as HTMLButtonElement).style.background = rec ? '#F7C2B0' : '#FBD5C7';

  if (micFab) {
    micFab.setAttribute('aria-label', label);
    micFab.title = label;
    // While recording, force peach; when idle, clear to let CSS apply default gray + hover
    micFab.style.background = rec ? '#F7C2B0' : '';
  }
}

/** Toggle between transcript panel and composer row. */
export function showSessionUI(active: boolean) {
  setVisible('panel', active);
  setVisible('composer', !active, 'flex');
}

/** Convenience: set the tiny status text. */
export function setStatus(text: string) {
  setText('status', text);
}

/**
 * Bind all UI controls once.
 * - Click the hidden primary button (#hold) or micFab to connect/toggle mic.
 * - Space/Enter also toggles.
 * - End (×) calls onEnd and flips UI back to composer.
 * - Optional Reset button calls onReset.
 */
export function bindControls(cb: ControlsCallbacks) {
  const btn = getEl('hold');
  const micFab = maybeEl('micFab');
  const endBtn = maybeEl('endSession');
  const resetBtn = maybeEl('reset');

  // Primary click: connect (first) or toggle mic
  btn.addEventListener('click', async (e) => {
    e.preventDefault();

    // Avoid duplicate handshakes
    if (!state.isConnected) {
      if (state.isConnecting) return;
      await cb.onConnect();
      // Consider the session started after first connect/talk
      (state as any).hasSessionStarted = true;
      setBtnRecordingUI(true, { started: true });
      return;
    }

    // Toggle mic within a live session
    const next = !state.isRecording;
    await cb.onToggleMic(next);
    setBtnRecordingUI(next, { started: true });
  });

  // Mirror mic waveform button to primary
  if (micFab) {
    micFab.addEventListener('click', (e) => {
      e.preventDefault();
      btn.click();
    });
  }

  // Keyboard accessibility: Space / Enter
  document.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Spacebar' || e.key === 'Enter') {
      e.preventDefault();
      btn.click();
    }
  });

  // End session (×)
  if (endBtn) {
    endBtn.addEventListener('click', (e) => {
      e.preventDefault();
      cb.onEnd();
      showSessionUI(false);
      setBtnRecordingUI(false, { started: true });
      setStatus('Idle');
    });
  }

  // Optional Reset (clears memory/UI)
  if (resetBtn && cb.onReset) {
    resetBtn.addEventListener('click', (e) => {
      e.preventDefault();
      cb.onReset!();
      showSessionUI(false);
      setBtnRecordingUI(false, { started: false });
      setStatus('Idle');
    });
  }
}