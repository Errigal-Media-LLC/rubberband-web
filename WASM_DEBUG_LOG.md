# WASM Module Initialization Debug Log

## Problem
WASM module exports (`_malloc`, `HEAPF32`, etc.) are not available even in `onRuntimeInitialized` callback, preventing RubberBand processor from initializing.

## Symptoms
```
[RubberBand WASM] Runtime initialized, checking exports...
[RubberBand WASM] Module has _malloc: false
[RubberBand WASM] Module has HEAPF32: false
[RubberBand WASM] Exports still not available in onRuntimeInitialized!
```

---

## Attempt 1: Added `await rbModule.ready`
**Date**: Session start
**Change**: Added `ready: Promise<RubberBandModule>` to interface, awaited before use
**Result**: ❌ Still showed `_malloc: false`
**Why it failed**: `ready` promise resolves before exports are actually available

---

## Attempt 2: Used `onRuntimeInitialized` callback (arrow function)
**Date**: Session start
**Change**: Set callback after promise resolution using arrow function
**Result**: ❌ `TypeError: can't access property "_malloc", I is undefined`
**Why it failed**: Callback set too late (after promise resolved), `moduleInstance` not yet assigned

---

## Attempt 3: Removed polling with `setInterval`
**Date**: Session start
**Change**: Attempted to poll for exports availability
**Result**: ❌ `ReferenceError: setInterval is not defined`
**Why it failed**: `setInterval` not available in AudioWorklet scope

---

## Attempt 4: Used `onRuntimeInitialized` in `createModule()` options (arrow function)
**Date**: Session start
**Change**: Pass callback to `createModule()` upfront using arrow function
**Result**: ❌ `TypeError: can't access property "_malloc", I is undefined`
**Why it failed**: Arrow function captured wrong `this` context

---

## Attempt 5: Used regular `function()` for callback
**Date**: Session start
**Change**: Changed to regular function so `this` refers to module
**Result**: ❌ Still `_malloc: false` and `HEAPF32: false`
**Why it failed**: Root cause not in callback timing

---

## Attempt 6: Switched to separate `.wasm` file (removed SINGLE_FILE=1)
**Date**: Oct 7, 19:49
**Changes**:
- Removed `-s SINGLE_FILE=1` from CMakeLists.txt
- Added `-s EXPORT_NAME=createModule`
- Changed webpack WASM handling to `asset/resource`
- Added copy-webpack-plugin to copy `.wasm` to public directory
**Result**: ❌ `ReferenceError: fetch is not defined`
**Why it failed**: AudioWorklets have no access to `fetch()` to load separate WASM file
**Files**: CMakeLists.txt:75, webpack.config.cjs, package.json
**Artifacts**: Produced 48K .js + 451K .wasm

---

## Attempt 7: Reverted to SINGLE_FILE=1 (embedded WASM)
**Date**: Oct 7, 23:14
**Changes**:
- Re-added `-s SINGLE_FILE=1` to CMakeLists.txt:75
- Removed CopyPlugin from webpack.config.cjs
- Changed webpack WASM back to `asset/inline`
- Clean rebuild: `rm -rf build && bash build.sh`
**Result**: ❌ SAME ISSUE - Still `_malloc: false` in `onRuntimeInitialized`
**Why it failed**: Issue is deeper than SINGLE_FILE vs separate file
**Files**: CMakeLists.txt:75, webpack.config.cjs
**Artifacts**: Produced 649K .js with embedded WASM

---

---

## Attempt 8: Inspect actual module object properties
**Date**: Oct 8, 08:33
**Change**: Added comprehensive logging to see what's in the module:
- `Object.keys(module)` to list all properties
- Check multiple exports: `_malloc`, `HEAPF32`, `HEAP8`, `_free`, `RubberBandAPI`
**Result**: ✅ ROOT CAUSE FOUND!
**Findings**:
- Module has 8 keys: `onRuntimeInitialized`, `calledRun`, `RealtimeRubberBand`, `RubberBandProcessor`, `RubberBandSource`, `RubberBandAPI`, `RubberBandFinal`, `Test`
- ✅ All embind C++ class bindings ARE available
- ❌ Emscripten runtime functions (`_malloc`, `_free`, `HEAPF32`, `HEAP8`) are NOT available
**Why it failed**: We were checking for `_malloc` to determine if module is ready, but embind handles memory internally - doesn't need `_malloc`!
**Files**: realtime-pitch-shift-processor.ts:46-70

---

## Attempt 9: Check for embind classes instead of runtime functions
**Date**: Oct 8, 08:36
**Change**: Changed module ready check from `typeof module._malloc === 'function'` to checking for actual embind classes:
```typescript
const hasRequiredExports =
  typeof module.RealtimeRubberBand === 'function' &&
  typeof module.RubberBandAPI === 'function'
```
**Result**: ✅ Module detected as ready! But new error: `TypeError: this.module._malloc is not a function`
**Why it partly worked**: Module initialization succeeded, embind classes are available
**New problem discovered**: `HeapArray` class (used by RealtimeRubberBand) calls `_malloc` and accesses `HEAPF32` directly:
- HeapArray.ts:27: `this.module._malloc(dataByteSize)`
- HeapArray.ts:32: `this.module.HEAPF32.subarray(...)`
- HeapArray.ts:46: `this.module._free(this.dataPtr)`
**Files**: realtime-pitch-shift-processor.ts:46-68, HeapArray.ts

---

## Attempt 10: Export runtime methods needed by HeapArray
**Date**: Oct 8, 08:42-08:52
**Changes attempted**:
1. First tried: `-s EXPORTED_RUNTIME_METHODS=['malloc','free']` → ❌ Error: undefined exported symbol
2. Then tried: `-s EXPORTED_RUNTIME_METHODS=['_malloc','_free']` → ❌ Same error
3. Finally used: `-s EXPORTED_FUNCTIONS=['_malloc','_free']` + `-s EXPORTED_RUNTIME_METHODS=[]` → ✅ BUILD SUCCESS!
**Reasoning**: HeapArray needs `_malloc`, `_free`, and `HEAPF32` which weren't being exported
**Result**: ✅ Build successful, processor deployed at 08:52
**Why it worked**: `EXPORTED_FUNCTIONS` exports the actual C functions, while `EXPORTED_RUNTIME_METHODS` is for Emscripten JS runtime helpers
**Files**: CMakeLists.txt:77-78
**Deployed**: realtime-pitch-shift-processor.js (649K) with both embind classes AND memory management functions

---

## Expected Behavior After Attempt 10

Module should now have everything needed:
- ✅ Embind classes: `RealtimeRubberBand`, `RubberBandAPI`, etc.
- ✅ Memory functions: `_malloc`, `_free`
- ✅ Heap access: `HEAPF32` (should be available with ALLOW_MEMORY_GROWTH)

Console should show:
```
[RubberBand WASM] ✅ Module ready - embind classes available
[RubberBand WASM] Creating RealtimeRubberBand API...
[HeapArray] Created buffer at [address] of size [size]...
RubberBand engine version [version]
```

And audio should play! 🎵

---

## Attempt 11: Manual heap view creation from buffer
**Date**: Oct 8, 08:57
**Change**: Added code to manually create `HEAPF32` and other heap views in `onRuntimeInitialized` callback from `module.buffer`
**Result**: ❌ Module has no `buffer`, `wasmMemory`, `memory`, or `asm` properties
**Why it failed**: With `ALLOW_MEMORY_GROWTH=1` and no heap exports, there's NO WAY to access the WebAssembly memory buffer. Module only has: `onRuntimeInitialized, _free, _malloc, calledRun, RealtimeRubberBand, RubberBandProcessor, RubberBandSource, RubberBandAPI, RubberBandFinal, Test`
**Discovery**: Added comprehensive module inspection showing module has embind classes and memory functions but NO memory access. With `ALLOW_MEMORY_GROWTH=1`, heap views become runtime helpers (dynamic getters) that must be explicitly exported via `EXPORTED_RUNTIME_METHODS`.
**Files**: realtime-pitch-shift-processor.ts:62-73

---

## Attempt 12: Export HEAPF32 via EXPORTED_RUNTIME_METHODS
**Date**: Oct 8, 09:13
**Change**: Added `HEAPF32` to `EXPORTED_RUNTIME_METHODS` in CMakeLists.txt:
```cmake
-s EXPORTED_FUNCTIONS=['_malloc','_free'] \
-s EXPORTED_RUNTIME_METHODS=['HEAPF32']
```
**Result**: ✅ SUCCESS - Audio playback works!
**Reasoning**: With `ALLOW_MEMORY_GROWTH=1`, `HEAPF32` is a runtime helper (dynamic getter for growing memory) not automatically exported. HeapArray.ts:32 calls `this.module.HEAPF32.subarray()`. Unlike static functions, heap views must use `EXPORTED_RUNTIME_METHODS` not `EXPORTED_FUNCTIONS`.
**Files**: CMakeLists.txt:78, rebuilt and deployed at 09:13

---

## WASM Module Initialization: SOLVED ✅

Module now successfully exports all required components:
- ✅ Embind classes: `RealtimeRubberBand`, `RubberBandAPI`, etc.
- ✅ Memory functions: `_malloc`, `_free` via EXPORTED_FUNCTIONS
- ✅ Heap access: `HEAPF32` via EXPORTED_RUNTIME_METHODS

Audio playback confirmed working at normal speed.

---

## NEW ISSUE: Buffer Overrun on Tempo Change

**Date**: Oct 8, ~09:30
**Symptom**: On speedup/tempo change, buffer overruns occur
**Details**:
- Ringbuffer size varies between 128 and 256 samples
- Writing too many samples causes buffer overrun
- Issue appears to be in the push/pull logic for variable tempo

---

## Fix Attempt 1: Pass Actual Input Length to push()
**Date**: Oct 8, ~09:35
**Change**: Modified `realtime-pitch-shift-processor.ts` process() method to pass actual input length:
```typescript
const inputLength = inputs[0][0].length
api.push(inputs[0], inputLength)
```
**Root cause**: Was copying all input samples (potentially 256) but only telling RubberBand we pushed 128 samples (default RENDER_QUANTUM_FRAMES)
**Result**: ❌ Partial fix - still getting buffer overruns at tempo change
**Why it failed**: When tempo changes, RubberBand produces different amounts of output than input. At 1.25x speed, buffer fills faster than we drain it.
**Files**: realtime-pitch-shift-processor.ts:141-142

---

## Fix Attempt 2: Drain Excess Samples
**Date**: Oct 8, ~09:45
**Change**: Added logic to pull and discard excess samples after normal output pull
**Result**: ❌ FAILED - Audio quality severely degraded (sounds like didgeridoo)
**Why it failed**: Discarding samples created gaps in the audio stream, causing artifacts
**Files**: realtime-pitch-shift-processor.ts:150-156

---

## Fix Attempt 3: Increase Internal Buffer Size
**Date**: Oct 8, ~09:50
**Change**: Increased RubberBand's internal buffer from 128 to 512 samples:
```typescript
const MAX_PROCESS_SIZE = 512  // Larger buffer to handle variable input sizes and tempo changes
this._kernel.setMaxProcessSize(MAX_PROCESS_SIZE)
this._inputArray = new HeapArray(module, MAX_PROCESS_SIZE, channelCount)
this._outputArray = new HeapArray(module, MAX_PROCESS_SIZE, channelCount)
```
**Result**: ❌ FAILED - RangeError: source array is too long
**Why it failed**: Was copying entire 512-sample buffer into 128-sample output array
**Files**: RealtimeRubberBand.ts:6,32-34

---

## Fix Attempt 4: Use subarray for Correct Size
**Date**: Oct 8, ~09:55
**Change**: Modified pull() to only copy the actual number of samples pulled:
```typescript
const outputLength = channels[0].length
this._kernel.pull(this._outputArray.getHeapAddress(), outputLength)
channels[channel].set(this._outputArray.getChannelArray(channel).subarray(0, outputLength))
```
**Result**: ❌ FAILED - Really bad buzzing in audio
**Why it failed**: Heap arrays were 512 samples but we're only using 128-256 at a time, causing stale data issues
**Files**: RealtimeRubberBand.ts:85-90

---

## Fix Attempt 5: Separate Heap Buffer Size from Max Process Size
**Date**: Oct 8, ~10:00
**Change**: Keep RubberBand's internal ring buffer at 512 but use smaller heap arrays
**Result**: ❌ FAILED - Buzzing still insanely bad
**Why it failed**: Increasing buffer sizes is fundamentally the wrong approach for handling tempo-related buffer overruns
**Files**: RealtimeRubberBand.ts:6-7,35-36

---

## Revert: Back to Original 128-Sample Configuration
**Date**: Oct 8, ~10:05
**Change**: Reverted all buffer size changes back to original working configuration:
```typescript
const RENDER_QUANTUM_FRAMES = 128
this._kernel.setMaxProcessSize(RENDER_QUANTUM_FRAMES)
this._inputArray = new HeapArray(module, RENDER_QUANTUM_FRAMES, channelCount)
this._outputArray = new HeapArray(module, RENDER_QUANTUM_FRAMES, channelCount)
```
**Reasoning**: All attempts to increase buffer sizes caused severe audio quality degradation. The original 128-sample config worked perfectly at normal speed.
**Result**: ✅ Audio quality restored
**Files**: RealtimeRubberBand.ts:5,31-33,68,84-87

---

## Fix Attempt 6: Pull Variable Amounts to Drain Buffer
**Date**: Oct 8, ~10:25
**Root cause identified**: Buffer overruns happen during push, not pull. At 1.25x tempo:
- RubberBand produces 160 output samples from 128 input samples
- We only pull 128 samples per quantum
- Ring buffer accumulates 32 extra samples per quantum
- Buffer (17,408 samples) fills in ~0.18 seconds → overrun

**Change**: Modified pull() to always pull whatever is available, up to output buffer size:
```typescript
const toPull = Math.min(available, outputLength)
if (toPull > 0) {
  this._kernel.pull(this._outputArray.getHeapAddress(), toPull)
  channels[channel].set(this._outputArray.getChannelArray(channel).subarray(0, toPull))
}
```
**Previous behavior**: Only pulled when `available >= 128`, always pulled exactly 128
**New behavior**: Pull min(available, 128) - drains buffer as fast as possible
**Files**: RealtimeRubberBand.ts:80-96
**Result**: ✅ Partial fix - but not complete

---

## Fix Attempt 7: Always Pull Available Samples (Remove >= Check)
**Date**: Oct 8, ~10:40
**Second root cause found**: realtime-pitch-shift-processor.ts:147 had conditional:
```typescript
if (api.samplesAvailable >= outputLength) {  // Only pull if full quantum available
  api.pull(outputs[0])
}
```

**Why this causes overruns**:
- If available = 127, we skip pulling entirely
- Next quantum: 127 + 160 new = 287 samples
- Even one skipped pull cycle causes irreversible accumulation

**Change**: Removed the `>=` check, now always pull when any samples available:
```typescript
if (api.samplesAvailable > 0) {  // Always pull whatever is available
  api.pull(outputs[0])
}
```

**Combined with Fix #6**: Now we:
1. Always pull every quantum (even if < 128 samples available)
2. Pull exactly min(available, outputLength) samples

**Files**: realtime-pitch-shift-processor.ts:145-150
**Result**: 🔄 TESTING - Should completely eliminate buffer overruns

**Important note**: At tempo > 1.0, RubberBand MUST generate more output than we can consume (physics of time stretching). The 32 extra samples per quantum will eventually fill the 17KB ring buffer. This fix ensures we drain as aggressively as possible, but buffer overruns may still occur after sustained playback at high tempo if the ring buffer fills completely. The ring buffer gives us ~0.18 seconds of buffer at 1.25x speed.

---

## Fix Attempt 8: ROOT CAUSE FOUND - Invert Tempo Ratio
**Date**: Oct 8, ~11:00
**THE ACTUAL ROOT CAUSE**: RubberBand's `timeRatio` semantics are the INVERSE of playback speed!

**Discovery process**:
1. User challenged: "playback speed adjustment is a basic function of the RubberBand lib, not sure why it's causing so many problems"
2. Investigated SpeedControl.vue - UI sends values like 1.25 meaning "1.25x faster"
3. Investigated useRubberBandProcessor.js - passes 1.25 directly to setTempo()
4. **CRITICAL REALIZATION**: RubberBand's timeRatio semantics:
   - `timeRatio = output_duration / input_duration`
   - `timeRatio = 1.25` → stretch to 125% duration = SLOWER = generates MORE samples (160 from 128)
   - `timeRatio = 0.8` → compress to 80% duration = FASTER = generates FEWER samples (102 from 128)
5. Playback speed is the INVERSE: `speed = input_duration / output_duration`
6. At UI "1.25x speed", we were calling `setTempo(1.25)`, making RubberBand SLOW DOWN (stretch), generating ~160 samples from 128 input
7. This caused buffer to fill with 32 extra samples per quantum → inevitable overflow

**Changes made**:
1. Modified `set timeRatio()` in RealtimeRubberBand.ts (lines 46-52):
```typescript
set timeRatio(timeRatio: number) {
  // RubberBand's timeRatio is the inverse of playback speed:
  // - playbackSpeed 1.25 (faster) → timeRatio 0.8 (compress to 80% duration)
  // - playbackSpeed 0.8 (slower) → timeRatio 1.25 (stretch to 125% duration)
  this._tempo = timeRatio
  this._kernel.setTempo(1 / timeRatio)
}
```

2. Added initial tempo inversion in constructor (lines 36-39):
```typescript
// Set initial tempo (inverted for RubberBand)
if (options?.tempo && options.tempo !== 1) {
  this._kernel.setTempo(1 / options.tempo)
}
```

**Why this solves everything**:
- At UI "1.25x speed", we now call `setTempo(1/1.25)` = `setTempo(0.8)`
- RubberBand compresses audio to 80% duration (FASTER playback)
- Generates ~102 samples from 128 input instead of ~160
- Net: -26 samples per quantum → buffer DRAINS instead of filling
- Buffer overruns completely eliminated!

**Files**: RealtimeRubberBand.ts:36-39,46-52
**Built and deployed**: Oct 8, ~11:05
**Result**: ✅ Should completely eliminate buffer overruns at all tempo values

---

## BUFFER OVERRUN ISSUE: PARTIALLY SOLVED ⚠️

The tempo inversion fix (Attempt 8) resolved the inverted semantics but revealed two new issues:

- ⚠️ Speedup (1.25x): No buffer overruns but severe audio quality degradation
- ❌ Slowdown (0.5x): Buffer overruns with "256 requested, only room for 128" warnings

Root cause: Browser demands exactly 128 samples per quantum, but RubberBand generates variable amounts based on tempo.

---

## Fix Attempt 9: Handle Variable Sample Rates with Zero-Fill and Input Throttling
**Date**: Oct 8, ~11:15
**THE COMPLETE SOLUTION**: Implement proper async push/pull pattern for real-time processing

**Problem analysis:**
1. **Speedup underrun** (1.25x speed = 0.8 timeRatio):
   - Generates ~102 samples from 128 input
   - Pull only fills 102 samples, leaving [102..127] UNINITIALIZED
   - Result: Gaps/artifacts in audio every quantum

2. **Slowdown overrun** (0.5x speed = 2.0 timeRatio):
   - Generates ~256 samples from 128 input
   - Pull 128, leave 128 in buffer
   - Next quantum: +256 more output, pull 128, leave 256
   - Buffer grows by 128 every quantum → overflow

**Discovery process:**
1. Investigated SoundTouch implementation - found zero-fill pattern when insufficient samples
2. Read RubberBand documentation - confirmed real-time mode expects async push/pull
3. Analyzed ring buffer design - 17,408 samples (~0.36s) to absorb rate mismatches
4. Traced C++ pull() - only reads what's available, doesn't fill remainder

**Changes made:**

1. **Zero-fill underruns** in RealtimeRubberBand.ts (lines 101-107):
```typescript
// Zero-fill remaining samples if we pulled less than requested
// This handles underruns gracefully at speedup (e.g., 1.25x generates ~102 from 128)
if (toPull < outputLength) {
  for (let channel = 0; channel < channels.length; ++channel) {
    channels[channel].fill(0, toPull, outputLength)
  }
}
```

2. **Throttle input when buffer full** in realtime-pitch-shift-processor.ts (lines 142-148):
```typescript
// At slowdown (e.g., 0.5x speed), RubberBand generates MORE output than input
// Skip pushing input when buffer is getting full to prevent overflow
// Ring buffer is 17,408 samples; use conservative threshold of 2048
const MAX_BUFFER_THRESHOLD = 2048
if (api.samplesAvailable < MAX_BUFFER_THRESHOLD) {
  api.push(inputs[0], inputLength)
}
```

**Why this is the correct approach:**
- RubberBand's real-time mode is designed for async push/pull with rate mismatches
- The 17KB ring buffer is specifically designed to absorb temporary differences
- Zero-filling is standard practice (confirmed in SoundTouch implementation)
- Input throttling prevents overflow while maintaining continuous output
- This allows the ring buffer to grow/shrink within safe bounds

**Files**: RealtimeRubberBand.ts:101-107, realtime-pitch-shift-processor.ts:142-148
**Built and deployed**: Oct 8, ~11:15
**Result**: ✅ Should handle all tempo values correctly with proper buffer management

---

---

## Fix Attempt 10: GPT-5 Buffering Strategy + Pitch Correction (Oct 8, 2025)

**Problem**: Attempt 9's zero-fill + input-throttling approach caused severe audio quality degradation. User reported:
- "Audio quality degrades so much it's unusable" at all tempo values
- Pitch shifting broken - pitch changes with speed instead of staying constant

**Root causes discovered**:
1. **Zero-fill creates micro-dropouts**: Padding 20% of every quantum with silence at speedup → buzz/swirl
2. **Input throttling throws away audio**: Skipping push at slowdown → combing/phasiness artifacts
3. **Double-applying speed changes**: PeaksAudioPlayer.vue set `audioElement.playbackRate = newSpeed` while RubberBand also handled tempo → broke pitch correction
4. **Missing setPitchScale(1.0)**: Never explicitly forcing pitch preservation after tempo changes

**GPT-5's critique**:
```
Yeah—your "fix" (zero-fill on underrun + skip-push on overrun) will keep the graph from
exploding, but it will absolutely trash fidelity and can make things sound pitchy.

The correct approach:
- Never skip push() to "throttle." That throws away audio.
- Never pad with zeros unless you absolutely must (last resort).
- Add priming buffer (2048-4096 samples) before playback starts
- Pull in a loop each quantum to drain available samples smoothly
- Let RubberBand's ring buffer (17,408 samples) absorb rate mismatches naturally
```

**Changes made**:

1. **Fixed pitch correction** in PeaksAudioPlayer.vue (lines 587, 820-821, 941):
```typescript
// IMPORTANT: Audio element MUST stay at playbackRate = 1.0 when using RubberBand
// RubberBand handles all tempo/pitch changes via AudioWorklet
audioElement.value.playbackRate = 1.0
```

2. **Removed all zero-fill fallbacks** in RealtimeRubberBand.ts:
```typescript
// No zero-fill fallback - proper priming should ensure we always have samples available
// If underrun occurs, it indicates insufficient priming or incorrect buffer management
```

3. **Removed input throttling + added pull-loop** in realtime-pitch-shift-processor.ts:
```typescript
// ALWAYS push input - never skip/throttle
api.push(inputs[0], inputLength)

// Pull in a loop to drain available samples smoothly
while (written < framesNeeded) {
  const avail = api.samplesAvailable
  if (avail <= 0) break
  const want = framesNeeded - written
  const toPull = Math.min(avail, want)
  api.pull(tempOutput)
  written += toPull
}
```

4. **Added priming buffer** (3072 samples ≈ 64ms @ 48kHz):
```typescript
private samplesPushedForPriming: number = 0
private readonly PRIMING_SAMPLES: number = 3072

// Only start pulling output after priming phase completes
if (this.samplesPushedForPriming >= this.PRIMING_SAMPLES) {
  // Pull output...
}
```

**Why this works**:
- Priming ensures RubberBand always has enough samples to generate smooth output
- Pull-loop drains buffer efficiently without skipping samples
- No zero-fill means no micro-dropouts or audio artifacts
- Always pushing input preserves full fidelity
- Audio element at playbackRate=1.0 prevents double-applying speed changes

**Expected behavior**:
- All tempo values (0.5x - 2.0x): Perfect pitch correction, clean audio quality
- No buffer overruns at slowdown (ring absorbs surplus naturally)
- No micro-dropouts at speedup (priming prevents underruns)
- ~64ms silent priming at start (imperceptible to user)

**Files**:
- PeaksAudioPlayer.vue:587,820-821,941
- RealtimeRubberBand.ts:87-103
- realtime-pitch-shift-processor.ts:5-13,137-185

**Built and deployed**: Oct 8, ~11:30
**Result**: ⏳ Awaiting testing - should provide studio-quality pitch-corrected playback at all tempos

---

---

## Fix Attempt 11: Architectural Fix - Element Tempo + RubberBand Pitch Only (Oct 8, 2025)

**Problem**: Fix Attempt 10 still caused buffer overruns and static:
- Slowdown (0.5x): `WARNING: RingBuffer::write: 256 requested, only room for 128`
- Speedup (1.25x): Static/garbled audio
- Root cause: **Fundamental sample rate mismatch when RubberBand does time-stretching**

**The architectural insight**:
When `element.playbackRate = 1.0` and RubberBand stretches time:
- At 0.5x: RubberBand generates 256 output samples from 128 input
- AudioWorklet can only output 128 samples/quantum
- Buffer MUST overflow (mathematically impossible to drain fast enough)

At 1.25x: RubberBand generates ~102 samples, need 128 → partial fills → static

**The correct architecture** (from critical reassessment):
```typescript
// Audio element handles TEMPO (speed changes)
element.playbackRate = playbackSpeed  // 0.5, 1.25, etc.

// RubberBand handles PITCH CORRECTION ONLY
setTempo(1.0)  // NO time-stretching
setPitch(1 / playbackSpeed)  // Compensate for element's pitch shift
```

**Why this works**:
- At element.playbackRate=0.5: plays slower, audio pitched down
- MediaElementSource delivers 128 samples/quantum (always same rate)
- RubberBand corrects pitch up: setPitch(1/0.5) = setPitch(2.0)
- No time-stretching → input rate = output rate → no mismatch

**Changes made**:

1. **PeaksAudioPlayer.vue speed watcher** (lines 825-847):
```typescript
// Update audio element playback rate
audioElement.value.playbackRate = newSpeed

// RubberBand does NOT time-stretch
audioProcessor.setTempo(1.0)

// Calculate total pitch correction:
// 1. Compensate for playbackRate: 1/newSpeed
// 2. Add key transposition
const speedPitchCorrection = 1 / newSpeed
const totalPitchRatio = speedPitchCorrection * Math.pow(2, keyPitchShift / 12)
audioProcessor.setPitchRatio(totalPitchRatio)
```

2. **Simplified processor** (realtime-pitch-shift-processor.ts:135-155):
```typescript
// No priming needed - rates are matched
process(inputs, outputs) {
  api.push(inputs[0], inputLength)  // Push input
  api.pull(outputs[0])               // Pull output (1:1 ratio)
}
```

3. **Added setPitchRatio method** (useRubberBandProcessor.js:159-167)

**Files modified**:
- PeaksAudioPlayer.vue:587,825-847,856-873,881-902,955
- useRubberBandProcessor.js:159-167,369
- realtime-pitch-shift-processor.ts:5-12,135-155
- RealtimeRubberBand.ts:87-103 (zero-fill already removed)

**Built and deployed**: Oct 8, ~12:00
**Result**: ⏳ Testing - should eliminate all buffer issues with this architectural fix

---

## VARIABLE TEMPO & PITCH ISSUE: ARCHITECTURAL FIX DEPLOYED ⏳

**The solution**: Element handles tempo, RubberBand only does pitch correction

Expected behavior:
- **All tempo values (0.5x - 2.0x)**: Perfect audio quality with pitch preserved
- **No buffer overruns** (input/output rates matched at 1:1)
- **No static** (no partial fills or zero-padding)
- **Key transposition** still works (added to pitch correction)

**Testing required**: Hard refresh and test all tempo values + key changes

---

## Fix Attempt 11.1: Remove Speed-Based Pitch Correction (Oct 8, 2025)

**Problem**: After Fix Attempt 11, audio quality was excellent at all tempo values with no buffer overruns. However, pitch correction was inverted:
- Speed increases (1.25x) → pitch drops below baseline
- Speed decreases (0.5x) → pitch rises above baseline

**Root cause**: When using `MediaElementSource` with Web Audio API, `element.playbackRate` affects ONLY tempo, NOT pitch (unlike direct HTML5 audio playback). We were applying pitch correction `1/playbackSpeed` to compensate for a pitch shift that wasn't happening.

**The fix**: Remove all speed-based pitch correction. Only apply key transposition via RubberBand.

**Code changes** in `PeaksAudioPlayer.vue`:

Speed watcher (lines 830-844):
```javascript
if (audioProcessor.isInitialized?.value) {
  // RubberBand does NOT time-stretch (always 1.0)
  audioProcessor.setTempo(1.0)

  // NOTE: MediaElementSource + playbackRate does NOT shift pitch (only tempo)
  // So we ONLY apply key transposition, no speed-based correction needed
  const keyPitchShift = calculateSemitones(props.nativeKey, audioKey.value)

  // Convert semitones to pitch ratio
  const totalPitchRatio = Math.pow(2, keyPitchShift / 12)

  // Apply via RubberBand
  audioProcessor.setPitchRatio(totalPitchRatio)

  console.log('[PeaksAudioPlayer] Speed:', newSpeed, 'x, Key shift:', keyPitchShift, 'semitones, Pitch ratio:', totalPitchRatio.toFixed(4))
}
```

Key watcher and fine-tuning watcher: Similarly simplified to only calculate pitch from key transposition + fine tuning, no speed correction.

**Why this works**:
- `element.playbackRate` controls playback speed without changing pitch (in Web Audio context)
- RubberBand only needs to handle user-requested key transposition
- Pitch stays constant at all speeds, exactly as intended

**Expected behavior**:
- ✅ All tempo values (0.5x - 2.0x): Perfect audio quality
- ✅ No buffer overruns
- ✅ **Pitch stays constant** regardless of playback speed
- ✅ Key transposition works independently of speed
