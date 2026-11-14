class PcmRecorder extends AudioWorkletProcessor {
  // Bound each recording to the longest configured round and use 16 kHz mono for speech.
  constructor() {
    super();
    this.recording = false;
    this.samples = new Int16Array(4096);
    this.length = 0;
    this.total = 0;
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
    this.port.onmessage = ({ data }) => {
      this.recording = data === 'record';
      if (data === 'finish') {
        this.flush();
        this.port.postMessage('finished');
      }
    };
  }

  flush() {
    if (!this.length) return;
    const buffer = this.samples.slice(0, this.length).buffer;
    this.port.postMessage(buffer, [buffer]);
    this.length = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!this.recording || !input) return true;
    for (const sample of input) {
      if (this.total >= 16_000 * 300) break;
      this.sum += sample;
      this.count++;
      this.phase += 16_000;
      if (this.phase < sampleRate) continue;
      this.phase -= sampleRate;
      const clamped = Math.min(1, Math.max(-1, this.sum / this.count));
      this.samples[this.length++] = clamped * (clamped < 0 ? 32768 : 32767);
      this.total++;
      this.count = 0;
      this.sum = 0;
      if (this.length === this.samples.length) this.flush();
    }
    return true;
  }
}

registerProcessor('echo-pcm-recorder', PcmRecorder);
