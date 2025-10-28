import HeapArray from '../wasm/HeapArray'
import { RealtimePitchShift } from './RealtimePitchShift'
import { RubberBandModule, RealtimeRubberBand as RealtimeRubberBandKernel } from './RubberBandModule'

const RENDER_QUANTUM_FRAMES = 128

interface RealtimeRubberBandOptions {
  highQuality?: boolean,
  pitch?: number,
  tempo?: number
}

class RealtimeRubberBand implements RealtimePitchShift {
  private readonly _highQuality: boolean
  private readonly _channelCount: number
  private readonly _kernel: RealtimeRubberBandKernel
  private readonly _inputArray: HeapArray
  private readonly _outputArray: HeapArray
  private _tempo: number = 1
  private _pitch: number = 1
  private _hasProcessedAudio: boolean = false
  private _debugPulls: number = 0
  private _debugPitchSetters: number = 0
  private readonly _debugLimit: number = 0 // Disabled for production

  public constructor(
    module: RubberBandModule,
    sampleRate: number,
    channelCount: number,
    options?: RealtimeRubberBandOptions
  ) {
    this._highQuality = options?.highQuality || false
    this._channelCount = channelCount
    this._kernel = new module.RealtimeRubberBand(sampleRate, this._channelCount, this._highQuality)
    this._kernel.setMaxProcessSize(RENDER_QUANTUM_FRAMES)
    this._inputArray = new HeapArray(module, RENDER_QUANTUM_FRAMES, channelCount)
    this._outputArray = new HeapArray(module, RENDER_QUANTUM_FRAMES, channelCount)
    this._pitch = options?.pitch || 1
    this._tempo = options?.tempo || 1

    // Apply initial settings to kernel
    // Set initial tempo (inverted for RubberBand)
    if (options?.tempo && options.tempo !== 1) {
      this._kernel.setTempo(1 / options.tempo)
    }
    // Set initial pitch (direct value for RubberBand)
    if (options?.pitch && options.pitch !== 1) {
      this._kernel.setPitch(options.pitch)
    }

    // Prime the FFT buffers with silence to avoid harsh artifacts
    // when pitch is shifted UP before any audio has flowed through.
    // Only needed for pitch > 1.0 (upward transposition); downward shift doesn't exhibit the artifact.
    if (options?.pitch && options.pitch > 1.0) {
      this.primeBuffers()
    }
  }

  get timeRatio(): number {
    return this._tempo
  }

  set timeRatio(timeRatio: number) {
    // RubberBand's timeRatio is the inverse of playback speed:
    // - playbackSpeed 1.25 (faster) → timeRatio 0.8 (compress to 80% duration)
    // - playbackSpeed 0.8 (slower) → timeRatio 1.25 (stretch to 125% duration)
    this._tempo = timeRatio
    this._kernel.setTempo(1 / timeRatio)
  }

  public set pitchScale(pitch: number) {
    const previousPitch = this._pitch
    this._pitch = pitch
    // Prime buffers if this is the first time we're setting an UPWARD pitch shift
    // and we haven't processed any audio yet. Only needed for pitch > 1.0.
    if (!this._hasProcessedAudio && previousPitch <= 1.0 && pitch > 1.0) {
      this._kernel.setPitch(pitch)
      this.primeBuffers()
    } else {
      this._kernel.setPitch(pitch)
    }
  }

  public get samplesAvailable(): number {
    return this._kernel?.getSamplesAvailable() || 0
  }

  public push(channels: Float32Array[], numSamples?: number) {
    const channelCount = channels.length
    if (channelCount > 0) {
      // Check if this is real audio (not silence)
      // We check the first channel's first few samples to detect non-silence
      if (!this._hasProcessedAudio && channels[0]) {
        for (let i = 0; i < Math.min(10, channels[0].length); i++) {
          if (channels[0][i] !== 0) {
            this._hasProcessedAudio = true
            break
          }
        }
      }

      for (let channel = 0; channel < channelCount; ++channel) {
        this._inputArray.getChannelArray(channel).set(channels[channel])
      }
      this._kernel.push(this._inputArray.getHeapAddress(), numSamples || RENDER_QUANTUM_FRAMES)
    }
  }

  public pushSlice(channels: Float32Array[], start: number, end: number) {
    const len = end - start
    if (len > RENDER_QUANTUM_FRAMES) {
      throw new Error(`Part is larger than number of samples: ${len} > ${RENDER_QUANTUM_FRAMES}`)
    }
    const channelCount = channels.length
    if (channelCount > 0) {
      for (let channel = 0; channel < channelCount; ++channel) {
        this._inputArray.getChannelArray(channel).set(channels[channel].slice(start, end))
      }
      this._kernel.push(this._inputArray.getHeapAddress(), len)
    }
  }

  public pull(channels: Float32Array[]): Float32Array[] {
    const channelCount = channels.length
    if (channelCount > 0) {
      const outputLength = channels[0].length

      // Always clear outputs first to avoid any dry pass-through when the kernel underruns
      for (let channel = 0; channel < channelCount; ++channel) {
        channels[channel].fill(0)
      }

      const available = this._kernel.getSamplesAvailable()
      const toPull = Math.min(available, outputLength)

      if (toPull > 0) {
        this._kernel.pull(this._outputArray.getHeapAddress(), toPull)
        for (let channel = 0; channel < channels.length; ++channel) {
          // Write the processed portion at the start of the output buffer
          channels[channel].set(this._outputArray.getChannelArray(channel).subarray(0, toPull))
        }
      }
    }
    return channels
  }

  public get version(): number {
    return this._kernel.getVersion()
  }

  public get channelCount(): number {
    return this._channelCount
  }

  public get highQuality(): boolean {
    return this._highQuality
  }

  /**
   * Prime the internal FFT buffers with silence to avoid artifacts
   * when pitch shifting is applied before any audio has been processed.
   * This solves the "harsh beep" issue when pitching up on first playback.
   */
  private primeBuffers(): void {
    // Store the current flag state to restore after priming
    const wasProcessed = this._hasProcessedAudio

    // Push enough silent frames to prime the FFT buffers
    // RubberBand needs its internal FFT windows fully populated before producing output.
    // With typical FFT sizes of 2048-4096 samples, we need substantial priming.
    // Push 32 passes (4096 samples @ 44.1kHz = ~93ms) to ensure buffers are stabilized
    const primingPasses = 32

    for (let i = 0; i < primingPasses; i++) {
      // Push silence directly to kernel to avoid triggering hasProcessedAudio
      for (let channel = 0; channel < this._channelCount; ++channel) {
        this._inputArray.getChannelArray(channel).fill(0)
      }
      this._kernel.push(this._inputArray.getHeapAddress(), RENDER_QUANTUM_FRAMES)

      // Pull and discard any output to advance the internal state
      const discardOutput: Float32Array[] = []
      for (let channel = 0; channel < this._channelCount; ++channel) {
        discardOutput.push(new Float32Array(RENDER_QUANTUM_FRAMES))
      }
      this.pull(discardOutput)
    }

    // Restore the flag state
    this._hasProcessedAudio = wasProcessed
  }
}

export { RealtimeRubberBand }
