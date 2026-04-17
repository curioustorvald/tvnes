# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`tvnes.js` is a NES emulator that runs inside **TSVM**, a JVM-based virtual machine that executes JavaScript via GraalJS. The emulator is a single-file JS script (`tvnes.js`) loaded and run by TSVM. There is no build step — changes to `tvnes.js` take effect on next launch.

**Reference implementation:** `TriCnes_Emulator.cs` and the companion mapper files (`TriCnes_Mapper_*.cs`) are a C# NES emulator kept alongside for correctness comparison. They are **not compiled or executed here** — they are read-only reference material for CPU behaviour, PPU timing, tracelogger format, and mapper logic.

## Running

```
tvnes <rom.nes>
```

TSVM executes `tvnes.js` and passes `rom.nes` as `exec_args[1]`. All ROM files in the repo root (`.nes`) are test targets. Controller keybindings and frameskip are set in `config.*` at the top of `tvnes.js`.

## Tracelogger

Set `config.printTracelog = true` to emit a CPU trace to `<romname>.trc` (e.g. `smario.trc`). The format is designed to match `Tracelogs/SuperMarioBros.txt` byte-for-byte. Diff against the reference to validate CPU correctness:

```
diff Tracelogs/SuperMarioBros.txt smario.trc | head -40
```

The C# `Debug()` method at `TriCnes_Emulator.cs:10270` is the authoritative format specification.

## Architecture

### TSVM host API used by tvnes.js

| Call | Purpose |
|------|---------|
| `sys.peek(addr)` / `sys.poke(addr, val)` | Read/write TSVM usermem or MMIO peripherals (each call crosses the JVM boundary — avoid in hot paths) |
| `sys.pokeBytes(dest, jsTypedArray, len)` | Bulk write a JS `Uint8Array` to TSVM memory (single JVM call — used for framebuffer flush) |
| `sys.memcpy(src, dst, len)` | Bulk copy within TSVM memory |
| `sys.calloc(n)` / `sys.free(ptr)` | Allocate/free TSVM usermem (heap-allocated on the JVM side) |
| `sys.nanoTime()` | Wall-clock nanoseconds |
| `sys.sleep(ms)` | Sleep milliseconds; internally adds ~4 ms overhead (trailing `Thread.sleep(4L)` in the Kotlin bridge) |
| `serial.println(s)` | Debug output |
| `files.open(path)` | File I/O |
| `graphics.*`, `con.*` | GPU / terminal |

`sys.pokeBytes` is a custom addition in `VMJSR223Delegate.kt` (look for `fun pokeBytes`). All other `sys.*` calls are standard TSVM.

Negative TSVM addresses are MMIO: `-(1048577 + row * 280 + col)` addresses the GPU framebuffer at row/col.

### Memory layout (all JS `Uint8Array`)

| Variable | Size | NES mapping |
|----------|------|-------------|
| `ramArr` | 0x800 | CPU RAM $0000–$07FF (mirrored to $1FFF) |
| `romArr` | 0x8000 | PRG ROM $8000–$FFFF (16 KB roms are mirrored) |
| `chrArr` | 0x2000 | CHR ROM/RAM $0000–$1FFF (pattern tables) |
| `vramArr` | 0x800 | Nametable VRAM (2 KB, H/V mirroring done in address math) |
| `palArr` | 0x20 | Palette RAM |
| `oamArr` | 0x100 | OAM |
| `e.fbArr` | 256×240 | NES framebuffer (palette indices, rows 8–231 flushed to GPU) |

All arrays are also exposed as module-level aliases (`let ramArr = e.ramArr` etc.) so GraalJS can avoid property-map lookups in the hot path.

### CPU

- Module-level variables: `cpu_pc`, `cpu_sp`, `cpu_a`, `cpu_x`, `cpu_y`, `cpu_fC/Z/N/V/I/D`.
- `emulateCPU()` — full 6502 switch dispatch. Opcode fetch uses a fast ROM path (`romArr[pc - 0x8000]`) when `pc >= 0x8000`; falls back to `read(pc)` for RAM execution.
- `readPC()` / `readPCu16()` — always correct (bounds-checked); use these for operand fetches, not bare `romArr[...]`.
- NMI edge detection lives in `run()`, not `emulateCPU()`.
- Spin-loop optimisation: if `cpu_pc === lastPC` and no NMI pending, skip the remainder of the scanline in one shot.

### PPU

- `stepPPU()` — consumes a PPU dot budget (3 dots per CPU cycle). Calls `renderScanline(sl)` once per visible scanline, fires vblank/NMI flags, advances dot/scanline counters.
- `renderScanline(sl)` — fetches 33 BG tiles up front, pre-builds the per-dot sprite buffer (`sprLinePalLo/Hi/Flags`), then a tight 256-pixel loop. **No mid-scanline scroll splits** (acceptable for mapper-0).
- `buildSpriteSchedule()` — called once per frame at the pre-render scanline. Pre-indexes OAM into `sprSchedIdx[scanline * 8]` to avoid the 64-sprite scan on every scanline.
- `fbToGPU()` — bulk-flushes rows 8–231 of `e.fbArr` directly to the GPU peripheral via `sys.pokeBytes`.

### APU

All five NES APU channels are implemented. All channels are mixed into a single stream on **playhead 0**:

- **PSG channels** (Pulse 1, Pulse 2, Triangle, Noise) — synthesised by LibPSG (`tvdos/include/psg.mjs`) as stereo u8 PCM at 32 kHz into `libPsgBuf`.
- **DMC/DPCM channel** — delta-modulation output and `$4011` direct writes sampled per CPU cycle into `apu_dmcBuf`.

Each frame, PSG and DMC samples are averaged sample-by-sample (`(psg + dmc) >>> 1`) into a JS `Uint8Array`, bulk-copied to a staging pointer via `sys.pokeBytes`, then uploaded to playhead 0.

Key functions:
- `stepAPU(cycles)` — clocks the frame counter (4/5-step sequencer), envelopes, length counters, sweep units, triangle linear counter, DMC bit-clock and DMA. Returns extra CPU stall cycles from DMC DMA fetches.
- `emitAudioFrame()` — called every frame **outside** the frameskip gate. Iterates stored quarter-frame snapshots, calls LibPSG per slice, averages PSG+DMC sample-by-sample, and uploads the mixed stream to playhead 0.
- `apuFrameStart()` — called before `run()` to record the frame's start cycle and take the initial channel snapshot.
- `apuClockQF()` / `apuClockHF()` — quarter-frame and half-frame clock events (envelopes, linear counter, length counters, sweep).

LibPSG additions (in `psg.mjs`):
- `makeAliasedTriangleNES` — 32-level NES-accurate triangle DAC (4-bit, 0–15 staircase, symmetric).
- `sendBufferFast` — L/R interleave via JS `Uint8Array` + one `sys.pokeBytes` per chunk (vs ~2n `sys.poke` calls in `sendBuffer`). Not used by tvnes directly (inline mix loop is faster), but available for other callers.

### Main loop

```
while (!appexit) {
    updateButtonStatus()
    apuFrameStart()  // record frame-start cycle, take initial channel snapshot
    run()            // emulate one NES frame (breaks when ppu_drawNewFrame fires)
    emitAudioFrame() // synthesise + upload audio; always runs (audio skips ≠ frameskip)
    render()         // fbToGPU (skipped on frameskip frames)
    // speed regulator: sys.sleep() if ahead of 60 fps wall-clock target
    // profiler report every PROF_INTERVAL rendered frames
}
```

## Differences from TriCnes (C# reference)

| Feature | TriCnes | tvnes.js |
|---------|---------|----------|
| PPU granularity | Per-dot state machine | Per-scanline (`renderScanline`) |
| Mid-scanline scroll splits | Supported | **Not supported** |
| APU | Full implementation | Implemented — see §APU above |
| APU stepping | Per CPU cycle | Per CPU instruction (batched); envelope/length off by ≤ ~6 cycles |
| APU frame IRQ clear | 1-cycle delay on $4015 read | Immediate (no 1-cycle delay) |
| APU mixer | NES non-linear (two LUTs) | Linear, hand-tuned per-channel amps (pulse ×0.13, tri ×0.25, noise ×0.17) |
| DMC DMA stall | 1–4 cycles, alignment-aware | Flat +4 cycles per byte fetch |
| Mappers | NROM, MMC1, MMC3 | NROM (0), MMC1 (1), UxROM (2), CNROM (3), MMC3 (4), MMC6 (4+sub1), AOROM (7), VRC6a (24), VRC6b (26), FME-7 (69), iNES 228 |
| Multi-bank PRG | Yes | Full banking for NROM/MMC1/MMC3 |
| CHR RAM | Yes | Yes (`inesHdr[5] == 0` check) |
| Illegal opcodes | Partial | Partial (same set) |
| MMC3 IRQ timing | Per-dot (A12 rise) | Per-scanline approximation (±1 scanline accuracy) |
| OAM DMA timing | Accurate cycle count | 513 cycles (alignment not modelled) |
| Sprite overflow | Accurate | Detected at schedule-build time only |

## Optimisations (accuracy vs. speed trade-offs)

These were added explicitly to raise performance on GraalJS/JVM. Each trades some NES accuracy for speed.

1. **JS `Uint8Array` for all NES memory** — eliminates all `sys.peek/poke` in the hot path. Boot-time ROM load still uses `sys.peek` (one-shot, not a concern).

2. **`sys.pokeBytes` for framebuffer flush** — replaces 57,344 per-pixel `sys.poke` calls/frame with 224 bulk Kotlin calls.

3. **Per-scanline PPU** — replaces ~89,000 `emulatePPU()` dot-level calls/frame with 262 scanline calls. **Consequence:** mid-scanline raster effects (status bar tricks, split-X scroll) will glitch.

4. **Module-level CPU register variables** — GraalJS can keep `cpu_pc`, `cpu_a`, etc. in machine registers across the `emulateCPU` dispatch. No accuracy impact.

5. **Module-level memory array aliases** — `let ramArr = e.ramArr` etc. avoids ~14,000 property-map lookups per frame. No accuracy impact.

6. **Inlined `setResultFlags`** — `cpu_fZ = a==0; cpu_fN = a>127` written directly at each ALU site instead of a function call. No accuracy impact.

7. **`bitRev8` lookup table** — replaces 3-operation bit-reverse with a 256-entry table for sprite horizontal flip. No accuracy impact.

8. **Frameskip** (`config.frameskip`) — CPU and PPU always run (correct timing, sprite-0 hit detection preserved), pixel writes to `e.fbArr` are suppressed on skipped frames, `fbToGPU` is skipped entirely. **Consequence:** visual frame rate drops but game logic stays correct.

9. **OAM DMA fast path** — `$4014` DMA uses `Uint8Array.set` / direct loop on typed arrays instead of 256 `read()` calls. Charges 513 cycles flat (alignment-dependent 513/514 not modelled).

10. **Fast opcode fetch** — the opcode byte at `pc >= 0x8000` is fetched directly as `romArr[pc - 0x8000]`, bypassing the `read()` dispatch tree. RAM execution (`pc < 0x8000`) still goes through `read()`.

11. **Spin-loop fast-forward** — when `cpu_pc` doesn't change between two consecutive `emulateCPU` calls (JMP-to-self), skip the remaining PPU budget to the next scanline boundary instead of calling `emulateCPU` ~113 more times. **Consequence:** wall-clock time inside the spin is not emulated — only matters for games that spin waiting for an exact cycle count, which mapper-0 titles don't.

12. **Per-scanline sprite schedule** — `buildSpriteSchedule()` pre-indexes all 64 OAM entries into per-scanline slot arrays once per frame (at the pre-render scanline). Replaces 64 × 240 = 15,360 Y-position checks per frame with a single 64-entry scan. No accuracy impact for standard sprite rendering.

13. **Speed regulator** — after each `run()` + `render()` call, the main loop sleeps the unused portion of the 16.64 ms NTSC frame budget. Prevents fast-forward when the emulator runs faster than real time; slowdown is allowed.

14. **APU quarter-frame slicing** — channel state (freq, amp, duty) is snapshotted at each frame-counter QF event (4–5 times/frame = 240 Hz update resolution). `emitAudioFrame` calls LibPSG once per slice rather than per-sample, keeping synthesis outside the CPU hot path. No impact on envelope/length accuracy beyond the per-instruction batching already noted.

15. **APU inline mix + `sys.pokeBytes`** — PSG and DMC buffers are averaged sample-by-sample into a pre-allocated JS `Uint8Array` scratch (`apu_sumBuf`), then bulk-copied to a native staging pointer via one `sys.pokeBytes` call (replacing ~1066 per-sample `sys.poke` calls/frame). Both the JS scratch and the staging pointer are allocated once at boot and reused every frame.

16. **Multi-source IRQ arbitration** — `mmc3_irqPending` tracks the MMC3 edge independently so APU IRQ clears (`$4015` read, `$4017` inhibit, `$4010` IRQ-disable) do not accidentally lower an active MMC3 IRQ line, and vice-versa.

## Profiler output

The profiler (enabled permanently) prints every `PROF_INTERVAL` (60) rendered frames:

```
[prof] 30 fps | 33.2ms/frame | CPU:58% PPU:34% render:8%
[cpu ] 29841 i/fr  104002 c/fr  NMI:1.0/fr  skip:62%
[cpu ] hot: LDA($a5):18%  STA($85):11%  BNE($d0):9%  ...
```

`skip:%` is cycles skipped via spin-loop fast-forward. A high value (>50%) is normal during vblank waits.
