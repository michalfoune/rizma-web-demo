// src/rtc/audio.ts
// Audio helpers for OpenAI Realtime: attach a remote audio track to an <audio>
// and make sure it can actually play across browsers (Safari/iOS autoplay).

/**
 * Attach remote audio tracks from an RTCPeerConnection to a given <audio>.
 * Returns a cleanup function you can call on teardown.
 */
export function attachRemoteAudio(audioEl: HTMLAudioElement, pc: RTCPeerConnection): () => void {
  // Ensure an attached MediaStream
  let stream = audioEl.srcObject as MediaStream | null;
  if (!(stream instanceof MediaStream)) {
    stream = new MediaStream();
    audioEl.srcObject = stream;
  }

  // Prefer autoplay; we’ll still unlock via ensurePlayable() below
  audioEl.autoplay = true;
  audioEl.muted = false;
  audioEl.volume = Math.min(Math.max(audioEl.volume || 1, 0), 1);

  const onTrack = (e: RTCTrackEvent) => {
    if (e.track.kind !== 'audio') return;

    const s = audioEl.srcObject as MediaStream;
    const have = s.getTracks().some(t => t.id === e.track.id);
    if (!have) s.addTrack(e.track);

    // Try to start playback (may be rejected until a user gesture on iOS/Safari)
    void audioEl.play().catch(() => {/* will retry on gesture/canplay */});
  };

  pc.addEventListener('track', onTrack);

  // Also try to attach any already-present receiver tracks (e.g., if called after setRemoteDescription)
  pc.getReceivers()
    .filter(r => r.track && r.track.kind === 'audio')
    .forEach(r => {
      const s = audioEl.srcObject as MediaStream;
      const t = r.track!;
      if (!s.getTracks().some(x => x.id === t.id)) s.addTrack(t);
    });

  // Install autoplay unlock
  const removeUnlock = ensurePlayable(audioEl);

  return () => {
    pc.removeEventListener('track', onTrack);
    removeUnlock();

    // Detach tracks from the element's stream (do not stop remote tracks; the PC owns them)
    const s = audioEl.srcObject as MediaStream | null;
    if (s) s.getTracks().forEach(t => s.removeTrack(t));
    // Optionally pause/detach if you prefer:
    // audioEl.pause();
    // audioEl.srcObject = null;
  };
}

/**
 * Best-effort autoplay unlock for Safari/iOS and strict browsers.
 * Adds listeners that attempt audioEl.play() on canplay and on first user gesture.
 * Returns a cleanup function.
 */
export function ensurePlayable(audioEl: HTMLAudioElement): () => void {
  let unlocked = false;

  const tryPlay = () => {
    if (unlocked) return;
    audioEl.muted = false;
    audioEl.autoplay = true;
    void audioEl.play().then(() => { unlocked = true; }).catch(() => { /* keep waiting for gesture/canplay */ });
  };

  const onCanPlay = () => tryPlay();
  const onPlay = () => { unlocked = true; };

  audioEl.addEventListener('canplay', onCanPlay);
  audioEl.addEventListener('play', onPlay);

  // iOS/Safari: require a user gesture to allow playback
  const gestures = ['pointerdown', 'click', 'touchstart'] as const;
  const onGesture = () => {
    tryPlay();
    if (unlocked) gestures.forEach(ev => window.removeEventListener(ev, onGesture, true));
  };
  gestures.forEach(ev => window.addEventListener(ev, onGesture, true));

  return () => {
    audioEl.removeEventListener('canplay', onCanPlay);
    audioEl.removeEventListener('play', onPlay);
    gestures.forEach(ev => window.removeEventListener(ev, onGesture, true));
  };
}