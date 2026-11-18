import { newRequestId } from './client.ts';

export function trackListenerEngagement(roundId: string) {
  const visitId = newRequestId();
  const events = ['timeupdate', 'playing', 'pause', 'ended', 'seeking', 'seeked'];
  let audio: HTMLAudioElement | null = null;
  let position: number | null = null;
  let playbackMs = 0;
  let recordingAttempts = 0;
  let dwellMs = 0;
  let visibleSince = document.hidden ? null : performance.now();

  function samplePlayback(event?: Event) {
    if (!audio) return;
    const now = audio.currentTime;
    if (position !== null && !audio.seeking && event?.type !== 'seeked') {
      playbackMs += Math.max(0, now - position) * 1000;
    }
    position = audio.seeking || audio.paused || audio.ended ? null : now;
  }

  function attach(next: HTMLAudioElement | null) {
    if (audio === next) return;
    samplePlayback();
    for (const event of events) audio?.removeEventListener(event, samplePlayback);
    audio = next;
    position = null;
    if (!audio) return;
    for (const event of events) audio.addEventListener(event, samplePlayback);
    samplePlayback();
  }

  function send() {
    samplePlayback();
    const duration = visibleSince === null ? dwellMs : dwellMs + performance.now() - visibleSince;
    void fetch(`/api/rounds/${roundId}/listener-engagement`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
      body: JSON.stringify({
        visitId, playbackMs: Math.min(86_400_000, Math.floor(playbackMs)),
        recordingAttempts: Math.min(1000, recordingAttempts),
        dwellMs: Math.min(86_400_000, Math.floor(duration)),
      }),
    }).catch(() => undefined);
  }

  function visibility() {
    if (document.hidden && visibleSince !== null) {
      dwellMs += performance.now() - visibleSince;
      visibleSince = null;
      send();
    } else if (!document.hidden && visibleSince === null) {
      visibleSince = performance.now();
    }
  }

  const heartbeat = window.setInterval(send, 5000);
  document.addEventListener('visibilitychange', visibility);
  window.addEventListener('pagehide', send);
  return {
    attach,
    record() {
      recordingAttempts++;
      send();
    },
    close() {
      attach(null);
      send();
      window.clearInterval(heartbeat);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', send);
    },
  };
}
