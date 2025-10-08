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
    // Set initial tempo (inverted for RubberBand)
    if (options?.tempo && options.tempo !== 1) {
      this._kernel.setTempo(1 / options.tempo)
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
    this._pitch = pitch
    this._kernel.setPitch(pitch)
  }

  public get samplesAvailable(): number {
    return this._kernel?.getSamplesAvailable() || 0
  }

  public push(channels: Float32Array[], numSamples?: number) {
    const channelCount = channels.length
    if (channelCount > 0) {
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
      const available = this._kernel.getSamplesAvailable()
      const outputLength = channels[0].length
      const toPull = Math.min(available, outputLength)
      if (toPull > 0) {
        this._kernel.pull(this._outputArray.getHeapAddress(), toPull)
        for (let channel = 0; channel < channels.length; ++channel) {
          channels[channel].set(this._outputArray.getChannelArray(channel).subarray(0, toPull))
        }
      }
      // No zero-fill fallback - proper priming should ensure we always have samples available
      // If underrun occurs, it indicates insufficient priming or incorrect buffer management
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
}

export { RealtimeRubberBand }