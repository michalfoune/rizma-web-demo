const DEFAULT_STUN: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' }
];

export type PCHandlers = {
  onTrack?: (e: RTCTrackEvent) => void;
  onDataChannel?: (channel: RTCDataChannel) => void;
  onIceCandidate?: (c: RTCIceCandidate) => void;
  onState?: (pc: RTCPeerConnection) => void; // logs state changes
};

export function createPeerConnection(
  handlers: PCHandlers = {},
  iceServers: RTCIceServer[] = DEFAULT_STUN
): RTCPeerConnection {
  const pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 1 });

  // Events
  pc.ontrack = (e) => handlers.onTrack?.(e);
  pc.ondatachannel = (e) => handlers.onDataChannel?.(e.channel);
  pc.onicecandidate = (e) => { if (e.candidate) handlers.onIceCandidate?.(e.candidate); };

  const onState = () => handlers.onState?.(pc);
  pc.addEventListener('iceconnectionstatechange', onState);
  pc.addEventListener('connectionstatechange', onState);
  pc.addEventListener('signalingstatechange', onState);

  return pc;
}

export async function waitForIce(
  pc: RTCPeerConnection,
  timeoutMs: number = 3000
): Promise<'complete'|'timeout'> {
  if (pc.iceGatheringState === 'complete') return 'complete';
  return new Promise((resolve) => {
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', onChange);
        clearTimeout(t);
        resolve('complete');
      }
    };
    const t = setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      resolve('timeout');
    }, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}