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

  constructor() {
    super()
    this.port.onmessage = (e) => {
      const data = JSON.parse(e.data)
      const event = data[0] as string
      const payload = data[1]
      logger.log('port.onmessage', event, payload)
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
        logger.info('[RubberBand WASM] Runtime initialized, checking embind exports...')

        // Check for our actual C++ class bindings
        const hasRequiredExports =
          typeof module.RealtimeRubberBand === 'function' &&
          typeof module.RubberBandAPI === 'function'

        logger.info('[RubberBand WASM] RealtimeRubberBand available:', typeof module.RealtimeRubberBand === 'function')
        logger.info('[RubberBand WASM] RubberBandAPI available:', typeof module.RubberBandAPI === 'function')
        logger.info('[RubberBand WASM] _malloc available:', typeof module._malloc === 'function')
        logger.info('[RubberBand WASM] HEAPF32 available:', !!module.HEAPF32)

        // Dump ALL module properties to find memory
        logger.info('[RubberBand WASM] ALL module keys:', Object.keys(module).join(', '))
        logger.info('[RubberBand WASM] module.asm:', !!(module as any).asm)
        if ((module as any).asm) {
          logger.info('[RubberBand WASM] asm keys:', Object.keys((module as any).asm).join(', '))
          logger.info('[RubberBand WASM] asm.memory:', !!((module as any).asm as any).memory)
          if (((module as any).asm as any).memory) {
            const memory = ((module as any).asm as any).memory
            logger.info('[RubberBand WASM] memory type:', memory.constructor.name)
            logger.info('[RubberBand WASM] memory.buffer:', !!(memory as any).buffer)
          }
        }

        // If HEAPF32 doesn't exist but we have memory, create heap views manually
        if (!module.HEAPF32 && (module as any).buffer) {
          logger.info('[RubberBand WASM] Creating heap views manually from buffer...')
          const buffer = (module as any).buffer
          module.HEAP8 = new Int8Array(buffer)
          module.HEAPU8 = new Uint8Array(buffer)
          module.HEAP16 = new Int16Array(buffer)
          module.HEAPU16 = new Uint16Array(buffer)
          module.HEAP32 = new Int32Array(buffer)
          module.HEAPU32 = new Uint32Array(buffer)
          module.HEAPF32 = new Float32Array(buffer)
          module.HEAPF64 = new Float64Array(buffer)
          logger.info('[RubberBand WASM] Heap views created, HEAPF32 length:', module.HEAPF32.length)
        }

        if (hasRequiredExports) {
          self._module = module
          logger.info('[RubberBand WASM] ✅ Module ready - embind classes available')
        } else {
          logger.error('[RubberBand WASM] ❌ Required embind classes not found!')
          const keys = Object.keys(module)
          logger.error('[RubberBand WASM] Available keys:', keys.join(', '))
        }
      }
    } as any)
      .then((module) => {
        logger.info('[RubberBand WASM] Module promise resolved')
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
        logger.info('[RubberBand WASM] Creating RealtimeRubberBand API...')
        logger.info('[RubberBand WASM] Module _malloc type:', typeof this._module._malloc)
        this._api = new RealtimeRubberBand(this._module, sampleRate, channelCount, {
          highQuality: this.highQuality,
          pitch: this.pitch,
          tempo: this.tempo
        })
        logger.info(`RubberBand engine version ${this._api.version}`)
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

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const numChannels = inputs[0]?.length || outputs[0]?.length
    if (numChannels > 0) {
      const api = this.getApi(numChannels)
      if (api) {
        // Push input if available
        if (inputs?.length > 0 && inputs[0].length > 0) {
          const inputLength = inputs[0][0].length
          api.push(inputs[0], inputLength)
        }

        // Pull output if available
        // With element.playbackRate handling tempo and RubberBand only doing pitch correction,
        // input/output rates are matched (no time-stretching), so simple pull is sufficient
        if (outputs?.length > 0 && outputs[0].length > 0) {
          api.pull(outputs[0])
        }
      }
    }
    return this.running
  }
}

registerProcessor('realtime-pitch-shift-processor', RealtimePitchShiftProcessor)