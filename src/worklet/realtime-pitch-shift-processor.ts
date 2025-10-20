import { RealtimeRubberBand } from './RealtimeRubberBand'
import * as createModule from '../../wasm/build/rubberband'
import { RubberBandModule } from './RubberBandModule'

// Inline logger for worklet context (can't import from src/utils)
// Webpack's DefinePlugin will replace NODE_ENV at build time
// @ts-ignore - NODE_ENV is defined by webpack at build time
const isDev = typeof NODE_ENV === 'undefined' || NODE_ENV !== 'production'
const noop = () => {}
const logger = {
  log: isDev ? console.log.bind(console) : noop,
  warn: isDev ? console.warn.bind(console) : noop,
  error: isDev ? console.error.bind(console) : noop,
  info: isDev ? console.info.bind(console) : noop
}

class RealtimePitchShiftProcessor extends AudioWorkletProcessor {
  private _module: RubberBandModule | undefined
  private _api: RealtimeRubberBand | undefined
  private running: boolean = true
  private pitch: number = 1
  private tempo: number = 1
  private highQuality: boolean = false

  // AudioParam descriptors for sample-accurate automation
  static get parameterDescriptors() {
    return [
      {
        name: 'pitchScale',
        defaultValue: 1.0,
        minValue: 0.5,
        maxValue: 2.0,
        automationRate: 'k-rate' // Control rate (per 128-sample block)
      },
      {
        name: 'tempo',
        defaultValue: 1.0,
        minValue: 0.5,
        maxValue: 2.0,
        automationRate: 'k-rate'
      }
    ]
  }

  constructor() {
    super()
    this.port.onmessage = (e) => {
      const data = JSON.parse(e.data)
      const event = data[0] as string
      const payload = data[1]
      // Removed spammy port.onmessage log - too frequent
      switch (event) {
        case 'pitch': {
          this.pitch = payload
          if (this._api)
            this._api.pitchScale = this.pitch
          break
        }
        case 'quality': {
          this.highQuality = payload
          break
        }
        case 'tempo': {
          this.tempo = payload
          if (this._api)
            this._api.timeRatio = this.tempo
          break
        }
        case 'close': {
          this.close()
          break
        }
      }
    }
    // Create module with onRuntimeInitialized callback
    const self = this

    createModule({
      onRuntimeInitialized: function() {
        // 'this' refers to the module in Emscripten callbacks
        const module = this as RubberBandModule

        // Check for our actual C++ class bindings
        const hasRequiredExports =
          typeof module.RealtimeRubberBand === 'function' &&
          typeof module.RubberBandAPI === 'function'

        // If HEAPF32 doesn't exist but we have memory, create heap views manually
        if (!module.HEAPF32 && (module as any).buffer) {
          const buffer = (module as any).buffer
          module.HEAP8 = new Int8Array(buffer)
          module.HEAPU8 = new Uint8Array(buffer)
          module.HEAP16 = new Int16Array(buffer)
          module.HEAPU16 = new Uint16Array(buffer)
          module.HEAP32 = new Int32Array(buffer)
          module.HEAPU32 = new Uint32Array(buffer)
          module.HEAPF32 = new Float32Array(buffer)
          module.HEAPF64 = new Float64Array(buffer)
        }

        if (hasRequiredExports) {
          self._module = module
          // Removed verbose WASM initialization logs for production
        } else {
          logger.error('[RubberBand WASM] ❌ Required embind classes not found!')
          const keys = Object.keys(module)
          logger.error('[RubberBand WASM] Available keys:', keys.join(', '))
        }
      }
    } as any)
      .then((module) => {
        // Module loaded successfully
      })
      .catch((err) => {
        logger.error('[RubberBand WASM] Failed to load module:', err)
      })
  }

  getApi(channelCount: number): RealtimeRubberBand | undefined {
    if (this._module) {
      if (
        !this._api ||
        this._api.channelCount !== channelCount ||
        this._api.highQuality !== this.highQuality
      ) {
        this._api = new RealtimeRubberBand(this._module, sampleRate, channelCount, {
          highQuality: this.highQuality,
          pitch: this.pitch,
          tempo: this.tempo
        })

        // Emit processorReady event so main thread can re-apply current audio parameters
        // This is critical after seek operations that trigger processor recreation
        this.port.postMessage(JSON.stringify(['processorReady', {
          pitch: this.pitch,
          tempo: this.tempo,
          timestamp: currentTime
        }]))
      }
    } else {
      logger.warn('[RubberBand WASM] Module not yet loaded, skipping audio processing')
    }
    return this._api
  }

  close() {
    this.port.onmessage = null
    this.running = false
  }

  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean {
    const numChannels = inputs[0]?.length || outputs[0]?.length

    // Use port-updated fields as the single source of truth
    const pitchScale = this.pitch
    const tempo = this.tempo
    if (this._api) {
      this._api.pitchScale = pitchScale
      this._api.timeRatio = tempo
    }

    if (numChannels > 0) {
      const api = this.getApi(numChannels)
      if (api) {
        // Push input
        if (inputs?.length > 0 && inputs[0].length > 0) {
          const inputLength = inputs[0][0].length
          api.push(inputs[0], inputLength)
        }

        // Prepare outputs: zero-fill, then let API overwrite available portion
        if (outputs?.length > 0 && outputs[0].length > 0) {
          const chans = outputs[0]
          for (let c = 0; c < chans.length; c++) chans[c].fill(0)
          // Always call pull; implementation will copy only what is available
          api.pull(outputs[0])
        }
      }
    }
    return this.running
  }
}

registerProcessor('realtime-pitch-shift-processor', RealtimePitchShiftProcessor)