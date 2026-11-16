const SAMPLE_RATE = 24000;
// Wait for a small amount of audio before starting. This covers the gap
// between Qwen audio deltas without the audible start delay of the old 0.75s
// WAV segments.
const INITIAL_BUFFER_SECONDS = 0.35;
const START_LEAD_SECONDS = 0.08;

interface SinkableAudioContext extends AudioContext {
  setSinkId?: (id: string) => Promise<void>;
}

/**
 * Gapless PCM player backed by a single AudioContext.
 *
 * The old WavStreamPlayer created a new <audio> element for every 0.75s of
 * audio, which produced clicks and short gaps at segment boundaries. Scheduling
 * AudioBufferSourceNodes back-to-back on one context removes those boundaries.
 */
export class WebAudioStreamPlayer {
  private readonly onIdle: () => void;
  private readonly onError: (error: unknown) => void;
  private readonly onSegmentStart?: (
    pcm16: Int16Array,
    startedAt: number,
  ) => void;

  private context: SinkableAudioContext | null = null;
  private gain: GainNode | null = null;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private pending: Int16Array[] = [];
  private pendingSamples = 0;
  private nextStartTime = 0;
  private outputDeviceId: string | null = null;
  private finished = false;
  private paused = false;
  private idleEmitted = false;
  private started = false;

  constructor(
    onIdle: () => void,
    onError: (error: unknown) => void,
    onSegmentStart?: (pcm16: Int16Array, startedAt: number) => void,
  ) {
    this.onIdle = onIdle;
    this.onError = onError;
    this.onSegmentStart = onSegmentStart;
  }

  get isActive(): boolean {
    return (
      this.pendingSamples > 0 || this.sources.size > 0 || this.started
    );
  }

  play(pcm16: Int16Array): void {
    if (this.finished || !pcm16.length) {
      return;
    }
    this.pending.push(pcm16.slice());
    this.pendingSamples += pcm16.length;
    this.started = true;

    const bufferedSeconds = this.pendingSamples / SAMPLE_RATE;
    if (
      bufferedSeconds >= INITIAL_BUFFER_SECONDS ||
      this.nextStartTime > 0
    ) {
      void this.pump();
    }
  }

  finish(): void {
    this.finished = true;
    void this.pump();
    this.maybeIdle();
  }

  pause(): void {
    if (this.paused) {
      return;
    }
    this.paused = true;
    void this.context?.suspend().catch(() => undefined);
  }

  resume(): void {
    if (!this.paused) {
      return;
    }
    this.paused = false;
    void this.context?.resume().then(() => this.pump()).catch(() => undefined);
  }

  stop(notifyIdle = true): void {
    const wasActive = this.isActive;
    this.finished = true;
    this.paused = false;
    if (!notifyIdle) {
      this.idleEmitted = true;
    }
    this.pending = [];
    this.pendingSamples = 0;
    this.nextStartTime = 0;
    this.started = false;
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // already stopped
      }
      source.disconnect();
    }
    this.sources.clear();
    const context = this.context;
    this.context = null;
    this.gain = null;
    if (context && context.state !== 'closed') {
      void context.close().catch(() => undefined);
    }
    if (wasActive && notifyIdle) {
      this.emitIdle();
    }
  }

  async setSinkId(deviceId: string): Promise<void> {
    this.outputDeviceId = deviceId;
    const context = await this.ensureContext();
    if (!context.setSinkId || !deviceId || deviceId === 'default') {
      return;
    }
    await context.setSinkId(deviceId);
  }

  private async ensureContext(): Promise<SinkableAudioContext> {
    if (this.context) {
      if (this.context.state === 'suspended' && !this.paused) {
        void this.context.resume().catch(() => undefined);
      }
      return this.context;
    }
    const context = new AudioContext() as SinkableAudioContext;
    this.context = context;
    this.gain = context.createGain();
    this.gain.gain.value = 1;
    this.gain.connect(context.destination);
    if (
      this.outputDeviceId &&
      this.outputDeviceId !== 'default' &&
      context.setSinkId
    ) {
      await context.setSinkId(this.outputDeviceId).catch(() => undefined);
    }
    if (context.state === 'suspended' && !this.paused) {
      await context.resume().catch(() => undefined);
    }
    return context;
  }

  private async pump(): Promise<void> {
    if (this.paused || this.finished && this.pendingSamples === 0) {
      this.maybeIdle();
      return;
    }
    if (this.pendingSamples === 0) {
      this.maybeIdle();
      return;
    }
    const context = await this.ensureContext();
    if (this.paused) {
      return;
    }

    // Schedule all currently buffered PCM as one contiguous block. AudioBuffer
    // is created at 24kHz and the context resamples to its native rate.
    const samples = new Int16Array(this.pendingSamples);
    let offset = 0;
    for (const chunk of this.pending) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    this.pending = [];
    this.pendingSamples = 0;

    const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) {
      channel[i] = samples[i] / 0x8000;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain!);
    const now = context.currentTime;
    const startAt = Math.max(now + START_LEAD_SECONDS, this.nextStartTime);
    if (now > this.nextStartTime && this.nextStartTime > 0) {
      console.warn('[cyrvis] audio underrun', {
        gapMs: Math.round((now - this.nextStartTime) * 1000),
      });
    }
    this.nextStartTime = startAt + buffer.duration;

    const startedAt = Date.now() + (startAt - now) * 1000;
    this.onSegmentStart?.(samples, startedAt);

    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      source.disconnect();
      if (this.finished && this.pendingSamples === 0 && this.sources.size === 0) {
        this.maybeIdle();
      }
    };

    try {
      source.start(startAt);
    } catch (error) {
      this.sources.delete(source);
      this.onError(error);
    }

    // If more deltas arrived while awaiting the context/buffer allocation,
    // schedule them immediately after this block.
    if (this.pendingSamples > 0) {
      void this.pump();
    }
  }

  private maybeIdle(): void {
    if (!this.finished || this.pendingSamples > 0 || this.sources.size > 0) {
      return;
    }
    if (this.nextStartTime > 0 && this.context) {
      const remaining = this.nextStartTime - this.context.currentTime;
      if (remaining > 0.01) {
        return;
      }
    }
    this.emitIdle();
  }

  private emitIdle(): void {
    if (this.idleEmitted) {
      return;
    }
    this.idleEmitted = true;
    this.onIdle();
  }
}
