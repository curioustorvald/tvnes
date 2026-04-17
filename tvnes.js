// NES Emulator for TSVM
// Based on tutorial by 100thCoin
// https://www.patreon.com/posts/making-your-nes-137873901

let appexit = false

// config
const config = {}
config.frameskip = 1 // 0: invalid, 1: no skip, 2: every other frame, 3: every 3rd frame
config.quit = 67 // quit = backspace
config.p1a = 62 // A = space
config.p1b = 29 // B = a
config.p1sel = 59 // SELECT = left shift
config.p1sta = 66 // START = return
config.p1u = 33 // UP = e
config.p1d = 32 // DOWN = d
config.p1l = 47 // LEFT = s
config.p1r = 34 // RIGHT = f
config.printTracelog = false
config.audioEnable = true
config.audioVolume = 255  // 0–255; passed to audio.setMasterVolume for both playheads

// ── LibPSG (PSG synthesiser for NES PSG channels → Audio Adapter Playhead 0) ──
const psg = require("psg")

// ── Profiler — cumulative ns per section, printed every PROF_INTERVAL rendered frames ──
const PROF_INTERVAL = 60  // print once per ~60 rendered frames
let prof_cpu = 0, prof_ppu = 0, prof_apu = 0, prof_render = 0, prof_frames = 0

// ── CPU sub-profiler (count-based, not timer-based — one cheap ++ per event) ──
let prof_cpu_instrs  = 0  // instructions executed this window
let prof_cpu_cycles  = 0  // CPU cycles this window
let prof_cpu_nmi     = 0  // NMIs fired this window
let prof_cpu_skip    = 0  // CPU cycles skipped via spin-loop fast-forward
// Per-opcode execution counts — reset each window; used for hot-instr report
const prof_opcodeHits = new Uint32Array(256)
let prof_wallStart = sys.nanoTime()

// ── CPU registers + flags (module-level so GraalJS keeps them in machine registers) ──
let cpu_pc = 0, cpu_sp = 0, cpu_a = 0, cpu_x = 0, cpu_y = 0
let cpu_fC = false, cpu_fZ = false, cpu_fN = false, cpu_fV = false, cpu_fI = false, cpu_fD = false
let cpu_halted = false
let cpu_nmiLevel = false, cpu_doNMI = false, cpu_nmiFired = 0
let cpu_irqLevel = false, cpu_doIRQ = false  // level-triggered IRQ (MMC3)
let cpu_totalCycles = 0
// ── Hot PPU/loop flags hoisted out of e (read every CPU instruction or every scanline) ──
let ppu_vblank = false, ppu_enableNMI = false
let ppu_cycleBudget = 0, ppu_drawNewFrame = false, ppu_skipRender = false

// ── APU state (module-level, follows cpu_* / ppu_* convention for GraalJS perf) ──
// Pulse 1
let apu_p1TimerReload = 0, apu_p1Duty = 0, apu_p1LenCnt = 0, apu_p1LenHalt = false
let apu_p1EnvStart = false, apu_p1EnvDivider = 0, apu_p1EnvDecay = 0
let apu_p1EnvConst = false, apu_p1EnvVol = 0, apu_p1Enable = false
let apu_p1SweepEnable = false, apu_p1SweepPeriod = 0, apu_p1SweepNegate = false
let apu_p1SweepShift = 0, apu_p1SweepReload = false, apu_p1SweepDivider = 0
// Pulse 2
let apu_p2TimerReload = 0, apu_p2Duty = 0, apu_p2LenCnt = 0, apu_p2LenHalt = false
let apu_p2EnvStart = false, apu_p2EnvDivider = 0, apu_p2EnvDecay = 0
let apu_p2EnvConst = false, apu_p2EnvVol = 0, apu_p2Enable = false
let apu_p2SweepEnable = false, apu_p2SweepPeriod = 0, apu_p2SweepNegate = false
let apu_p2SweepShift = 0, apu_p2SweepReload = false, apu_p2SweepDivider = 0
// Triangle
let apu_triTimerReload = 0, apu_triLenCnt = 0, apu_triLenHalt = false
let apu_triLinCnt = 0, apu_triLinReloadVal = 0, apu_triLinReload = false, apu_triEnable = false
// Noise
let apu_nsTimerIdx = 0, apu_nsMode = false, apu_nsLenCnt = 0, apu_nsLenHalt = false
let apu_nsEnvStart = false, apu_nsEnvDivider = 0, apu_nsEnvDecay = 0
let apu_nsEnvConst = false, apu_nsEnvVol = 0, apu_nsEnable = false
// DMC
let apu_dmcIrqEn = false, apu_dmcLoop = false, apu_dmcRate = 428
let apu_dmcTimer = 428, apu_dmcOutput = 0
let apu_dmcSampleAddr = 0xC000, apu_dmcSampleLen = 1, apu_dmcBytesRem = 0
let apu_dmcAddrCounter = 0xC000
let apu_dmcBuffer = 0, apu_dmcBufFilled = false
let apu_dmcShifter = 0, apu_dmcShiftCnt = 8, apu_dmcSilent = true
let apu_dmcEnable = false, apu_dmcIrqFlag = false
// Frame counter
let apu_fcMode = 0, apu_fcInhibitIrq = false, apu_fcCycles = 0
let apu_fcResetDelay = 0, apu_fcIrqFlag = false
// Audio output bookkeeping
let apu_sampleAcc = 0.0        // fractional accumulator for 32 kHz downsampling
let apu_dmcBuf = new Uint8Array(1200)   // 600 stereo u8 samples per frame (headroom)
let apu_dmcWritePos = 0         // stereo sample index written into apu_dmcBuf this frame
let apu_frameCyclesStart = 0    // cpu_totalCycles at frame start
let apu_absTimeSec = 0.0        // cumulative audio seconds emitted; used for cross-frame phase continuity
// Per-frame quarter-frame snapshots for LibPSG sliced mixing (up to 5 slots: initial + 4 QF)
const APU_MAX_SLICES = 5
let apu_sliceCount = 1
let apu_sliceOff  = new Float64Array(APU_MAX_SLICES)
let apu_snapP1On   = new Uint8Array(APU_MAX_SLICES)
let apu_snapP1Freq = new Float64Array(APU_MAX_SLICES)
let apu_snapP1Amp  = new Float64Array(APU_MAX_SLICES)
let apu_snapP1Duty = new Float64Array(APU_MAX_SLICES)
let apu_snapP2On   = new Uint8Array(APU_MAX_SLICES)
let apu_snapP2Freq = new Float64Array(APU_MAX_SLICES)
let apu_snapP2Amp  = new Float64Array(APU_MAX_SLICES)
let apu_snapP2Duty = new Float64Array(APU_MAX_SLICES)
let apu_snapTriOn  = new Uint8Array(APU_MAX_SLICES)
let apu_snapTriFreq = new Float64Array(APU_MAX_SLICES)
let apu_snapNsOn   = new Uint8Array(APU_MAX_SLICES)
let apu_snapNsFreq = new Float64Array(APU_MAX_SLICES)
let apu_snapNsAmp  = new Float64Array(APU_MAX_SLICES)
let apu_snapNsMode = new Uint8Array(APU_MAX_SLICES)
// Sunsoft 5B: three extra square channels (FME-7 onboard audio)
let apu_snap5bAOn   = new Uint8Array(APU_MAX_SLICES)
let apu_snap5bAFreq = new Float64Array(APU_MAX_SLICES)
let apu_snap5bAAmp  = new Float64Array(APU_MAX_SLICES)
let apu_snap5bBOn   = new Uint8Array(APU_MAX_SLICES)
let apu_snap5bBFreq = new Float64Array(APU_MAX_SLICES)
let apu_snap5bBAmp  = new Float64Array(APU_MAX_SLICES)
let apu_snap5bCOn   = new Uint8Array(APU_MAX_SLICES)
let apu_snap5bCFreq = new Float64Array(APU_MAX_SLICES)
let apu_snap5bCAmp  = new Float64Array(APU_MAX_SLICES)
// VRC6: two pulse channels + one sawtooth (Konami onboard audio)
let apu_snapVrc6P1On   = new Uint8Array(APU_MAX_SLICES)
let apu_snapVrc6P1Freq = new Float64Array(APU_MAX_SLICES)
let apu_snapVrc6P1Amp  = new Float64Array(APU_MAX_SLICES)
let apu_snapVrc6P1Duty = new Float64Array(APU_MAX_SLICES)
let apu_snapVrc6P2On   = new Uint8Array(APU_MAX_SLICES)
let apu_snapVrc6P2Freq = new Float64Array(APU_MAX_SLICES)
let apu_snapVrc6P2Amp  = new Float64Array(APU_MAX_SLICES)
let apu_snapVrc6P2Duty = new Float64Array(APU_MAX_SLICES)
let apu_snapVrc6SawOn   = new Uint8Array(APU_MAX_SLICES)
let apu_snapVrc6SawFreq = new Float64Array(APU_MAX_SLICES)
let apu_snapVrc6SawAmp  = new Float64Array(APU_MAX_SLICES)
// LibPSG mix buffer and TSVM native staging pointers (allocated in apuBootAudio)
let libPsgBuf = null
let apuSumStagingPtr = 0
let apu_sumBuf = null  // JS Uint8Array scratch for PSG+DMC interleave mix
let apuAudioBooted = false

// CPU / PPU state
const e = {}
// ── Item 1: all NES memory as JS typed arrays (no sys.peek/poke in hot paths) ──
e.ramArr  = new Uint8Array(0x800)    // 2 KB CPU RAM (mirrors to $0000–$1FFF)
e.romArr  = new Uint8Array(0x8000)   // 32 KB PRG ROM ($8000–$FFFF)
e.chrArr  = new Uint8Array(0x2000)   // 8 KB CHR ROM/RAM
e.vramArr = new Uint8Array(0x800)    // 2 KB nametable VRAM (H/V mirrored)
e.palArr  = new Uint8Array(0x20)     // 32-byte palette RAM
e.oamArr  = new Uint8Array(0x100)    // 256-byte OAM (sprite attributes)
e.secondaryOAMArr = new Uint8Array(0x20)
// Module-level aliases for the hot memory arrays — eliminates e.* property lookup
// from readPC / readPCu16 / read / write / renderScanline (≈14k dereferences/frame).
let ramArr = e.ramArr, romArr = e.romArr, chrArr = e.chrArr
let vramArr = e.vramArr, palArr = e.palArr, oamArr = e.oamArr

// ── Mapper state (set in reset(), used by mapper read/write handlers) ──
let mapperId  = 0  // from iNES header byte 6/7
let subMapper = 0  // from iNES header byte 8 (NES 2.0)
let battery   = false
let savPath   = null
let prgRomArr = e.romArr   // full PRG ROM; initialised in reset()
let chrRomArr = e.chrArr   // full CHR ROM (or alias to chrArr for CHR RAM)
let wramArr   = new Uint8Array(0x2000)  // $6000–$7FFF backing (reallocated in reset)
let prgBanks  = 0  // number of 16 KB PRG banks (from header)
let chrBanks  = 0  // number of 8 KB CHR banks (0 = CHR RAM)

// ── Nametable mirror slot LUT: ntSlot[i] → which 1 KB page of vramArr (0 or 1) ──
// Updated by setMirrorMode(). Used in write/readPPU/renderScanline.
const ntSlot  = new Uint8Array(4)  // index = (vramAddr >> 10) & 3

// ── MMC1 state ──
let mmc1_shift = 0x10, mmc1_ctrl = 0x0C, mmc1_chr0 = 0, mmc1_chr1 = 0, mmc1_prg = 0

// ── MMC3 state ──
let mmc3_bankSel = 0, mmc3_bankA = 0, mmc3_bank8C = 0
let mmc3_chr2K0 = 0, mmc3_chr2K8 = 0
let mmc3_chr1K0 = 0, mmc3_chr1K4 = 0, mmc3_chr1K8 = 0, mmc3_chr1KC = 0
let mmc3_irqLatch = 0, mmc3_irqCounter = 0
let mmc3_irqEnable = false, mmc3_irqReload = false, mmc3_prgRamProt = 0
let mmc3_irqPending = false  // separate "edge has fired" flag for multi-source IRQ arbitration

// ── UxROM (iNES mapper 2) state ──
let uxrom_bankSel = 0

// ── CNROM (iNES mapper 3) state ──
let cnrom_chrBank = 0

// ── AOROM (iNES mapper 7) state ──
let aorom_bankSel = 0

// ── Sunsoft FME-7 (iNES mapper 69) state ──
let fme7_cmd = 0
let fme7_chr = new Uint8Array(8)
let fme7_prg6 = 0, fme7_bank6IsRAM = false, fme7_bank6IsRAMEnabled = false
let fme7_prg8 = 0, fme7_prgA = 0, fme7_prgC = 0
let fme7_irqEnable = false, fme7_irqCountEnable = false
let fme7_irqCounter = 0, fme7_irqPending = false

// ── Sunsoft 5B audio (FME-7 onboard PSG — 3 square channels + simple mixer) ──
// Register selected via $C000, written via $E000. Registers 0-5 are tone periods
// (12-bit, two bytes per channel), 7 is mixer enable, 8-A are per-channel volume.
// Envelope and noise are not synthesised — volume-only for registers 8/9/A.
let s5b_regSel = 0
let s5b_regs   = new Uint8Array(16)

// ── Konami VRC6 (iNES mapper 24 = VRC6a, 26 = VRC6b) state ──
// VRC6b swaps CPU A0/A1 when indexing the four-register groups at $9000/$A000/…/$F000.
let vrc6_variant = 0        // 0 = VRC6a, 1 = VRC6b
let vrc6_prg16   = 0        // $8000–$BFFF (16 KB)
let vrc6_prg8    = 0        // $C000–$DFFF (8 KB)
let vrc6_chr     = new Uint8Array(8)  // 8 × 1 KB CHR banks
let vrc6_mirror  = 0        // $B003 bits 3–2
let vrc6_prgRamEnable = false  // $B003 bit 7
// IRQ
let vrc6_irqLatch = 0, vrc6_irqCounter = 0, vrc6_irqPrescaler = 341
let vrc6_irqEnable = false, vrc6_irqAck = false, vrc6_irqMode = false  // mode: false=scanline, true=cycle
let vrc6_irqPending = false
// Audio — 2 pulse + 1 sawtooth
let vrc6_p1Vol = 0, vrc6_p1Duty = 0, vrc6_p1Mode = false, vrc6_p1Period = 0, vrc6_p1En = false
let vrc6_p2Vol = 0, vrc6_p2Duty = 0, vrc6_p2Mode = false, vrc6_p2Period = 0, vrc6_p2En = false
let vrc6_sawRate = 0, vrc6_sawPeriod = 0, vrc6_sawEn = false

// iNES header (16 bytes)
e.inesHdr = new Uint8Array(16)
// ── Item 2: framebuffer as JS typed array; GPU flush done at frame-end ──
e.fbArr = new Uint8Array(256 * 240)  // NES framebuffer (palette indices)
// e.fb usermem scratch removed — fbToGPU now uses sys.pokeBytes directly to GPU
// 6502 registers, flags, NMI state → hoisted to module-level cpu_* variables above
// PPU registers & internal state
e.writeLatch       = false
e.transferAddr     = 0
e.vramAddr         = 0
e._tempVramAddr    = 0
e.ppuVramInc32Mode = false
e.ppuReadBuffer    = 0
e.ppuDot           = 0
e.ppuScanline      = 0
// ppu_vblank → hoisted to module-level above
e.ppuMask8pxMaskBG      = false
e.ppuMask8pxMaskSprites = false
e.ppuMaskRenderBG       = false
e.ppuMaskRenderSprites  = false
e.ppuNametableSelect  = 0
e.ppuSpritePatternTable = false
e.ppuBGPatternTable     = false
e.ppuUse8x16Sprites     = false
// ppu_enableNMI → hoisted to module-level above
e.ppuStatusOverflow     = false
e.ppuStatusSprZeroHit   = false
e.ppuShiftRegPtnL = 0
e.ppuShiftRegPtnH = 0
e.ppuShiftRegAtrL = 0
e.ppuShiftRegAtrH = 0
e.ppu8stepPtnLoBitplane = 0
e.ppu8stepPtnHiBitplane = 0
e.ppu8stepAttr     = 0
e.ppuAddrBus       = 0
e.ppu8stepTemp     = 0
e.ppu8stepNextChar = 0
e.ppuScrollFineX   = 0
e.ppuOAMaddr       = 0
e.ppuSecondaryOAMsize = 0
e.ppuScanlineContainsSprZero = false
e.ppuSpriteShiftRegL = new Uint8Array(8)
e.ppuSpriteShiftRegH = new Uint8Array(8)
e.ppuSpriteAtr  = new Uint8Array(8)
e.ppuSpritePtn  = new Uint8Array(8)
e.ppuSpritePosX = new Uint8Array(8)
e.ppuSpritePosY = new Uint8Array(8)
// ppu_cycleBudget, ppu_drawNewFrame, ppu_skipRender → hoisted to module-level above
// Controller shift registers
e.currentButtonStatus = 0
e.cnt1sr = 0
e.cnt2sr = 0
// cpu_totalCycles, ppu_drawNewFrame → hoisted to module-level above

///////////////////////////////////////////////////////////////////////////////
// ── Item 7: bit-reverse lookup table (for sprite horizontal flip) ──
const bitRev8 = new Uint8Array(256)
{
    for (let i = 0; i < 256; i++) {
        let v = i
        v = ((v & 0xF0) >>> 4) | ((v & 0x0F) << 4)
        v = ((v & 0xCC) >>> 2) | ((v & 0x33) << 2)
        v = ((v & 0xAA) >>> 1) | ((v & 0x55) << 1)
        bitRev8[i] = v
    }
}

///////////////////////////////////////////////////////////////////////////////
// ── APU lookup tables ──
// Length counter LUT — indexed by top 5 bits of $4003/$4007/$400B/$400F writes (same as TriCnes:807)
const APU_LEN_LUT = new Uint8Array([
    10,254, 20,  2, 40,  4, 80,  6,160,  8, 60, 10, 14, 12, 26, 14,
    12, 16, 24, 18, 48, 20, 96, 22,192, 24, 72, 26, 16, 28, 32, 30
])
// DMC rate table — CPU-cycle periods, NTSC (same as TriCnes:836)
const APU_DMC_RATE_LUT = new Uint16Array([
    428,380,340,320,286,254,226,214,190,160,142,128,106,84,72,54
])
// Noise period table — CPU-cycle periods, NTSC
const APU_NOISE_PERIOD_LUT = new Uint16Array([
    4,8,16,32,64,96,128,160,202,254,380,508,762,1016,2034,4068
])
// Pulse duty fractions for LibPSG makeSquare (12.5%, 25%, 50%, 75%)
const APU_DUTY_FRAC = [0.125, 0.25, 0.5, 0.75]
// CPU cycles per 32 kHz sample (NTSC): 1789773 / 32000 ≈ 55.93
const APU_CYC_PER_SAMPLE = 1789773.0 / 32000.0

///////////////////////////////////////////////////////////////////////////////
// ── Nametable mirror mode — call whenever mirroring changes ──
// mode 0 = 1-screen low, 1 = 1-screen high, 2 = vertical, 3 = horizontal
function setMirrorMode(mode) {
    switch (mode) {
        case 0: ntSlot[0]=0; ntSlot[1]=0; ntSlot[2]=0; ntSlot[3]=0; break
        case 1: ntSlot[0]=1; ntSlot[1]=1; ntSlot[2]=1; ntSlot[3]=1; break
        case 2: ntSlot[0]=0; ntSlot[1]=1; ntSlot[2]=0; ntSlot[3]=1; break  // vertical
        case 3: ntSlot[0]=0; ntSlot[1]=0; ntSlot[2]=1; ntSlot[3]=1; break  // horizontal
    }
}

///////////////////////////////////////////////////////////////////////////////
// ── Item 11: opcode metadata for tracelogger ──
// Modes: 0=impl 1=acc 2=imm 3=zp 4=zp,x 5=zp,y 6=abs 7=abs,x 8=abs,y
//        9=rel 10=ind 11=(zp,x) 12=(zp),y
const OPCODE_MODE = new Uint8Array([
//  0   1   2   3   4   5   6   7   8   9   A   B   C   D   E   F
    0, 11,  0, 11,  3,  3,  3,  3,  0,  2,  1,  2,  6,  6,  6,  6, // $0x
    9, 12,  0, 12,  4,  4,  4,  4,  0,  8,  0,  8,  7,  7,  7,  7, // $1x
    6, 11,  0, 11,  3,  3,  3,  3,  0,  2,  1,  2,  6,  6,  6,  6, // $2x
    9, 12,  0, 12,  4,  4,  4,  4,  0,  8,  0,  8,  7,  7,  7,  7, // $3x
    0, 11,  0, 11,  3,  3,  3,  3,  0,  2,  1,  2,  6,  6,  6,  6, // $4x
    9, 12,  0, 12,  4,  4,  4,  4,  0,  8,  0,  8,  7,  7,  7,  7, // $5x
    0, 11,  0, 11,  3,  3,  3,  3,  0,  2,  1,  2, 10,  6,  6,  6, // $6x
    9, 12,  0, 12,  4,  4,  4,  4,  0,  8,  0,  8,  7,  7,  7,  7, // $7x
    2, 11,  2, 11,  3,  3,  3,  3,  0,  2,  0,  2,  6,  6,  6,  6, // $8x
    9, 12,  0, 12,  4,  4,  5,  5,  0,  8,  0,  8,  7,  7,  8,  8, // $9x
    2, 11,  2, 11,  3,  3,  3,  3,  0,  2,  0,  2,  6,  6,  6,  6, // $Ax
    9, 12,  0, 12,  4,  4,  5,  5,  0,  8,  0,  8,  7,  7,  8,  8, // $Bx
    2, 11,  2, 11,  3,  3,  3,  3,  0,  2,  0,  2,  6,  6,  6,  6, // $Cx
    9, 12,  0, 12,  4,  4,  4,  4,  0,  8,  0,  8,  7,  7,  7,  7, // $Dx
    2, 11,  2, 11,  3,  3,  3,  3,  0,  2,  0,  2,  6,  6,  6,  6, // $Ex
    9, 12,  0, 12,  4,  4,  4,  4,  0,  8,  0,  8,  7,  7,  7,  7, // $Fx
])
const OPCODE_LEN = new Uint8Array([
//  0  1  2  3  4  5  6  7  8  9  A  B  C  D  E  F
    1, 2, 1, 2, 2, 2, 2, 2, 1, 2, 1, 2, 3, 3, 3, 3, // $0x
    2, 2, 1, 2, 2, 2, 2, 2, 1, 3, 1, 3, 3, 3, 3, 3, // $1x
    3, 2, 1, 2, 2, 2, 2, 2, 1, 2, 1, 2, 3, 3, 3, 3, // $2x
    2, 2, 1, 2, 2, 2, 2, 2, 1, 3, 1, 3, 3, 3, 3, 3, // $3x
    1, 2, 1, 2, 2, 2, 2, 2, 1, 2, 1, 2, 3, 3, 3, 3, // $4x
    2, 2, 1, 2, 2, 2, 2, 2, 1, 3, 1, 3, 3, 3, 3, 3, // $5x
    1, 2, 1, 2, 2, 2, 2, 2, 1, 2, 1, 2, 3, 3, 3, 3, // $6x
    2, 2, 1, 2, 2, 2, 2, 2, 1, 3, 1, 3, 3, 3, 3, 3, // $7x
    2, 2, 2, 2, 2, 2, 2, 2, 1, 2, 1, 2, 3, 3, 3, 3, // $8x
    2, 2, 1, 2, 2, 2, 2, 2, 1, 3, 1, 3, 3, 3, 3, 3, // $9x
    2, 2, 2, 2, 2, 2, 2, 2, 1, 2, 1, 2, 3, 3, 3, 3, // $Ax
    2, 2, 1, 2, 2, 2, 2, 2, 1, 3, 1, 3, 3, 3, 3, 3, // $Bx
    2, 2, 2, 2, 2, 2, 2, 2, 1, 2, 1, 2, 3, 3, 3, 3, // $Cx
    2, 2, 1, 2, 2, 2, 2, 2, 1, 3, 1, 3, 3, 3, 3, 3, // $Dx
    2, 2, 2, 2, 2, 2, 2, 2, 1, 2, 1, 2, 3, 3, 3, 3, // $Ex
    2, 2, 1, 2, 2, 2, 2, 2, 1, 3, 1, 3, 3, 3, 3, 3, // $Fx
])
const OPCODE_NAMES = [
    'BRK','ORA','HLT','SLO','NOP','ORA','ASL','SLO','PHP','ORA','ASL','ANC','NOP','ORA','ASL','SLO',
    'BPL','ORA','HLT','SLO','NOP','ORA','ASL','SLO','CLC','ORA','NOP','SLO','NOP','ORA','ASL','SLO',
    'JSR','AND','HLT','RLA','BIT','AND','ROL','RLA','PLP','AND','ROL','ANC','BIT','AND','ROL','RLA',
    'BMI','AND','HLT','RLA','NOP','AND','ROL','RLA','SEC','AND','NOP','RLA','NOP','AND','ROL','RLA',
    'RTI','EOR','HLT','SRE','NOP','EOR','LSR','SRE','PHA','EOR','LSR','ALR','JMP','EOR','LSR','SRE',
    'BVC','EOR','HLT','SRE','NOP','EOR','LSR','SRE','CLI','EOR','NOP','SRE','NOP','EOR','LSR','SRE',
    'RTS','ADC','HLT','RRA','NOP','ADC','ROR','RRA','PLA','ADC','ROR','ARR','JMP','ADC','ROR','RRA',
    'BVS','ADC','HLT','RRA','NOP','ADC','ROR','RRA','SEI','ADC','NOP','RRA','NOP','ADC','ROR','RRA',
    'NOP','STA','NOP','SAX','STY','STA','STX','SAX','DEY','NOP','TXA','ANE','STY','STA','STX','SAX',
    'BCC','STA','HLT','SHA','STY','STA','STX','SAX','TYA','STA','TXS','SHS','SHY','STA','SHX','SHA',
    'LDY','LDA','LDX','LAX','LDY','LDA','LDX','LAX','TAY','LDA','TAX','LXA','LDY','LDA','LDX','LAX',
    'BCS','LDA','HLT','LAX','LDY','LDA','LDX','LAX','CLV','LDA','TSX','LAE','LDY','LDA','LDX','LAX',
    'CPY','CMP','NOP','DCP','CPY','CMP','DEC','DCP','INY','CMP','DEX','AXS','CPY','CMP','DEC','DCP',
    'BNE','CMP','HLT','DCP','NOP','CMP','DEC','DCP','CLD','CMP','NOP','DCP','NOP','CMP','DEC','DCP',
    'CPX','SBC','NOP','ISC','CPX','SBC','INC','ISC','INX','SBC','NOP','SBC','CPX','SBC','INC','ISC',
    'BEQ','SBC','HLT','ISC','NOP','SBC','INC','ISC','SED','SBC','NOP','ISC','NOP','SBC','INC','ISC',
    'NMI', // index 256, used by tracelog for NMI pseudo-opcode
]

///////////////////////////////////////////////////////////////////////////////
// ── Item 5: lift e.* helpers to top-level functions ──

let dataBus = 0

function readPC() {
    let pc = cpu_pc
    let v = pc >= 0x8000 ? romArr[pc - 0x8000] : read(pc)
    cpu_pc = (pc + 1) & 0xFFFF
    dataBus = v
    return v
}

function readPCs() {
    let v = readPC()
    return v > 127 ? v - 256 : v
}

function readPCu16() {
    let pc = cpu_pc
    let lo, hi
    if (pc >= 0x8000) {
        lo = romArr[pc - 0x8000]
        hi = romArr[(pc + 1) - 0x8000]
    } else {
        lo = read(pc)
        hi = read(pc + 1)
    }
    cpu_pc = (pc + 2) & 0xFFFF
    return (hi << 8) | lo
}

function movPC(offset) {
    cpu_pc = (cpu_pc + offset) & 0xFFFF
}

function incPC() { cpu_pc = (cpu_pc + 1) & 0xFFFF }
function decPC() { cpu_pc = cpu_pc == 0 ? 65535 : cpu_pc - 1 }

function pushPC() {
    let pc = cpu_pc
    push((pc >>> 8) & 0xFF)
    push(pc & 0xFF)
}

e.free = () => {
    // no usermem allocations to free (fbArr is a JS typed array)
}

///////////////////////////////////////////////////////////////////////////////
// ── Mapper helpers ──

function mapperReadWRAM(offset) {
    if (mapperId == 1) {
        // MMC1: WRAM enabled when bit 4 of PRG reg is 0
        if ((mmc1_prg & 0x10) == 0) return dataBus = wramArr[offset & 0x1FFF]
    } else if (mapperId == 4) {
        // MMC3 / MMC6
        if (subMapper == 1) {
            // MMC6: 1 KB at $7000-$73FF (first half) and $7200-$73FF (second half)
            if ((mmc3_bankSel & 0x20) != 0) {
                if (offset >= 0x7000 && offset <= 0x71FF) {
                    if ((mmc3_prgRamProt & 0x20) != 0) return dataBus = wramArr[offset & 0x3FF]
                } else if (offset >= 0x7200 && offset <= 0x73FF) {
                    if ((mmc3_prgRamProt & 0x80) != 0) return dataBus = wramArr[offset & 0x3FF]
                }
            }
        } else {
            if ((mmc3_prgRamProt & 0x80) != 0) return dataBus = wramArr[offset & 0x1FFF]
        }
    } else if (mapperId == 69) {
        // FME-7: $6000-$7FFF bank is ROM or enabled RAM per register 8
        if (fme7_bank6IsRAM) {
            if (fme7_bank6IsRAMEnabled) return dataBus = wramArr[offset & 0x1FFF]
        } else {
            let src = (fme7_prg6 * 0x2000 + (offset & 0x1FFF)) % prgRomArr.length
            return dataBus = prgRomArr[src]
        }
    } else if (mapperId == 24 || mapperId == 26) {
        if (vrc6_prgRamEnable) return dataBus = wramArr[offset & 0x1FFF]
    }
    return dataBus
}

function mapperWriteWRAM(offset, value) {
    if (mapperId == 1) {
        if ((mmc1_prg & 0x10) == 0) wramArr[offset & 0x1FFF] = value
    } else if (mapperId == 4) {
        if (subMapper == 1) {
            if ((mmc3_bankSel & 0x20) != 0) {
                if (offset >= 0x7000 && offset <= 0x71FF) {
                    if ((mmc3_prgRamProt & 0x10) != 0) wramArr[offset & 0x3FF] = value
                } else if (offset >= 0x7200 && offset <= 0x73FF) {
                    if ((mmc3_prgRamProt & 0x40) != 0) wramArr[offset & 0x3FF] = value
                }
            }
        } else {
            // bit 7 = enable, bit 6 = write-protect (0 = writes allowed)
            if ((mmc3_prgRamProt & 0xC0) == 0x80) wramArr[offset & 0x1FFF] = value
        }
    } else if (mapperId == 69) {
        if (fme7_bank6IsRAM && fme7_bank6IsRAMEnabled) wramArr[offset & 0x1FFF] = value
    } else if (mapperId == 24 || mapperId == 26) {
        if (vrc6_prgRamEnable) wramArr[offset & 0x1FFF] = value
    }
}

function mapperWrite(offset, value) {
    switch (mapperId) {
        case 1: mmc1Write(offset, value); break
        case 2: uxromWrite(offset, value); break
        case 3: cnromWrite(offset, value); break
        case 4: mmc3Write(offset, value); break
        case 7: aoromWrite(offset, value); break
        case 24: case 26: vrc6Write(offset, value); break
        case 69: fme7Write(offset, value); break
        case 228: ines228Write(offset, value); break
        // NROM: no writable registers
    }
}

// ── MMC1 (iNES mapper 1) ──

function mmc1Init() {
    mmc1_shift = 0x10
    mmc1_ctrl  = 0x0C   // mode 3 (fix last at $C000), 4 KB CHR
    mmc1_chr0  = 0
    mmc1_chr1  = 0
    mmc1_prg   = 0
    mmc1RebuildPRG()
    mmc1RebuildCHR()
}

function mmc1Write(addr, val) {
    if (addr < 0x8000) return  // not a mapper reg
    // Bit 7 set: hard reset shift register
    if (val & 0x80) {
        mmc1_shift = 0x10
        mmc1_ctrl |= 0x0C
        mmc1RebuildPRG()
        return
    }
    // Serial-load bit 0 into shift register; bit 4 acts as done-sentinel
    let done = (mmc1_shift & 1) == 1
    mmc1_shift = (mmc1_shift >>> 1) | ((val & 1) << 4)
    if (!done) return
    // Completed 5-bit write: dispatch by address range
    let reg = mmc1_shift
    mmc1_shift = 0x10
    switch (addr & 0xE000) {
        case 0x8000:
            mmc1_ctrl = reg
            setMirrorMode(reg & 3)
            mmc1RebuildPRG()
            mmc1RebuildCHR()
            break
        case 0xA000:
            mmc1_chr0 = reg
            mmc1RebuildCHR()
            break
        case 0xC000:
            mmc1_chr1 = reg
            mmc1RebuildCHR()
            break
        case 0xE000:
            mmc1_prg = reg
            mmc1RebuildPRG()
            break
    }
}

function mmc1RebuildPRG() {
    let mode = (mmc1_ctrl >>> 2) & 3
    let numBanks16 = prgRomArr.length >>> 14  // number of 16 KB banks
    switch (mode) {
        case 0: case 1: {
            // 32 KB switch: ignore low bit of bank number
            let base = (mmc1_prg & 0x0E) * 0x4000
            for (let i = 0; i < 0x8000; i++)
                romArr[i] = prgRomArr[(base + i) % prgRomArr.length]
            break
        }
        case 2:
            // Fix bank 0 at $8000, switch at $C000
            for (let i = 0; i < 0x4000; i++) romArr[i] = prgRomArr[i % prgRomArr.length]
            {   let base = (mmc1_prg & 0x0F) * 0x4000
                for (let i = 0; i < 0x4000; i++)
                    romArr[0x4000 + i] = prgRomArr[(base + i) % prgRomArr.length]
            }
            break
        case 3:
            // Switch at $8000, fix last bank at $C000
            {   let base = (mmc1_prg & 0x0F) * 0x4000
                for (let i = 0; i < 0x4000; i++)
                    romArr[i] = prgRomArr[(base + i) % prgRomArr.length]
            }
            {   let last = prgRomArr.length - 0x4000
                for (let i = 0; i < 0x4000; i++) romArr[0x4000 + i] = prgRomArr[last + i]
            }
            break
    }
}

function mmc1RebuildCHR() {
    if (chrBanks == 0) return  // CHR RAM: no banking
    if ((mmc1_ctrl & 0x10) != 0) {
        // 4 KB mode: two independent 4 KB banks
        let base0 = (mmc1_chr0 & 0x1F) * 0x1000
        let base1 = (mmc1_chr1 & 0x1F) * 0x1000
        for (let i = 0; i < 0x1000; i++) chrArr[i]        = chrRomArr[(base0 + i) % chrRomArr.length]
        for (let i = 0; i < 0x1000; i++) chrArr[0x1000 + i] = chrRomArr[(base1 + i) % chrRomArr.length]
    } else {
        // 8 KB mode: one bank from chr0 (ignore low bit)
        let base = (mmc1_chr0 & 0x1E) * 0x1000
        for (let i = 0; i < 0x2000; i++) chrArr[i] = chrRomArr[(base + i) % chrRomArr.length]
    }
}

// ── MMC3 (iNES mapper 4) / MMC6 (submapper 1) ──

function mmc3Init() {
    mmc3_bankSel = 0; mmc3_bankA = 0; mmc3_bank8C = 0
    mmc3_chr2K0 = 0; mmc3_chr2K8 = 0
    mmc3_chr1K0 = 0; mmc3_chr1K4 = 0; mmc3_chr1K8 = 0; mmc3_chr1KC = 0
    mmc3_irqLatch = 0; mmc3_irqCounter = 0
    mmc3_irqEnable = false; mmc3_irqReload = false; mmc3_prgRamProt = 0; mmc3_irqPending = false
    mmc3RebuildPRG()
    mmc3RebuildCHR()
}

function mmc3Write(addr, val) {
    if (addr < 0x8000) return
    switch (addr & 0xE001) {
        case 0x8000: mmc3_bankSel = val; mmc3RebuildPRG(); mmc3RebuildCHR(); break
        case 0x8001:
            switch (mmc3_bankSel & 7) {
                case 0: mmc3_chr2K0 = val & 0xFE; mmc3RebuildCHR(); break
                case 1: mmc3_chr2K8 = val & 0xFE; mmc3RebuildCHR(); break
                case 2: mmc3_chr1K0 = val; mmc3RebuildCHR(); break
                case 3: mmc3_chr1K4 = val; mmc3RebuildCHR(); break
                case 4: mmc3_chr1K8 = val; mmc3RebuildCHR(); break
                case 5: mmc3_chr1KC = val; mmc3RebuildCHR(); break
                case 6:
                    mmc3_bank8C = val & ((prgBanks * 2) - 1)
                    mmc3RebuildPRG()
                    break
                case 7:
                    mmc3_bankA  = val & ((prgBanks * 2) - 1)
                    mmc3RebuildPRG()
                    break
            }
            break
        case 0xA000: setMirrorMode((val & 1) ? 3 : 2); break  // 1 = horiz, 0 = vert
        case 0xA001: mmc3_prgRamProt = val; break
        case 0xC000: mmc3_irqLatch = val; break
        case 0xC001: mmc3_irqCounter = 0xFF; mmc3_irqReload = true; break
        case 0xE000: mmc3_irqEnable = false; mmc3_irqPending = false;
                     cpu_irqLevel = apu_fcIrqFlag || apu_dmcIrqFlag || fme7_irqPending || vrc6_irqPending; break  // ack MMC3 IRQ
        case 0xE001: mmc3_irqEnable = true; break
    }
}

function mmc3RebuildPRG() {
    // MMC3 PRG: 4 × 8 KB slots. Bit 6 of bankSel swaps which slot is fixed vs. swappable.
    let lastBank8K = prgBanks * 2 - 1  // index of last 8 KB bank
    let fixedAt8   = (mmc3_bankSel & 0x40) != 0  // if true: $8000 fixed, $C000 swappable; else vice versa
    let sl0 = fixedAt8 ? (lastBank8K - 1) : mmc3_bank8C  // $8000 slot
    let sl2 = fixedAt8 ? mmc3_bank8C : (lastBank8K - 1)  // $C000 slot
    mmc3CopyPRGSlot(0,      sl0)
    mmc3CopyPRGSlot(0x2000, mmc3_bankA)
    mmc3CopyPRGSlot(0x4000, sl2)
    mmc3CopyPRGSlot(0x6000, lastBank8K)
}
function mmc3CopyPRGSlot(destOff, bankIdx8K) {
    let src = (bankIdx8K & (prgBanks * 2 - 1)) * 0x2000
    for (let i = 0; i < 0x2000; i++) romArr[destOff + i] = prgRomArr[src + i]
}

function mmc3RebuildCHR() {
    if (chrBanks == 0) return  // CHR RAM: no banking
    // Bit 7 of bankSel: 0 = 2 KB at $0000/$0800, 1 KB at $1000-$1FFF
    //                   1 = swap: 1 KB at $0000-$0FFF, 2 KB at $1000/$1800
    let inv = (mmc3_bankSel & 0x80) != 0
    if (!inv) {
        mmc3CopyCHR2K(0,      mmc3_chr2K0)
        mmc3CopyCHR2K(0x800,  mmc3_chr2K8)
        mmc3CopyCHR1K(0x1000, mmc3_chr1K0)
        mmc3CopyCHR1K(0x1400, mmc3_chr1K4)
        mmc3CopyCHR1K(0x1800, mmc3_chr1K8)
        mmc3CopyCHR1K(0x1C00, mmc3_chr1KC)
    } else {
        mmc3CopyCHR1K(0,      mmc3_chr1K0)
        mmc3CopyCHR1K(0x400,  mmc3_chr1K4)
        mmc3CopyCHR1K(0x800,  mmc3_chr1K8)
        mmc3CopyCHR1K(0xC00,  mmc3_chr1KC)
        mmc3CopyCHR2K(0x1000, mmc3_chr2K0)
        mmc3CopyCHR2K(0x1800, mmc3_chr2K8)
    }
}
function mmc3CopyCHR2K(destOff, bankIdx) {
    let src = (bankIdx & (chrBanks * 8 - 1)) * 0x400
    for (let i = 0; i < 0x800; i++) chrArr[destOff + i] = chrRomArr[src + i]
}
function mmc3CopyCHR1K(destOff, bankIdx) {
    let src = (bankIdx & (chrBanks * 8 - 1)) * 0x400
    for (let i = 0; i < 0x400; i++) chrArr[destOff + i] = chrRomArr[src + i]
}

// Called once per visible + pre-render scanline by stepPPU (per-scanline IRQ approximation)
function mmc3ClockScanline() {
    if (mmc3_irqReload || mmc3_irqCounter == 0) {
        mmc3_irqCounter = mmc3_irqLatch
        mmc3_irqReload  = false
    } else {
        mmc3_irqCounter = (mmc3_irqCounter - 1) & 0xFF
    }
    if (mmc3_irqCounter == 0 && mmc3_irqEnable) { cpu_irqLevel = true; mmc3_irqPending = true }
}

// ── UxROM (iNES mapper 2) ──

function uxromInit() {
    uxrom_bankSel = 0
    uxromCopyPRG()
    // UxROM boards typically have CHR RAM; if a ROM provides CHR, seed it
    if (chrBanks > 0) {
        let copyLen = Math.min(chrRomArr.length, 0x2000)
        for (let i = 0; i < copyLen; i++) chrArr[i] = chrRomArr[i]
    }
}

function uxromWrite(addr, val) {
    if (addr < 0x8000) return
    uxrom_bankSel = val & 0x0F
    uxromCopyPRG()
}

function uxromCopyPRG() {
    let numBanks = prgRomArr.length >>> 14  // count of 16 KB banks
    let bank = uxrom_bankSel % numBanks
    let base = bank * 0x4000
    for (let i = 0; i < 0x4000; i++) romArr[i] = prgRomArr[base + i]
    let last = prgRomArr.length - 0x4000
    for (let i = 0; i < 0x4000; i++) romArr[0x4000 + i] = prgRomArr[last + i]
}

// ── CNROM (iNES mapper 3) ──

function cnromInit() {
    cnrom_chrBank = 0
    // PRG is fixed (like NROM): mirror into 32 KB shadow
    for (let i = 0; i < 0x8000; i++) romArr[i] = prgRomArr[i % prgRomArr.length]
    cnromCopyCHR()
}

function cnromWrite(addr, val) {
    if (addr < 0x8000) return
    cnrom_chrBank = val & 0x3
    cnromCopyCHR()
}

function cnromCopyCHR() {
    if (chrBanks == 0) return  // CHR RAM: no banking
    let mask = chrRomArr.length - 1
    let base = cnrom_chrBank * 0x2000
    for (let i = 0; i < 0x2000; i++) chrArr[i] = chrRomArr[(base + i) & mask]
}

function aoromInit() {
    aorom_bankSel = 0
    aoRomCopyPRGSlot(0, 0)
    setMirrorMode(0)  // single-screen NT0
}

function aoromWrite(addr, val) {
    if (addr < 0x8000) return
    aorom_bankSel = val
    aoRomCopyPRGSlot(0, val & 7)           // bits 2-0: 32 KB PRG bank select
    setMirrorMode((val >>> 4) & 1)          // bit 4: 0 = single-screen NT0, 1 = NT1
}

function aoRomCopyPRGSlot(destOff, bank) {
    let mask = prgRomArr.length - 1
    let src  = bank * 0x8000
    for (let i = 0; i < 0x8000; i++) romArr[destOff + i] = prgRomArr[(src + i) & mask]
}

// ── Sunsoft FME-7 / iNES mapper 69 ──

function fme7Init() {
    fme7_cmd = 0
    fme7_chr.fill(0)
    fme7_prg6 = 0; fme7_bank6IsRAM = false; fme7_bank6IsRAMEnabled = false
    fme7_prg8 = 0; fme7_prgA = 0; fme7_prgC = 0
    fme7_irqEnable = false; fme7_irqCountEnable = false
    fme7_irqCounter = 0; fme7_irqPending = false
    s5b_regSel = 0; s5b_regs.fill(0)
    // Reg 7 default: all channels disabled (all 1s in low 6 bits)
    s5b_regs[7] = 0x3F
    fme7RebuildPRG()
    fme7RebuildCHR()
    setMirrorMode(2)  // default vertical
}

function fme7Write(addr, val) {
    if (addr < 0x8000) return
    let range = addr & 0xE000
    if (range == 0x8000) {
        // Command register (which internal register the next $A000 write targets)
        fme7_cmd = val & 0x0F
    } else if (range == 0xA000) {
        // Parameter for the selected register
        switch (fme7_cmd) {
            case 0: case 1: case 2: case 3:
            case 4: case 5: case 6: case 7:
                fme7_chr[fme7_cmd] = val
                fme7RebuildCHR()
                break
            case 8:
                fme7_prg6 = val & 0x3F
                fme7_bank6IsRAM = (val & 0x40) != 0
                fme7_bank6IsRAMEnabled = (val & 0x80) != 0
                break
            case 9:  fme7_prg8 = val & 0x3F; fme7RebuildPRG(); break
            case 10: fme7_prgA = val & 0x3F; fme7RebuildPRG(); break
            case 11: fme7_prgC = val & 0x3F; fme7RebuildPRG(); break
            case 12:
                // 0=V, 1=H, 2=1ScA (NT0), 3=1ScB (NT1)
                // setMirrorMode:  0=1ScA, 1=1ScB, 2=V, 3=H
                switch (val & 3) {
                    case 0: setMirrorMode(2); break
                    case 1: setMirrorMode(3); break
                    case 2: setMirrorMode(0); break
                    case 3: setMirrorMode(1); break
                }
                break
            case 13:
                fme7_irqEnable       = (val & 0x01) != 0
                fme7_irqCountEnable  = (val & 0x80) != 0
                fme7_irqPending      = false
                // Re-evaluate global IRQ line from remaining sources
                cpu_irqLevel = apu_fcIrqFlag || apu_dmcIrqFlag || mmc3_irqPending
                break
            case 14: fme7_irqCounter = (fme7_irqCounter & 0xFF00) | val; break
            case 15: fme7_irqCounter = (fme7_irqCounter & 0x00FF) | (val << 8); break
        }
    } else if (range == 0xC000) {
        // Sunsoft 5B audio: register select
        s5b_regSel = val & 0x0F
    } else if (range == 0xE000) {
        // Sunsoft 5B audio: register data
        s5b_regs[s5b_regSel] = val
    }
}

function fme7RebuildPRG() {
    // 3 × 8 KB swappable slots at $8000/$A000/$C000, plus fixed last 8 KB at $E000.
    // $6000-$7FFF is handled on-the-fly in mapperReadWRAM (it can be RAM or ROM).
    let romLen = prgRomArr.length
    fme7CopyPRG8K(0,      fme7_prg8)
    fme7CopyPRG8K(0x2000, fme7_prgA)
    fme7CopyPRG8K(0x4000, fme7_prgC)
    // Fixed last 8 KB bank
    let lastOff = romLen - 0x2000
    for (let i = 0; i < 0x2000; i++) romArr[0x6000 + i] = prgRomArr[lastOff + i]
}

function fme7CopyPRG8K(destOff, bank) {
    let romLen = prgRomArr.length
    let base   = (bank * 0x2000) % romLen
    for (let i = 0; i < 0x2000; i++) romArr[destOff + i] = prgRomArr[(base + i) % romLen]
}

function fme7RebuildCHR() {
    if (chrBanks == 0) return  // CHR RAM: no banking
    let chrLen = chrRomArr.length
    let mask   = chrLen - 1    // chrLen is a power of two for conforming ROMs
    for (let slot = 0; slot < 8; slot++) {
        let base = (fme7_chr[slot] * 0x400) & mask
        let destOff = slot * 0x400
        for (let i = 0; i < 0x400; i++) chrArr[destOff + i] = chrRomArr[(base + i) & mask]
    }
}

// ── Konami VRC6 (iNES mapper 24 / 26) ──

function vrc6Init() {
    vrc6_prg16 = 0; vrc6_prg8 = 0
    vrc6_chr.fill(0)
    vrc6_mirror = 0; vrc6_prgRamEnable = false
    vrc6_irqLatch = 0; vrc6_irqCounter = 0; vrc6_irqPrescaler = 341
    vrc6_irqEnable = false; vrc6_irqAck = false; vrc6_irqMode = false
    vrc6_irqPending = false
    vrc6_p1Vol = 0; vrc6_p1Duty = 0; vrc6_p1Mode = false; vrc6_p1Period = 0; vrc6_p1En = false
    vrc6_p2Vol = 0; vrc6_p2Duty = 0; vrc6_p2Mode = false; vrc6_p2Period = 0; vrc6_p2En = false
    vrc6_sawRate = 0; vrc6_sawPeriod = 0; vrc6_sawEn = false
    vrc6RebuildPRG()
    vrc6RebuildCHR()
    setMirrorMode(2)  // default vertical
}

function vrc6Write(addr, val) {
    if (addr < 0x8000) return
    // VRC6b swaps CPU A0 and A1 when selecting a register inside a $X000 group
    let reg = addr & 3
    if (vrc6_variant == 1) reg = ((reg & 1) << 1) | ((reg >>> 1) & 1)
    switch (addr & 0xF000) {
        case 0x8000: vrc6_prg16 = val & 0x0F; vrc6RebuildPRG(); break
        case 0x9000:
            switch (reg) {
                case 0: vrc6_p1Vol  = val & 0x0F
                        vrc6_p1Duty = (val >>> 4) & 7
                        vrc6_p1Mode = (val & 0x80) != 0
                        break
                case 1: vrc6_p1Period = (vrc6_p1Period & 0xF00) | val; break
                case 2: vrc6_p1Period = (vrc6_p1Period & 0x0FF) | ((val & 0x0F) << 8)
                        vrc6_p1En = (val & 0x80) != 0
                        break
                case 3: /* frequency ctrl (halt + 4/256 mode) — not synthesised */ break
            }
            break
        case 0xA000:
            switch (reg) {
                case 0: vrc6_p2Vol  = val & 0x0F
                        vrc6_p2Duty = (val >>> 4) & 7
                        vrc6_p2Mode = (val & 0x80) != 0
                        break
                case 1: vrc6_p2Period = (vrc6_p2Period & 0xF00) | val; break
                case 2: vrc6_p2Period = (vrc6_p2Period & 0x0FF) | ((val & 0x0F) << 8)
                        vrc6_p2En = (val & 0x80) != 0
                        break
            }
            break
        case 0xB000:
            switch (reg) {
                case 0: vrc6_sawRate = val & 0x3F; break
                case 1: vrc6_sawPeriod = (vrc6_sawPeriod & 0xF00) | val; break
                case 2: vrc6_sawPeriod = (vrc6_sawPeriod & 0x0FF) | ((val & 0x0F) << 8)
                        vrc6_sawEn = (val & 0x80) != 0
                        break
                case 3:
                    vrc6_mirror = (val >>> 2) & 3
                    vrc6_prgRamEnable = (val & 0x80) != 0
                    vrc6ApplyMirror()
                    break
            }
            break
        case 0xC000: vrc6_prg8 = val & 0x1F; vrc6RebuildPRG(); break
        case 0xD000: vrc6_chr[reg] = val; vrc6RebuildCHR(); break
        case 0xE000: vrc6_chr[4 + reg] = val; vrc6RebuildCHR(); break
        case 0xF000:
            switch (reg) {
                case 0: vrc6_irqLatch = val; break
                case 1:
                    vrc6_irqAck    = (val & 1) != 0
                    vrc6_irqEnable = (val & 2) != 0
                    vrc6_irqMode   = (val & 4) != 0
                    if (vrc6_irqEnable) {
                        vrc6_irqCounter   = vrc6_irqLatch
                        vrc6_irqPrescaler = 341
                    }
                    vrc6_irqPending = false
                    cpu_irqLevel = apu_fcIrqFlag || apu_dmcIrqFlag || mmc3_irqPending || fme7_irqPending || vrc6_irqPending
                    break
                case 2:
                    vrc6_irqPending = false
                    vrc6_irqEnable = vrc6_irqAck
                    cpu_irqLevel = apu_fcIrqFlag || apu_dmcIrqFlag || mmc3_irqPending || fme7_irqPending || vrc6_irqPending
                    break
            }
            break
    }
}

function vrc6RebuildPRG() {
    let romLen = prgRomArr.length
    // $8000-$BFFF: 16 KB swappable
    let base1 = (vrc6_prg16 * 0x4000) % romLen
    for (let i = 0; i < 0x4000; i++) romArr[i] = prgRomArr[(base1 + i) % romLen]
    // $C000-$DFFF: 8 KB swappable
    let base2 = (vrc6_prg8 * 0x2000) % romLen
    for (let i = 0; i < 0x2000; i++) romArr[0x4000 + i] = prgRomArr[(base2 + i) % romLen]
    // $E000-$FFFF: last 8 KB fixed
    let lastOff = romLen - 0x2000
    for (let i = 0; i < 0x2000; i++) romArr[0x6000 + i] = prgRomArr[lastOff + i]
}

function vrc6RebuildCHR() {
    if (chrBanks == 0) return  // CHR RAM: no banking
    let chrLen = chrRomArr.length
    let mask   = chrLen - 1   // chrLen is a power of two for conforming ROMs
    for (let slot = 0; slot < 8; slot++) {
        let base = (vrc6_chr[slot] * 0x400) & mask
        let destOff = slot * 0x400
        for (let i = 0; i < 0x400; i++) chrArr[destOff + i] = chrRomArr[(base + i) & mask]
    }
}

function vrc6ApplyMirror() {
    // $B003 bits 3–2: 00=V, 01=H, 10=1ScA (NT0), 11=1ScB (NT1)
    switch (vrc6_mirror) {
        case 0: setMirrorMode(2); break
        case 1: setMirrorMode(3); break
        case 2: setMirrorMode(0); break
        case 3: setMirrorMode(1); break
    }
}

// Called from run() per-CPU-instruction batch. Ticks the IRQ counter either per
// CPU cycle (mode 1) or once per 341 PPU dots (mode 0 — scanline mode); when the
// 8-bit counter wraps past $FF it reloads from latch and asserts IRQ.
function vrc6ClockIRQ(cycles) {
    if (!vrc6_irqEnable) return
    if (vrc6_irqMode) {
        // Cycle mode: one tick per CPU cycle
        let cnt = vrc6_irqCounter + cycles
        if (cnt >= 0x100) {
            vrc6_irqPending = true; cpu_irqLevel = true
            cnt = (vrc6_irqLatch + (cnt - 0x100)) & 0xFF
        }
        vrc6_irqCounter = cnt
    } else {
        // Scanline mode: prescaler counts 341 PPU dots (= cycles * 3 dots/cycle)
        vrc6_irqPrescaler -= cycles * 3
        while (vrc6_irqPrescaler <= 0) {
            vrc6_irqPrescaler += 341
            if (vrc6_irqCounter == 0xFF) {
                vrc6_irqCounter = vrc6_irqLatch
                vrc6_irqPending = true; cpu_irqLevel = true
            } else {
                vrc6_irqCounter = (vrc6_irqCounter + 1) & 0xFF
            }
        }
    }
}

// Called from run() per-CPU-instruction. When the 16-bit counter underflows
// from $0000 to $FFFF and IRQs are enabled, assert an IRQ.
function fme7ClockIRQ(cycles) {
    if (!fme7_irqCountEnable) return
    let prev = fme7_irqCounter
    fme7_irqCounter = (prev - cycles) & 0xFFFF
    if (cycles > prev && fme7_irqEnable) {
        cpu_irqLevel = true
        fme7_irqPending = true
    }
}

function ines228Init() {
    ines228Write(0x8000, 0)
}

function ines228Write(addr, val) {
    if (addr < 0x8000) return
    let chr      = ((addr & 15) << 2) | (val & 3)  // CHR[5:2]=addr[3:0], CHR[1:0]=data[1:0]
    let prg      = (addr >>> 6) & 0x1F              // PRG page within chip (addr bits 10-6)
    let prgMode  = (addr >>> 5) & 1                 // 0=split even/odd, 1=mirror same page
    let chip     = (addr >>> 11) & 3                // PRG chip select (addr bits 12-11)
    let mirroring = (addr >>> 13) & 1               // 0=vert, 1=horz (addr bit 13)

    ines228CopyCHR8K(0, chr)
    if (prgMode == 0) {  // split: even page at $8000, odd page at $C000
        let base = prg & 0x1E
        ines228CopyPRGSlot(0,      base,     chip)
        ines228CopyPRGSlot(0x4000, base + 1, chip)
    } else {             // mirror: same page at both $8000 and $C000
        ines228CopyPRGSlot(0,      prg, chip)
        ines228CopyPRGSlot(0x4000, prg, chip)
    }
    setMirrorMode(mirroring + 2)
}

function ines228CopyCHR8K(destOff, bankIdx) {
    let src = bankIdx * 0x2000
    for (let i = 0; i < 0x2000; i++) chrArr[destOff + i] = chrRomArr[src + i]
}

function ines228CopyPRGSlot(destOff, prg, chip) {
    let chipBase = [0x0, 0x80000, null, 0x100000][chip]
    if (chipBase === null) {  // chip 2 does not exist → open bus
        for (let i = 0; i < 0x4000; i++) romArr[destOff + i] = dataBus
    } else {
        let src = chipBase + prg * 0x4000
        for (let i = 0; i < 0x4000; i++) romArr[destOff + i] = prgRomArr[src + i]
    }
}

///////////////////////////////////////////////////////////////////////////////

const fullFilePath = _G.shell.resolvePathInput(exec_args[1])
if (fullFilePath === undefined) {
    println(`Usage: ${exec_args[0]} path_to_rom.nes`)
    return 1
}

// ── Item 1: read() uses typed arrays, zero sys.peek in hot path ──
function read(offset) {
    // CPU RAM ($0000–$1FFF, 2KB mirrored)
    if (offset < 0x2000) return dataBus = ramArr[offset & 0x7FF]
    // PPU registers ($2000–$3FFF, mirrors of $2000–$2007)
    if (offset < 0x4000) {
        offset &= 0x2007
        switch (offset) {
            case 0x2002: { // PPUSTATUS — lower 5 bits are open bus
                let ppuStatus = (dataBus & 0x1F)
                if (ppu_vblank)            ppuStatus |= 0x80
                if (e.ppuStatusSprZeroHit)  ppuStatus |= 0x40
                if (e.ppuStatusOverflow)    ppuStatus |= 0x20
                ppu_vblank   = false
                e.writeLatch  = false
                return dataBus = ppuStatus
            }
            case 0x2007: { // PPUDATA (buffered read)
                let temp = e.ppuReadBuffer
                let vramAddr = e.vramAddr
                if (vramAddr >= 0x3F00) {
                    temp = readPPU(vramAddr)
                } else {
                    e.ppuReadBuffer = readPPU(vramAddr)
                }
                e.vramAddr = (vramAddr + (e.ppuVramInc32Mode ? 32 : 1)) & 0x3FFF
                return dataBus = temp
            }
            default: return dataBus  // write-only regs return open bus
        }
    }
    // APU status register ($4015) — reading also clears frame IRQ flag
    if (offset == 0x4015) {
        let s = 0
        if (apu_p1LenCnt  > 0) s |= 1
        if (apu_p2LenCnt  > 0) s |= 2
        if (apu_triLenCnt > 0) s |= 4
        if (apu_nsLenCnt  > 0) s |= 8
        if (apu_dmcBytesRem > 0) s |= 16
        if (apu_fcIrqFlag)  s |= 64
        if (apu_dmcIrqFlag) s |= 128
        apu_fcIrqFlag = false  // reading $4015 clears frame IRQ (simplified: no 1-cycle delay)
        cpu_irqLevel = apu_dmcIrqFlag || mmc3_irqPending || fme7_irqPending || vrc6_irqPending
        return dataBus = s
    }
    // Controller 1 ($4016) — NES shift register sends LSB first (A=bit0, B=bit1, ...)
    if (offset == 0x4016) {
        let bit = e.cnt1sr & 1
        e.cnt1sr = e.cnt1sr >>> 1
        return dataBus = bit
    }
    // Controller 2 ($4017)
    if (offset == 0x4017) {
        let bit = e.cnt2sr & 1
        e.cnt2sr = e.cnt2sr >>> 1
        return dataBus = bit
    }
    // PRG ROM ($8000–$FFFF)
    if (offset >= 0x8000) return dataBus = romArr[offset - 0x8000]
    // WRAM / cartridge RAM ($6000–$7FFF)
    if (offset >= 0x6000) return mapperReadWRAM(offset)
    // Unmapped ($4018–$5FFF)
    return dataBus
}

function readSigned(offset) {
    let t = read(offset)
    return t > 127 ? t - 256 : t
}

// ── Item 1: write() uses typed arrays ──
function write(offset0, value) {
    let offset = offset0 & 0xFFFF
    // CPU RAM ($0000–$1FFF, 2KB mirrored)
    if (offset < 0x2000) { ramArr[offset & 0x7FF] = value; return }
    // PPU registers
    if (offset < 0x4000) {
        offset &= 0x2007
        switch (offset) {
            case 0x2000: // PPUCTRL
                e.ppuNametableSelect  = value & 3
                e.ppuVramInc32Mode    = (value & 4)   != 0
                e.ppuSpritePatternTable = (value & 8)  != 0
                e.ppuBGPatternTable   = (value & 16)  != 0
                e.ppuUse8x16Sprites   = (value & 32)  != 0
                ppu_enableNMI        = (value & 128) != 0
                // propagate NT bits into _tempVramAddr bits 10–11
                e._tempVramAddr = (e._tempVramAddr & 0b0111001111111111) | ((value & 3) << 10)
                // also mirror into transferAddr: SMB writes PPUSCROLL before the final PPUCTRL,
                // so transferAddr picks up wrong NT bits from the last PPUADDR high byte unless
                // we correct them here.
                e.transferAddr  = (e.transferAddr  & 0b0111001111111111) | ((value & 3) << 10)
                break
            case 0x2001: // PPUMASK
                e.ppuMask8pxMaskBG      = (value & 2)  != 0
                e.ppuMask8pxMaskSprites = (value & 4)  != 0
                e.ppuMaskRenderBG       = (value & 8)  != 0
                e.ppuMaskRenderSprites  = (value & 16) != 0
                break
            case 0x2002: break // PPUSTATUS (read-only)
            case 0x2003: // OAMADDR
                e.ppuOAMaddr = value
                break
            case 0x2004: // OAMDATA
                oamArr[e.ppuOAMaddr] = value
                e.ppuOAMaddr = (e.ppuOAMaddr + 1) & 0xFF
                break
            case 0x2005: // PPUSCROLL
                if (!e.writeLatch) {
                    e.ppuScrollFineX   = value & 7
                    e._tempVramAddr    = (e._tempVramAddr & 0b0111111111100000) | (value >>> 3)
                    e.writeLatch       = true
                } else {
                    e.transferAddr = (e._tempVramAddr & 0b0000110000011111)
                                   | (((value & 0xF8) << 2) | ((value & 7) << 12))
                    e.writeLatch   = false
                }
                break
            case 0x2006: // PPUADDR
                if (!e.writeLatch) {
                    // Preserve bits 7:0 of _tempVramAddr (NES hardware leaves them intact)
                    e._tempVramAddr = (e._tempVramAddr & 0x00FF) | ((value & 0x3F) << 8)
                    e.writeLatch    = true
                } else {
                    let w = e._tempVramAddr | value
                    e.vramAddr   = w
                    e.transferAddr = w
                    e.writeLatch = false
                }
                break
            case 0x2007: { // PPUDATA
                let vramAddr = e.vramAddr
                if (vramAddr < 0x2000) {
                    // CHR RAM (only when no CHR ROM)
                    if (chrBanks == 0) chrArr[vramAddr] = value
                } else if (vramAddr < 0x3F00) {
                    // Nametable VRAM (mirroring via ntSlot LUT)
                    vramArr[ntSlot[(vramAddr >>> 10) & 3] * 0x400 + (vramAddr & 0x3FF)] = value
                } else {
                    // Palette RAM
                    if ((vramAddr & 3) == 0) {
                        palArr[vramAddr & 0x0F] = value
                    } else {
                        palArr[vramAddr & 0x1F] = value
                    }
                }
                e.vramAddr = (vramAddr + (e.ppuVramInc32Mode ? 32 : 1)) & 0x3FFF
                break
            }
        }
        return
    }
    // APU / IO registers ($4000–$401F)
    if (offset < 0x4020) {
        switch (offset) {
            // ── Item 9: OAM DMA with bulk typed-array copy ──
            case 0x4014: {
                let src = value << 8
                if (src < 0x2000) {
                    // RAM source — fast path using typed array
                    let base = src & 0x7FF
                    for (let i = 0; i < 256; i++) {
                        oamArr[i] = ramArr[(base + i) & 0x7FF]
                    }
                } else if (src >= 0x8000) {
                    // ROM source (uncommon)
                    let rbase = src - 0x8000
                    for (let i = 0; i < 256; i++) {
                        oamArr[i] = romArr[rbase + i]
                    }
                } else {
                    // Other sources (slow path, very rare)
                    for (let i = 0; i < 256; i++) {
                        oamArr[i] = read(src + i)
                    }
                }
                cycles += 513  // OAM DMA CPU stall
                break
            }
            // ── APU registers ──
            // Pulse 1
            case 0x4000:
                apu_p1Duty    = (value >> 6) & 3
                apu_p1LenHalt = (value & 0x20) != 0
                apu_p1EnvConst = (value & 0x10) != 0
                apu_p1EnvVol  = value & 0x0F
                break
            case 0x4001:
                apu_p1SweepEnable = (value & 0x80) != 0
                apu_p1SweepPeriod = (value >> 4) & 7
                apu_p1SweepNegate = (value & 8) != 0
                apu_p1SweepShift  = value & 7
                apu_p1SweepReload = true
                break
            case 0x4002:
                apu_p1TimerReload = (apu_p1TimerReload & 0x700) | value
                break
            case 0x4003:
                apu_p1TimerReload = (apu_p1TimerReload & 0xFF) | ((value & 7) << 8)
                if (apu_p1Enable) apu_p1LenCnt = APU_LEN_LUT[value >> 3]
                apu_p1EnvStart = true
                break
            // Pulse 2
            case 0x4004:
                apu_p2Duty    = (value >> 6) & 3
                apu_p2LenHalt = (value & 0x20) != 0
                apu_p2EnvConst = (value & 0x10) != 0
                apu_p2EnvVol  = value & 0x0F
                break
            case 0x4005:
                apu_p2SweepEnable = (value & 0x80) != 0
                apu_p2SweepPeriod = (value >> 4) & 7
                apu_p2SweepNegate = (value & 8) != 0
                apu_p2SweepShift  = value & 7
                apu_p2SweepReload = true
                break
            case 0x4006:
                apu_p2TimerReload = (apu_p2TimerReload & 0x700) | value
                break
            case 0x4007:
                apu_p2TimerReload = (apu_p2TimerReload & 0xFF) | ((value & 7) << 8)
                if (apu_p2Enable) apu_p2LenCnt = APU_LEN_LUT[value >> 3]
                apu_p2EnvStart = true
                break
            // Triangle
            case 0x4008:
                apu_triLenHalt     = (value & 0x80) != 0
                apu_triLinReloadVal = value & 0x7F
                break
            case 0x400A:
                apu_triTimerReload = (apu_triTimerReload & 0x700) | value
                break
            case 0x400B:
                apu_triTimerReload = (apu_triTimerReload & 0xFF) | ((value & 7) << 8)
                if (apu_triEnable) apu_triLenCnt = APU_LEN_LUT[value >> 3]
                apu_triLinReload = true
                break
            // Noise
            case 0x400C:
                apu_nsLenHalt  = (value & 0x20) != 0
                apu_nsEnvConst = (value & 0x10) != 0
                apu_nsEnvVol   = value & 0x0F
                break
            case 0x400E:
                apu_nsMode    = (value & 0x80) != 0
                apu_nsTimerIdx = value & 0x0F
                break
            case 0x400F:
                if (apu_nsEnable) apu_nsLenCnt = APU_LEN_LUT[value >> 3]
                apu_nsEnvStart = true
                break
            // DMC
            case 0x4010:
                apu_dmcIrqEn = (value & 0x80) != 0
                apu_dmcLoop  = (value & 0x40) != 0
                apu_dmcRate  = APU_DMC_RATE_LUT[value & 0x0F]
                if (!apu_dmcIrqEn) {
                    apu_dmcIrqFlag = false
                    cpu_irqLevel = apu_fcIrqFlag || mmc3_irqPending || fme7_irqPending || vrc6_irqPending
                }
                break
            case 0x4011:
                apu_dmcOutput = value & 0x7F
                break
            case 0x4012:
                apu_dmcSampleAddr = 0xC000 | (value << 6)
                break
            case 0x4013:
                apu_dmcSampleLen = (value << 4) | 1
                break
            // $4015 — channel enables + DMC control
            case 0x4015: {
                let wasEnabled = apu_dmcEnable
                apu_p1Enable  = (value & 1)  != 0;  if (!apu_p1Enable)  apu_p1LenCnt  = 0
                apu_p2Enable  = (value & 2)  != 0;  if (!apu_p2Enable)  apu_p2LenCnt  = 0
                apu_triEnable = (value & 4)  != 0;  if (!apu_triEnable) apu_triLenCnt = 0
                apu_nsEnable  = (value & 8)  != 0;  if (!apu_nsEnable)  apu_nsLenCnt  = 0
                apu_dmcEnable = (value & 16) != 0
                apu_dmcIrqFlag = false
                cpu_irqLevel = apu_fcIrqFlag || mmc3_irqPending || fme7_irqPending || vrc6_irqPending
                if (apu_dmcEnable && apu_dmcBytesRem == 0) {
                    // Restart DMC sample
                    apu_dmcAddrCounter = apu_dmcSampleAddr
                    apu_dmcBytesRem    = apu_dmcSampleLen
                    // Schedule buffer fill on the next DMC timer tick (set timer to fire soon)
                    if (apu_dmcSilent) apu_dmcTimer = Math.min(apu_dmcTimer, 2)
                } else if (!apu_dmcEnable) {
                    apu_dmcBytesRem = 0
                }
                break
            }
            case 0x4016: // Controller strobe
                e.cnt1sr = e.currentButtonStatus
                e.cnt2sr = 0
                break
            // $4017 — frame counter mode + IRQ inhibit
            case 0x4017: {
                apu_fcMode       = (value & 0x80) != 0 ? 1 : 0
                apu_fcInhibitIrq = (value & 0x40) != 0
                apu_fcResetDelay = 3  // reset counter 3–4 CPU cycles later
                if (apu_fcInhibitIrq) {
                    apu_fcIrqFlag = false
                    cpu_irqLevel = apu_dmcIrqFlag || mmc3_irqPending || fme7_irqPending || vrc6_irqPending
                }
                // In 5-step mode, immediately fire QF + HF
                if (apu_fcMode == 1) {
                    apuClockQF()
                    apuClockHF()
                }
                break
            }
            default: break
        }
        return
    }
    // Cartridge PRG ROM / mapper registers ($8000–$FFFF)
    if (offset >= 0x8000) { mapperWrite(offset, value); return }
    // WRAM / cartridge RAM ($6000–$7FFF)
    if (offset >= 0x6000) { mapperWriteWRAM(offset, value); return }
    // $4020–$5FFF: expansion — unused
}

// Stack is always $0100–$01FF (always in CPU RAM) — bypass read()/write() dispatch.
function push(value) {
    ramArr[0x100 + cpu_sp] = value
    cpu_sp = (cpu_sp - 1) & 0xFF
}

function pull() {
    cpu_sp = (cpu_sp + 1) & 0xFF
    return ramArr[0x100 + cpu_sp]
}

function pullu16() {
    let sp = (cpu_sp + 1) & 0xFF
    let lo = ramArr[0x100 + sp]
    sp = (sp + 1) & 0xFF
    let hi = ramArr[0x100 + sp]
    cpu_sp = sp
    return (hi << 8) | lo
}

// ── Item 1: reset() loads ROM into typed arrays ──
function reset() {
    let romFile = files.open(fullFilePath.full)
    let romFileSize = romFile.size
    let headeredRom = sys.calloc(romFileSize)
    romFile.pread(headeredRom, romFileSize, 0)

    // Read iNES header
    for (let i = 0; i < 16; i++) {
        e.inesHdr[i] = sys.peek(headeredRom + i)
    }

    prgBanks  = e.inesHdr[4]
    chrBanks  = e.inesHdr[5]
    mapperId  = (e.inesHdr[7] & 0xF0) | (e.inesHdr[6] >>> 4)
    subMapper = (e.inesHdr[8] & 0xF0) >>> 4
    battery   = (e.inesHdr[6] & 2) != 0

    let prgSize = prgBanks * 0x4000
    let chrSize = chrBanks * 0x2000

    // Load full PRG ROM
    prgRomArr = new Uint8Array(prgSize)
    for (let i = 0; i < prgSize; i++) {
        prgRomArr[i] = sys.peek(headeredRom + 0x10 + i)
    }

    // Load full CHR ROM, or keep chrArr as CHR RAM
    if (chrBanks > 0) {
        chrRomArr = new Uint8Array(chrSize)
        let chrOffset = 0x10 + prgSize
        for (let i = 0; i < chrSize; i++) {
            chrRomArr[i] = sys.peek(headeredRom + chrOffset + i)
        }
    } else {
        chrArr.fill(0)        // clear CHR RAM
        chrRomArr = chrArr    // CHR RAM: alias to the 8 KB array
    }

    sys.free(headeredRom)

    // WRAM (battery-backed save RAM $6000-$7FFF)
    wramArr = new Uint8Array(0x2000)
    if (battery) {
        let romFull = fullFilePath.full
        let dotIdx  = romFull.lastIndexOf('.')
        savPath     = (dotIdx > 2) ? romFull.substring(0, dotIdx) + '.sav' : romFull + '.sav'
        let savFile = files.open(savPath)
        if (savFile.exists) {
            let bytes = savFile.bread()
            let loadLen = Math.min(bytes.length, 0x2000)
            for (let i = 0; i < loadLen; i++) wramArr[i] = bytes[i] & 0xFF
        }
    } else {
        savPath = null
    }

    // Initial nametable mirror from header (mapper may override later)
    let fourScreen = (e.inesHdr[6] & 8) != 0
    if (fourScreen) {
        serial.println('[tvnes] WARNING: 4-screen VRAM not supported, using vertical')
        setMirrorMode(2)
    } else {
        setMirrorMode((e.inesHdr[6] & 1) == 1 ? 2 : 3)  // 1 = vertical, 0 = horizontal
    }

    // Mapper-specific init: sets register defaults and fills romArr/chrArr shadows
    switch (mapperId) {
        case 1: mmc1Init(); break
        case 2: uxromInit(); break
        case 3: cnromInit(); break
        case 4: mmc3Init(); break
        case 7: aoromInit(); break
        case 24: vrc6_variant = 0; vrc6Init(); break
        case 26: vrc6_variant = 1; vrc6Init(); break
        case 69: fme7Init(); break
        case 228: ines228Init(); break
        default:
            // NROM (mapper 0): mirror PRG into 32 KB shadow
            for (let i = 0; i < 0x8000; i++) romArr[i] = prgRomArr[i % prgSize]
            // Fill chrArr with CHR ROM (CHR RAM already zeroed above)
            if (chrBanks > 0) {
                let copyLen = Math.min(chrSize, 0x2000)
                for (let i = 0; i < copyLen; i++) chrArr[i] = chrRomArr[i]
            }
            break
    }

    // RESET vector
    cpu_fI = true
    let PCL = read(0xFFFC)
    let PCH = read(0xFFFD)
    cpu_pc = (PCH << 8) | PCL
    cpu_sp = 0xFD

    buildSpriteSchedule()  // OAM is all-zero at boot; pre-build so first frame has a valid schedule
    apuReset()

    // ── Item 11: open trace file and emit RESET line ──
    if (config.printTracelog) {
        // Derive trace path from ROM path: replace extension with .trc
        let romFull = fullFilePath.full
        let dotIdx = romFull.lastIndexOf('.')
        let tracePath = (dotIdx > 2) ? romFull.substring(0, dotIdx) + '.trc' : romFull + '.trc'
        traceFile = files.open(tracePath)
        if (traceFile.exists) traceFile.remove()
        traceFile.mkFile()

        let ppuCycle = e.ppuScanline * 341 + e.ppuDot
        let flags = 'nv--dizc'
        let s = '$FFFF\t--\t\tRESET\t\t\tA:00\tX:00\tY:00\tSP:00\t' + flags +
                '\tCycle: 0\tPPU_cycle: ' + ppuCycle + ' (' + e.ppuScanline + ', ' + e.ppuDot + ')' +
                '\t\tVRAMAddress:' + e.vramAddr.toString(16).padStart(4,'0').toUpperCase() +
                '\tPPUReadBuffer:' + e.ppuReadBuffer.toString(16).padStart(2,'0').toUpperCase()
        traceFile.swrite(s + '\n')
    }
}

///////////////////////////////////////////////////////////////////////////////
// ── Item 11: side-effect-free ROM/RAM read for disassembler ──
function peekRO(addr) {
    addr &= 0xFFFF
    if (addr < 0x2000) return ramArr[addr & 0x7FF]
    if (addr >= 0x8000) return romArr[addr - 0x8000]
    return 0
}

// ── Item 11: tracelogger v2 — matches Tracelogs/SuperMarioBros.txt format ──
let traceLogCnt = 0
let traceFile = null   // set in reset() when config.printTracelog is true
function printTracelog(opcode) {
    // Recover opcode address: PC has already been incremented past the opcode byte.
    let pc = cpu_pc
    if (!cpu_doNMI && !cpu_doIRQ) {
        pc = (pc - 1) & 0xFFFF  // back up to opcode byte address
    }
    if (cpu_doNMI) opcode = 0x100  // NMI pseudo-opcode

    // ── Bytes field (1–3 hex bytes, padded to ≥7 chars) ──
    let bytesStr = ''
    if (opcode == 0x100) {
        bytesStr = '--'
    } else {
        let len = OPCODE_LEN[opcode]
        for (let b = 0; b < len; b++) {
            bytesStr += peekRO(pc + b).toString(16).padStart(2,'0').toUpperCase() + ' '
        }
        // Keep the trailing space — the reference format includes it (e.g. "78 " not "78")
    }
    if (bytesStr.length < 7) bytesStr += '\t'

    // ── Instruction field (mnemonic + operand suffix, padded with tabs) ──
    let mnemonic = (opcode == 0x100) ? 'NMI' : (OPCODE_NAMES[opcode] || '???')
    let instrStr = mnemonic + ' '
    if (opcode != 0x100) {
        let mode = OPCODE_MODE[opcode]
        let b1 = peekRO(pc + 1)
        let b2 = peekRO(pc + 2)
        let abs16 = (b2 << 8) | b1
        switch (mode) {
            case 0: instrStr = mnemonic + ' '; break // implied (trailing space)
            case 1: instrStr += 'A'; break
            case 2: instrStr += '#' + b1.toString(16).padStart(2,'0').toUpperCase(); break
            case 3: instrStr += '<$' + b1.toString(16).padStart(2,'0').toUpperCase(); break
            case 4: instrStr += '<$' + b1.toString(16).padStart(2,'0').toUpperCase() + ', X -> $' +
                                ((b1 + cpu_x) & 0xFF).toString(16).padStart(2,'0').toUpperCase(); break
            case 5: instrStr += '<$' + b1.toString(16).padStart(2,'0').toUpperCase() + ', Y -> $' +
                                ((b1 + cpu_y) & 0xFF).toString(16).padStart(2,'0').toUpperCase(); break
            case 6: instrStr += '$' + b2.toString(16).padStart(2,'0').toUpperCase() +
                                       b1.toString(16).padStart(2,'0').toUpperCase(); break
            case 7: instrStr += '$' + b2.toString(16).padStart(2,'0').toUpperCase() +
                                       b1.toString(16).padStart(2,'0').toUpperCase() +
                                ', X -> $' + ((abs16 + cpu_x) & 0xFFFF).toString(16).padStart(4,'0').toUpperCase(); break
            case 8: instrStr += '$' + b2.toString(16).padStart(2,'0').toUpperCase() +
                                       b1.toString(16).padStart(2,'0').toUpperCase() +
                                ', Y -> $' + ((abs16 + cpu_y) & 0xFFFF).toString(16).padStart(4,'0').toUpperCase(); break
            case 9: { // relative — show resolved branch target
                let sv = b1 > 127 ? b1 - 256 : b1
                let target = (pc + 2 + sv) & 0xFFFF
                instrStr += '$' + target.toString(16).padStart(4,'0').toUpperCase(); break
            }
            case 10: { // indirect (JMP ($nnnn))
                let resolved = (peekRO(abs16) | (peekRO((abs16 & 0xFF00) | ((abs16 + 1) & 0xFF)) << 8))
                instrStr += '($' + b2.toString(16).padStart(2,'0').toUpperCase() +
                                    b1.toString(16).padStart(2,'0').toUpperCase() +
                            ') -> $' + resolved.toString(16).padStart(4,'0').toUpperCase(); break
            }
            case 11: { // (zp, X)
                let zpAddr = (b1 + cpu_x) & 0xFF
                let resolved = peekRO(zpAddr) | (peekRO((zpAddr + 1) & 0xFF) << 8)
                instrStr += '($00' + b1.toString(16).padStart(2,'0').toUpperCase() +
                            ', X) -> $' + resolved.toString(16).padStart(4,'0').toUpperCase(); break
            }
            case 12: { // (zp), Y
                let resolved = (peekRO(b1) | (peekRO((b1 + 1) & 0xFF) << 8))
                instrStr += '($00' + b1.toString(16).padStart(2,'0').toUpperCase() +
                            '), Y -> $' + ((resolved + cpu_y) & 0xFFFF).toString(16).padStart(4,'0').toUpperCase(); break
            }
        }
        // Annotate $2007 access
        if (abs16 == 0x2007 && (mode == 6 || mode == 7 || mode == 8)) {
            instrStr += ' | PPU[$' + e.vramAddr.toString(16).padStart(4,'0').toUpperCase() + ']'
        }
    }
    // Pad instruction to alignment columns
    if (instrStr.length < 8)  instrStr += '\t'
    if (instrStr.length < 17) instrStr += '\t'

    // ── Flags ──
    let flags = (cpu_fN    ? 'N' : 'n') + (cpu_fV    ? 'V' : 'v') + '--' +
                (cpu_fD    ? 'D' : 'd') + (cpu_fI  ? 'I' : 'i') +
                (cpu_fZ   ? 'Z' : 'z') + (cpu_fC   ? 'C' : 'c')

    // ── PPU cycle formula (matches C# TriCnes logic) ──
    let sl = e.ppuScanline, dot = e.ppuDot, totalCyc = cpu_totalCycles
    let ppuCyc
    if (totalCyc < 27395) {
        ppuCyc = sl * 341 + dot
    } else {
        ppuCyc = (sl >= 241 ? (sl - 241) * 341 : (sl + 21) * 341) + dot
    }
    let ppuPos = '(' + sl + ', ' + dot + ')'
    if ((ppuPos.length + ppuCyc.toString().length + 1) < 13) ppuPos += '\t'

    let s = '$' + pc.toString(16).padStart(4,'0').toUpperCase() + '\t' +
            bytesStr + '\t' +
            instrStr + '\t' +
            'A:' + cpu_a.toString(16).padStart(2,'0').toUpperCase() + '\t' +
            'X:' + cpu_x.toString(16).padStart(2,'0').toUpperCase() + '\t' +
            'Y:' + cpu_y.toString(16).padStart(2,'0').toUpperCase() + '\t' +
            'SP:' + cpu_sp.toString(16).padStart(2,'0').toUpperCase() + '\t' +
            flags + '\t' +
            'Cycle: ' + totalCyc + '\t' +
            'PPU_cycle: ' + ppuCyc + ' ' + ppuPos + '\t' +
            '\tVRAMAddress:' + e.vramAddr.toString(16).padStart(4,'0').toUpperCase() +
            '\tPPUReadBuffer:' + e.ppuReadBuffer.toString(16).padStart(2,'0').toUpperCase()
    traceFile.sappend(s + '\n')
    traceLogCnt++
}

///////////////////////////////////////////////////////////////////////////////
// ── APU engine ──

function apuReset() {
    // Zero all APU state (called from reset())
    apu_p1TimerReload = 0; apu_p1Duty = 0; apu_p1LenCnt = 0; apu_p1LenHalt = false
    apu_p1EnvStart = false; apu_p1EnvDivider = 0; apu_p1EnvDecay = 0
    apu_p1EnvConst = false; apu_p1EnvVol = 0; apu_p1Enable = false
    apu_p1SweepEnable = false; apu_p1SweepPeriod = 0; apu_p1SweepNegate = false
    apu_p1SweepShift = 0; apu_p1SweepReload = false; apu_p1SweepDivider = 0
    apu_p2TimerReload = 0; apu_p2Duty = 0; apu_p2LenCnt = 0; apu_p2LenHalt = false
    apu_p2EnvStart = false; apu_p2EnvDivider = 0; apu_p2EnvDecay = 0
    apu_p2EnvConst = false; apu_p2EnvVol = 0; apu_p2Enable = false
    apu_p2SweepEnable = false; apu_p2SweepPeriod = 0; apu_p2SweepNegate = false
    apu_p2SweepShift = 0; apu_p2SweepReload = false; apu_p2SweepDivider = 0
    apu_triTimerReload = 0; apu_triLenCnt = 0; apu_triLenHalt = false
    apu_triLinCnt = 0; apu_triLinReloadVal = 0; apu_triLinReload = false; apu_triEnable = false
    apu_nsTimerIdx = 0; apu_nsMode = false; apu_nsLenCnt = 0; apu_nsLenHalt = false
    apu_nsEnvStart = false; apu_nsEnvDivider = 0; apu_nsEnvDecay = 0
    apu_nsEnvConst = false; apu_nsEnvVol = 0; apu_nsEnable = false
    apu_dmcIrqEn = false; apu_dmcLoop = false; apu_dmcRate = APU_DMC_RATE_LUT[0]
    apu_dmcTimer = APU_DMC_RATE_LUT[0]; apu_dmcOutput = 0
    apu_dmcSampleAddr = 0xC000; apu_dmcSampleLen = 1; apu_dmcBytesRem = 0
    apu_dmcAddrCounter = 0xC000
    apu_dmcBuffer = 0; apu_dmcBufFilled = false
    apu_dmcShifter = 0; apu_dmcShiftCnt = 8; apu_dmcSilent = true
    apu_dmcEnable = false; apu_dmcIrqFlag = false
    apu_fcMode = 0; apu_fcInhibitIrq = false; apu_fcCycles = 0
    apu_fcResetDelay = 0; apu_fcIrqFlag = false
    apu_sampleAcc = 0.0; apu_dmcWritePos = 0
    apu_frameCyclesStart = cpu_totalCycles
    apu_sliceCount = 1
}

// Compute sweep target period for a pulse channel.
// isP2: pulse 2 uses true two's complement negate; pulse 1 uses one's complement (-(delta+1)).
function apuSweepTarget(period, negate, shift, isP2) {
    let delta = period >> shift
    if (negate) delta = isP2 ? -delta : -(delta + 1)
    return period + delta
}

// Clock all envelope generators and the triangle linear counter (quarter-frame event).
function apuClockQF() {
    // Pulse 1 envelope
    if (apu_p1EnvStart) {
        apu_p1EnvStart = false; apu_p1EnvDecay = 15; apu_p1EnvDivider = apu_p1EnvVol
    } else if (apu_p1EnvDivider == 0) {
        apu_p1EnvDivider = apu_p1EnvVol
        if (apu_p1EnvDecay > 0) apu_p1EnvDecay--
        else if (apu_p1LenHalt) apu_p1EnvDecay = 15  // loop
    } else { apu_p1EnvDivider-- }
    // Pulse 2 envelope
    if (apu_p2EnvStart) {
        apu_p2EnvStart = false; apu_p2EnvDecay = 15; apu_p2EnvDivider = apu_p2EnvVol
    } else if (apu_p2EnvDivider == 0) {
        apu_p2EnvDivider = apu_p2EnvVol
        if (apu_p2EnvDecay > 0) apu_p2EnvDecay--
        else if (apu_p2LenHalt) apu_p2EnvDecay = 15
    } else { apu_p2EnvDivider-- }
    // Noise envelope
    if (apu_nsEnvStart) {
        apu_nsEnvStart = false; apu_nsEnvDecay = 15; apu_nsEnvDivider = apu_nsEnvVol
    } else if (apu_nsEnvDivider == 0) {
        apu_nsEnvDivider = apu_nsEnvVol
        if (apu_nsEnvDecay > 0) apu_nsEnvDecay--
        else if (apu_nsLenHalt) apu_nsEnvDecay = 15
    } else { apu_nsEnvDivider-- }
    // Triangle linear counter
    if (apu_triLinReload) {
        apu_triLinCnt = apu_triLinReloadVal
    } else if (apu_triLinCnt > 0) {
        apu_triLinCnt--
    }
    if (!apu_triLenHalt) apu_triLinReload = false  // triLenHalt doubles as linear-counter-control
}

// Clock length counters and sweep units (half-frame event).
function apuClockHF() {
    // Length counters
    if (!apu_p1LenHalt  && apu_p1LenCnt  > 0) apu_p1LenCnt--
    if (!apu_p2LenHalt  && apu_p2LenCnt  > 0) apu_p2LenCnt--
    if (!apu_triLenHalt && apu_triLenCnt > 0) apu_triLenCnt--
    if (!apu_nsLenHalt  && apu_nsLenCnt  > 0) apu_nsLenCnt--
    // Pulse 1 sweep
    {
        let target = apuSweepTarget(apu_p1TimerReload, apu_p1SweepNegate, apu_p1SweepShift, false)
        if (apu_p1SweepDivider == 0 && apu_p1SweepEnable && apu_p1SweepShift > 0
                && apu_p1TimerReload >= 8 && target <= 0x7FF) {
            apu_p1TimerReload = target
        }
        if (apu_p1SweepDivider == 0 || apu_p1SweepReload) {
            apu_p1SweepDivider = apu_p1SweepPeriod; apu_p1SweepReload = false
        } else { apu_p1SweepDivider-- }
    }
    // Pulse 2 sweep
    {
        let target = apuSweepTarget(apu_p2TimerReload, apu_p2SweepNegate, apu_p2SweepShift, true)
        if (apu_p2SweepDivider == 0 && apu_p2SweepEnable && apu_p2SweepShift > 0
                && apu_p2TimerReload >= 8 && target <= 0x7FF) {
            apu_p2TimerReload = target
        }
        if (apu_p2SweepDivider == 0 || apu_p2SweepReload) {
            apu_p2SweepDivider = apu_p2SweepPeriod; apu_p2SweepReload = false
        } else { apu_p2SweepDivider-- }
    }
}

// Take a snapshot of current channel state into a slice slot for emitAudioFrame.
function apuTakeSnapshot(slot) {
    // Pulse 1
    let p1Vol  = apu_p1EnvConst ? apu_p1EnvVol : apu_p1EnvDecay
    let p1T    = apuSweepTarget(apu_p1TimerReload, apu_p1SweepNegate, apu_p1SweepShift, false)
    let p1Mute = apu_p1TimerReload < 8 || p1T > 0x7FF
    apu_snapP1On[slot]   = (apu_p1Enable && apu_p1LenCnt > 0 && !p1Mute) ? 1 : 0
    apu_snapP1Freq[slot] = apu_p1TimerReload > 0 ? 1789773.0 / (16.0 * (apu_p1TimerReload + 1)) : 0
    apu_snapP1Amp[slot]  = (p1Vol / 15.0) * 0.13
    apu_snapP1Duty[slot] = APU_DUTY_FRAC[apu_p1Duty]
    // Pulse 2
    let p2Vol  = apu_p2EnvConst ? apu_p2EnvVol : apu_p2EnvDecay
    let p2T    = apuSweepTarget(apu_p2TimerReload, apu_p2SweepNegate, apu_p2SweepShift, true)
    let p2Mute = apu_p2TimerReload < 8 || p2T > 0x7FF
    apu_snapP2On[slot]   = (apu_p2Enable && apu_p2LenCnt > 0 && !p2Mute) ? 1 : 0
    apu_snapP2Freq[slot] = apu_p2TimerReload > 0 ? 1789773.0 / (16.0 * (apu_p2TimerReload + 1)) : 0
    apu_snapP2Amp[slot]  = (p2Vol / 15.0) * 0.13
    apu_snapP2Duty[slot] = APU_DUTY_FRAC[apu_p2Duty]
    // Triangle (no volume control; gate by linCnt + lenCnt + period >= 2)
    apu_snapTriOn[slot]   = (apu_triEnable && apu_triLenCnt > 0 && apu_triLinCnt > 0
                              && apu_triTimerReload >= 2) ? 1 : 0
    apu_snapTriFreq[slot] = apu_triTimerReload >= 2
                            ? 1789773.0 / (32.0 * (apu_triTimerReload + 1)) : 0
    // Noise
    let nsVol = apu_nsEnvConst ? apu_nsEnvVol : apu_nsEnvDecay
    apu_snapNsOn[slot]   = (apu_nsEnable && apu_nsLenCnt > 0) ? 1 : 0
    apu_snapNsFreq[slot] = 1789773.0 / APU_NOISE_PERIOD_LUT[apu_nsTimerIdx]
    apu_snapNsAmp[slot]  = (nsVol / 15.0) * 0.17
    apu_snapNsMode[slot] = apu_nsMode ? 2 : 1  // 2 = short LFSR (tonal), 1 = long LFSR (full)
    // ── Sunsoft 5B (FME-7 onboard PSG) ──
    if (mapperId == 69) {
        let mix = s5b_regs[7]
        // Channel A
        let pA = (s5b_regs[0] | ((s5b_regs[1] & 0x0F) << 8)) & 0xFFF
        let vA = s5b_regs[8] & 0x0F
        let toneA_en = (mix & 0x01) == 0
        apu_snap5bAOn[slot]   = (toneA_en && vA > 0 && pA > 0) ? 1 : 0
        apu_snap5bAFreq[slot] = pA > 0 ? 1789773.0 / (32.0 * pA) : 0
        apu_snap5bAAmp[slot]  = (vA / 15.0) * 0.10
        // Channel B
        let pB = (s5b_regs[2] | ((s5b_regs[3] & 0x0F) << 8)) & 0xFFF
        let vB = s5b_regs[9] & 0x0F
        let toneB_en = (mix & 0x02) == 0
        apu_snap5bBOn[slot]   = (toneB_en && vB > 0 && pB > 0) ? 1 : 0
        apu_snap5bBFreq[slot] = pB > 0 ? 1789773.0 / (32.0 * pB) : 0
        apu_snap5bBAmp[slot]  = (vB / 15.0) * 0.10
        // Channel C
        let pC = (s5b_regs[4] | ((s5b_regs[5] & 0x0F) << 8)) & 0xFFF
        let vC = s5b_regs[10] & 0x0F
        let toneC_en = (mix & 0x04) == 0
        apu_snap5bCOn[slot]   = (toneC_en && vC > 0 && pC > 0) ? 1 : 0
        apu_snap5bCFreq[slot] = pC > 0 ? 1789773.0 / (32.0 * pC) : 0
        apu_snap5bCAmp[slot]  = (vC / 15.0) * 0.10
    } else {
        apu_snap5bAOn[slot] = 0; apu_snap5bBOn[slot] = 0; apu_snap5bCOn[slot] = 0
    }
    // ── VRC6 (Konami onboard audio) ──
    if (mapperId == 24 || mapperId == 26) {
        // Pulse 1
        apu_snapVrc6P1On[slot]   = (vrc6_p1En && vrc6_p1Vol > 0) ? 1 : 0
        apu_snapVrc6P1Freq[slot] = 1789773.0 / (16.0 * (vrc6_p1Period + 1))
        apu_snapVrc6P1Amp[slot]  = (vrc6_p1Vol / 15.0) * 0.10
        // Duty: (duty+1)/16; mode bit forces 100% on (DC — inaudible as tone)
        apu_snapVrc6P1Duty[slot] = vrc6_p1Mode ? 1.0 : ((vrc6_p1Duty + 1) / 16.0)
        // Pulse 2
        apu_snapVrc6P2On[slot]   = (vrc6_p2En && vrc6_p2Vol > 0) ? 1 : 0
        apu_snapVrc6P2Freq[slot] = 1789773.0 / (16.0 * (vrc6_p2Period + 1))
        apu_snapVrc6P2Amp[slot]  = (vrc6_p2Vol / 15.0) * 0.10
        apu_snapVrc6P2Duty[slot] = vrc6_p2Mode ? 1.0 : ((vrc6_p2Duty + 1) / 16.0)
        // Sawtooth: one full ramp per 14 internal clocks → freq = CPU / (14*(period+1))
        // Peak output ≈ (7*rate)>>3; normalise against max peak (7*63>>3 = 55).
        apu_snapVrc6SawOn[slot]   = (vrc6_sawEn && vrc6_sawRate > 0) ? 1 : 0
        apu_snapVrc6SawFreq[slot] = 1789773.0 / (14.0 * (vrc6_sawPeriod + 1))
        apu_snapVrc6SawAmp[slot]  = (vrc6_sawRate / 63.0) * 0.12
    } else {
        apu_snapVrc6P1On[slot] = 0; apu_snapVrc6P2On[slot] = 0; apu_snapVrc6SawOn[slot] = 0
    }
}

// Called at the start of each NES frame (before run()) to initialise the slice array.
function apuFrameStart() {
    apu_frameCyclesStart = cpu_totalCycles
    apu_sliceOff[0] = 0.0
    apuTakeSnapshot(0)
    apu_sliceCount = 1
}

// Record the current channel state as a new slice snapshot.
function apuSnapNow() {
    if (apu_sliceCount < APU_MAX_SLICES) {
        apu_sliceOff[apu_sliceCount] = (cpu_totalCycles - apu_frameCyclesStart) / 1789773.0
        apuTakeSnapshot(apu_sliceCount)
        apu_sliceCount++
    }
}

// Step the APU by `cycles` CPU cycles.  Returns any extra CPU stall cycles from DMC DMA.
function stepAPU(cycles) {
    let extra = 0

    // ── Frame counter ──
    if (apu_fcResetDelay > 0) {
        apu_fcResetDelay -= cycles
        if (apu_fcResetDelay <= 0) { apu_fcCycles = 0; apu_fcResetDelay = 0 }
    } else {
        let prev = apu_fcCycles
        apu_fcCycles += cycles
        let fc = apu_fcCycles

        if (apu_fcMode == 0) {
            // 4-step mode — snapshot AFTER each clock event so length counters reflect HF
            if (prev < 7457  && fc >= 7457)  { apuClockQF(); apuSnapNow() }
            if (prev < 14913 && fc >= 14913) { apuClockQF(); apuClockHF(); apuSnapNow() }
            if (prev < 22371 && fc >= 22371) { apuClockQF(); apuSnapNow() }
            if (prev < 29829 && fc >= 29829) {
                if (!apu_fcInhibitIrq) { apu_fcIrqFlag = true; cpu_irqLevel = true }
            }
            if (prev < 29830 && fc >= 29830) {
                apuClockQF(); apuClockHF(); apuSnapNow()
                if (!apu_fcInhibitIrq) { apu_fcIrqFlag = true; cpu_irqLevel = true }
                apu_fcCycles -= 29830
            }
        } else {
            // 5-step mode
            if (prev < 7457  && fc >= 7457)  { apuClockQF(); apuSnapNow() }
            if (prev < 14913 && fc >= 14913) { apuClockQF(); apuClockHF(); apuSnapNow() }
            if (prev < 22371 && fc >= 22371) { apuClockQF(); apuSnapNow() }
            // No event at 29829 in 5-step
            if (prev < 37281 && fc >= 37281) { apuClockQF(); apuClockHF(); apuSnapNow() }
            if (fc >= 37282) { apu_fcCycles -= 37282 }
        }
    }

    // ── DMC timer and bit-clock ──
    if (apu_dmcEnable || apu_dmcBytesRem > 0) {
        apu_dmcTimer -= cycles
        while (apu_dmcTimer <= 0) {
            apu_dmcTimer += apu_dmcRate

            if (!apu_dmcSilent) {
                // Shift one delta bit out of the output register
                if ((apu_dmcShifter & 1) == 1) {
                    if (apu_dmcOutput <= 125) apu_dmcOutput += 2
                } else {
                    if (apu_dmcOutput >= 2) apu_dmcOutput -= 2
                }
                apu_dmcShifter >>= 1
                apu_dmcShiftCnt--
                if (apu_dmcShiftCnt == 0) {
                    apu_dmcShiftCnt = 8
                    if (apu_dmcBufFilled) {
                        apu_dmcShifter = apu_dmcBuffer
                        apu_dmcBufFilled = false
                        apu_dmcSilent = false
                    } else {
                        apu_dmcSilent = true
                    }
                }
            } else if (apu_dmcBufFilled) {
                // Was silent but buffer got filled — restart
                apu_dmcShifter = apu_dmcBuffer
                apu_dmcBufFilled = false
                apu_dmcSilent = false
                apu_dmcShiftCnt = 8
            }

            // Refill buffer via DMA if empty and bytes remain
            if (!apu_dmcBufFilled && apu_dmcBytesRem > 0) {
                apu_dmcBuffer    = read(apu_dmcAddrCounter)
                apu_dmcBufFilled = true
                apu_dmcAddrCounter = (apu_dmcAddrCounter >= 0xFFFF) ? 0x8000
                                                                     : (apu_dmcAddrCounter + 1)
                apu_dmcBytesRem--
                extra += 4  // flat DMC DMA CPU stall (1–4 cycles; we use 4 conservatively)
                if (apu_dmcBytesRem == 0) {
                    if (apu_dmcLoop) {
                        apu_dmcAddrCounter = apu_dmcSampleAddr
                        apu_dmcBytesRem    = apu_dmcSampleLen
                    } else {
                        if (apu_dmcIrqEn) { apu_dmcIrqFlag = true; cpu_irqLevel = true }
                    }
                }
            }
        }
    }

    // ── 32 kHz DMC output sampling into apu_dmcBuf (Playhead 1 feed) ──
    apu_sampleAcc += cycles
    while (apu_sampleAcc >= APU_CYC_PER_SAMPLE) {
        apu_sampleAcc -= APU_CYC_PER_SAMPLE
        if (apu_dmcWritePos < 600) {
            let u8 = apu_dmcSilent ? 128 : Math.min(254, apu_dmcOutput + 64)
            let idx = apu_dmcWritePos * 2
            apu_dmcBuf[idx] = u8; apu_dmcBuf[idx + 1] = u8
            apu_dmcWritePos++
        }
    }

    return extra
}

///////////////////////////////////////////////////////////////////////////////

function run() {
    // Keep ppuBudget as a local to avoid repeated property reads/writes.
    // stepPPU is only called when the budget reaches a scanline boundary (341 dots),
    // reducing calls from ~10k/frame to ~262/frame (one per scanline).
    let ppuBudget = ppu_cycleBudget
    let lastPC = -1  // for spin-loop detection
    // Time the whole run() call once; subtract PPU sub-total to get CPU time.
    // This halves nanoTime() calls vs stop-start around every scanline boundary.
    let _tStart = sys.nanoTime()
    let ppuNs   = 0

    while (!cpu_halted) {
        // NMI edge detection (moved here from emulateCPU so spin-loop skip can check it)
        let prevNMI = cpu_nmiLevel
        cpu_nmiLevel = ppu_enableNMI && ppu_vblank
        if (!prevNMI && cpu_nmiLevel) cpu_doNMI = true

        // IRQ level detection (MMC3 and future mappers); only raises when I flag is clear
        if (cpu_irqLevel && !cpu_fI && !cpu_doNMI && !cpu_doIRQ) cpu_doIRQ = true

        // Spin-loop fast-forward: when the CPU is stuck at the same PC (JMP-to-self)
        // and no NMI or IRQ is pending, skip the remaining PPU budget to the next scanline
        // boundary in one shot instead of calling emulateCPU ~113 more times.
        if (cpu_pc === lastPC && !cpu_doNMI && !cpu_doIRQ) {
            // dots remaining until end of this scanline
            let remPPU  = 341 - (ppuBudget % 341)
            // convert to CPU cycles (ceiling so we don't under-shoot the boundary)
            let skipCyc = ((remPPU + 2) / 3) | 0
            ppuBudget       += skipCyc * 3
            cpu_totalCycles += skipCyc
            prof_cpu_cycles += skipCyc
            prof_cpu_skip   += skipCyc
            if (config.audioEnable) stepAPU(skipCyc)  // keep APU ticking during spin-loops
            if (mapperId == 69) fme7ClockIRQ(skipCyc)
            else if (mapperId == 24 || mapperId == 26) vrc6ClockIRQ(skipCyc)
        } else {
            lastPC = cpu_pc
            emulateCPU()
            if (config.audioEnable) {
                let extra = stepAPU(cycles)
                if (extra) { cycles += extra; cpu_totalCycles += extra; prof_cpu_cycles += extra }
            }
            if (mapperId == 69) fme7ClockIRQ(cycles)
            else if (mapperId == 24 || mapperId == 26) vrc6ClockIRQ(cycles)
            ppuBudget += cycles * 3
        }

        if (ppuBudget >= 341) {
            ppu_cycleBudget = ppuBudget
            let t1 = sys.nanoTime()
            stepPPU()
            ppuNs += sys.nanoTime() - t1
            ppuBudget = ppu_cycleBudget  // stepPPU zeroes it after consuming
            if (ppu_drawNewFrame) {
                ppu_drawNewFrame = false
                break
            }
            lastPC = -1  // reset after each scanline so the skip doesn't bleed across
        }
    }
    let totalNs  = sys.nanoTime() - _tStart
    prof_ppu    += ppuNs
    prof_cpu    += totalNs - ppuNs  // CPU = total run time minus PPU sub-time
    ppu_cycleBudget = ppuBudget
    if (cpu_halted) serial.println('CPU Halted')
}

// Module-level scratch (shared across emulateCPU and address-mode helpers)
let cycles = 0
let temp   = 0
let pageCrossed = false

function doBranchingOnPredicate(p) {
    // Inlined readPCs sign-extend + movPC — saves 2 nested calls
    let off = readPC()
    if (p) {
        if (off > 127) off -= 256  // sign-extend
        let oldPCh = cpu_pc >>> 8
        cpu_pc = (cpu_pc + off) & 0xFFFF
        cycles = 3 + ((oldPCh !== (cpu_pc >>> 8)) ? 1 : 0)
    } else {
        cycles = 2
    }
}

// Zero-page is always CPU RAM — bypass read() dispatch.
function readZpU16(addr) {
    let a = addr & 0xFF
    return ramArr[a] | (ramArr[(a + 1) & 0xFF] << 8)
}

function readU16Wrap(addr) {
    let lo = read(addr)
    let hi = read((addr & 0xFF00) | ((addr + 1) & 0xFF))
    return (hi << 8) | lo
}

// ── Item 5: addressing modes use top-level readPC/readPCu16 ──
function addrZpX()  { return (readPC() + cpu_x) & 0xFF }
function addrZpY()  { return (readPC() + cpu_y) & 0xFF }
function addrAbsX() {
    let base = readPCu16()
    let addr = (base + cpu_x) & 0xFFFF
    pageCrossed = (base & 0xFF00) != (addr & 0xFF00)
    return addr
}
function addrAbsY() {
    let base = readPCu16()
    let addr = (base + cpu_y) & 0xFFFF
    pageCrossed = (base & 0xFF00) != (addr & 0xFF00)
    return addr
}
function addrIndX() { return readZpU16((readPC() + cpu_x) & 0xFF) }
function addrIndY() {
    let base = readZpU16(readPC())
    let addr = (base + cpu_y) & 0xFFFF
    pageCrossed = (base & 0xFF00) != (addr & 0xFF00)
    return addr
}

// ALU helpers (use e.* directly for brevity; hot path is the typed-array reads above)
function doADC(val) {
    let sum = cpu_a + val + (cpu_fC ? 1 : 0)
    cpu_fV   = ((~(cpu_a ^ val)) & (cpu_a ^ sum) & 0x80) != 0
    cpu_fC = sum > 255
    cpu_a      = sum & 0xFF
    cpu_fZ  = cpu_a == 0; cpu_fN = cpu_a > 127  // ── Item 6: inline setResultFlags ──
}
function doSBC(val) { doADC(val ^ 0xFF) }
function doCMP(reg, val) {
    let diff   = reg - val
    cpu_fC = reg >= val
    cpu_fZ  = (diff & 0xFF) == 0
    cpu_fN   = (diff & 0x80) != 0
}
function doASL(val) {
    cpu_fC = (val & 0x80) != 0
    let r = (val << 1) & 0xFF
    cpu_fZ = r == 0; cpu_fN = r > 127
    return r
}
function doLSR(val) {
    cpu_fC = (val & 1) != 0
    let r = val >>> 1
    cpu_fZ = r == 0; cpu_fN = r > 127
    return r
}
function doROL(val) {
    let oldC = cpu_fC ? 1 : 0
    cpu_fC = (val & 0x80) != 0
    let r = ((val << 1) | oldC) & 0xFF
    cpu_fZ = r == 0; cpu_fN = r > 127
    return r
}
function doROR(val) {
    let oldC = cpu_fC ? 128 : 0
    cpu_fC = (val & 1) != 0
    let r = (val >>> 1) | oldC
    cpu_fZ = r == 0; cpu_fN = r > 127
    return r
}
function packFlags(bFlag) {
    return (cpu_fN    ? 0x80 : 0) | (cpu_fV    ? 0x40 : 0) | 0x20 |
           (bFlag     ? 0x10 : 0) | (cpu_fD    ? 0x08 : 0) |
           (cpu_fI ? 0x04 : 0) | (cpu_fZ   ? 0x02 : 0) | (cpu_fC ? 0x01 : 0)
}
function unpackFlags(val) {
    cpu_fN    = (val & 0x80) != 0
    cpu_fV    = (val & 0x40) != 0
    cpu_fD    = (val & 0x08) != 0
    cpu_fI = (val & 0x04) != 0
    cpu_fZ   = (val & 0x02) != 0
    cpu_fC  = (val & 0x01) != 0
}

///////////////////////////////////////////////////////////////////////////////
// ── Items 4, 6, 10: emulateCPU with fast opcode fetch, inlined flags ──
function emulateCPU() {
    let opcode
    if (cpu_doNMI || cpu_doIRQ) {
        opcode = 0x00  // NMI / IRQ both hijack opcode fetch to BRK vector handler
    } else {
        // ── Item 10: fast opcode fetch from ROM without going through read() ──
        let pc = cpu_pc
        if (pc >= 0x8000) {
            opcode = romArr[pc - 0x8000]
            cpu_pc = (pc + 1) & 0xFFFF
        } else {
            opcode = read(pc)
            cpu_pc = (pc + 1) & 0xFFFF
        }
    }

    prof_cpu_instrs++
    prof_opcodeHits[opcode]++

    if (config.printTracelog) printTracelog(opcode)

    switch (opcode) {

        // BRK / NMI / IRQ handler
        case 0x00:
            if (cpu_doNMI) prof_cpu_nmi++
            else if (!cpu_doIRQ) incPC()  // BRK skips padding byte; NMI/IRQ do not
            pushPC()
            push(packFlags(!cpu_doNMI && !cpu_doIRQ))  // B flag set only for real BRK
            cpu_pc    = cpu_doNMI ? (read(0xFFFA) | (read(0xFFFB) << 8))
                                  : (read(0xFFFE) | (read(0xFFFF) << 8))
            cpu_fI    = true    // suppress further IRQs while in handler
            cpu_doNMI = false
            cpu_doIRQ = false
            cpu_nmiFired++
            cycles  = 7
            break

        // ORA
        case 0x01: cpu_a = cpu_a | read(addrIndX()); cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 6; break
        case 0x05: cpu_a |= ramArr[readPC()]; cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 3; break
        case 0x09: cpu_a |= readPC(); cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 2; break
        case 0x0D: cpu_a = cpu_a | read(readPCu16());  cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 4; break
        case 0x11: cpu_a = cpu_a | read(addrIndY());   cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 5 + pageCrossed; break
        case 0x15: cpu_a = cpu_a | read(addrZpX());    cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 4; break
        case 0x19: cpu_a = cpu_a | read(addrAbsY());   cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 4 + pageCrossed; break
        case 0x1D: cpu_a = cpu_a | read(addrAbsX());   cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 4 + pageCrossed; break

        // ASL
        case 0x0A: cpu_fC = (cpu_a&0x80)!=0; cpu_a=(cpu_a<<1)&0xFF; cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 2; break
        case 0x06: temp = readPC();    write(temp, doASL(read(temp))); cycles = 5; break
        case 0x16: temp = addrZpX();   write(temp, doASL(read(temp))); cycles = 6; break
        case 0x0E: temp = readPCu16(); write(temp, doASL(read(temp))); cycles = 6; break
        case 0x1E: temp = addrAbsX();  write(temp, doASL(read(temp))); cycles = 7; break

        case 0x08: push(packFlags(true)); cycles = 3; break  // PHP
        case 0x10: doBranchingOnPredicate(!cpu_fN);  break  // BPL
        case 0x18: cpu_fC = false; cycles = 2; break       // CLC

        // JSR
        case 0x20: temp = readPCu16(); decPC(); pushPC(); cpu_pc = temp; cycles = 6; break

        // AND
        case 0x21: cpu_a = cpu_a & read(addrIndX()); cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 6; break
        case 0x25: cpu_a &= ramArr[readPC()]; cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 3; break
        case 0x29: cpu_a &= readPC(); cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 2; break
        case 0x2D: cpu_a = cpu_a & read(readPCu16());  cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 4; break
        case 0x31: cpu_a = cpu_a & read(addrIndY());   cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 5 + pageCrossed; break
        case 0x35: cpu_a = cpu_a & read(addrZpX());    cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 4; break
        case 0x39: cpu_a = cpu_a & read(addrAbsY());   cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 4 + pageCrossed; break
        case 0x3D: cpu_a = cpu_a & read(addrAbsX());   cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 4 + pageCrossed; break

        // BIT
        case 0x24: temp = ramArr[readPC()]; cpu_fZ = (cpu_a & temp)==0; cpu_fV = (temp&0x40)!=0; cpu_fN = (temp&0x80)!=0; cycles = 3; break
        case 0x2C: temp = read(readPCu16()); cpu_fZ = (cpu_a & temp)==0; cpu_fV = (temp&0x40)!=0; cpu_fN = (temp&0x80)!=0; cycles = 4; break

        // ROL
        case 0x2A: { let c=cpu_fC?1:0; cpu_fC=(cpu_a&0x80)!=0; cpu_a=((cpu_a<<1)|c)&0xFF; cpu_fZ=cpu_a==0; cpu_fN=cpu_a>127; cycles=2; break }
        case 0x26: temp = readPC();    write(temp, doROL(read(temp))); cycles = 5; break
        case 0x36: temp = addrZpX();   write(temp, doROL(read(temp))); cycles = 6; break
        case 0x2E: temp = readPCu16(); write(temp, doROL(read(temp))); cycles = 6; break
        case 0x3E: temp = addrAbsX();  write(temp, doROL(read(temp))); cycles = 7; break

        case 0x28: unpackFlags(pull()); cycles = 4; break  // PLP
        case 0x30: doBranchingOnPredicate(cpu_fN);  break  // BMI
        case 0x38: cpu_fC = true;  cycles = 2; break      // SEC

        // RTI
        case 0x40: unpackFlags(pull()); cpu_pc = pullu16(); cycles = 6; break

        // EOR
        case 0x41: cpu_a = cpu_a ^ read(addrIndX()); cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 6; break
        case 0x45: cpu_a ^= ramArr[readPC()]; cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 3; break
        case 0x49: cpu_a ^= readPC(); cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 2; break
        case 0x4D: cpu_a = cpu_a ^ read(readPCu16());  cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 4; break
        case 0x51: cpu_a = cpu_a ^ read(addrIndY());   cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 5 + pageCrossed; break
        case 0x55: cpu_a = cpu_a ^ read(addrZpX());    cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 4; break
        case 0x59: cpu_a = cpu_a ^ read(addrAbsY());   cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 4 + pageCrossed; break
        case 0x5D: cpu_a = cpu_a ^ read(addrAbsX());   cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 4 + pageCrossed; break

        // LSR
        case 0x4A: cpu_fC = (cpu_a&1)!=0; cpu_a>>>=1; cpu_fZ = cpu_a==0; cpu_fN = false; cycles = 2; break
        case 0x46: temp = readPC();    write(temp, doLSR(read(temp))); cycles = 5; break
        case 0x56: temp = addrZpX();   write(temp, doLSR(read(temp))); cycles = 6; break
        case 0x4E: temp = readPCu16(); write(temp, doLSR(read(temp))); cycles = 6; break
        case 0x5E: temp = addrAbsX();  write(temp, doLSR(read(temp))); cycles = 7; break

        case 0x48: push(cpu_a); cycles = 3; break             // PHA
        case 0x4C: cpu_pc = readPCu16(); cycles = 3; break    // JMP abs
        case 0x6C: cpu_pc = readU16Wrap(readPCu16()); cycles = 5; break  // JMP indirect

        case 0x50: doBranchingOnPredicate(!cpu_fV); break  // BVC
        case 0x58: cpu_fI = false; cycles = 2;  break  // CLI

        // RTS
        case 0x60: cpu_pc = pullu16() + 1; cycles = 6; break

        // ADC
        case 0x61: doADC(read(addrIndX())); cycles = 6; break
        case 0x65: doADC(ramArr[readPC()]); cycles = 3; break
        case 0x69: doADC(readPC()); cycles = 2; break
        case 0x6D: doADC(read(readPCu16()));  cycles = 4; break
        case 0x71: doADC(read(addrIndY()));   cycles = 5 + pageCrossed; break
        case 0x75: doADC(read(addrZpX()));    cycles = 4; break
        case 0x79: doADC(read(addrAbsY()));   cycles = 4 + pageCrossed; break
        case 0x7D: doADC(read(addrAbsX()));   cycles = 4 + pageCrossed; break

        // ROR
        case 0x6A: { let c=cpu_fC?128:0; cpu_fC=(cpu_a&1)!=0; cpu_a=(cpu_a>>>1)|c; cpu_fZ=cpu_a==0; cpu_fN=cpu_a>127; cycles=2; break }
        case 0x66: temp = readPC();    write(temp, doROR(read(temp))); cycles = 5; break
        case 0x76: temp = addrZpX();   write(temp, doROR(read(temp))); cycles = 6; break
        case 0x6E: temp = readPCu16(); write(temp, doROR(read(temp))); cycles = 6; break
        case 0x7E: temp = addrAbsX();  write(temp, doROR(read(temp))); cycles = 7; break

        case 0x68: cpu_a = pull(); cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 4; break  // PLA
        case 0x70: doBranchingOnPredicate(cpu_fV); break  // BVS
        case 0x78: cpu_fI = true; cycles = 2; break    // SEI

        // STA
        case 0x81: write(addrIndX(), cpu_a); cycles = 6; break
        case 0x85: ramArr[readPC()] = cpu_a; cycles = 3; break
        case 0x8D: { let a=readPCu16(); if(a<0x2000)ramArr[a&0x7FF]=cpu_a; else write(a,cpu_a); cycles=4; break }
        case 0x91: write(addrIndY(), cpu_a); cycles = 6; break
        case 0x95: write(addrZpX(),  cpu_a); cycles = 4; break
        case 0x99: write(addrAbsY(), cpu_a); cycles = 5; break
        case 0x9D: write(addrAbsX(), cpu_a); cycles = 5; break

        // STY
        case 0x84: ramArr[readPC()] = cpu_y; cycles = 3; break
        case 0x8C: write(readPCu16(), cpu_y); cycles = 4; break
        case 0x94: write(addrZpX(),   cpu_y); cycles = 4; break

        // STX
        case 0x86: ramArr[readPC()] = cpu_x; cycles = 3; break
        case 0x8E: write(readPCu16(), cpu_x); cycles = 4; break
        case 0x96: write(addrZpY(),   cpu_x); cycles = 4; break

        case 0x88: cpu_y = (cpu_y-1)&0xFF; cpu_fZ = cpu_y==0; cpu_fN = cpu_y>127; cycles = 2; break  // DEY
        case 0x8A: cpu_a = cpu_x;          cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 2; break  // TXA
        case 0x90: doBranchingOnPredicate(!cpu_fC); break  // BCC
        case 0x98: cpu_a = cpu_y;          cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 2; break  // TYA
        case 0x9A: cpu_sp = cpu_x; cycles = 2; break  // TXS

        // LDY
        case 0xA0: cpu_y = readPC(); cpu_fZ = cpu_y==0; cpu_fN = cpu_y>127; cycles = 2; break
        case 0xA4: cpu_y = ramArr[readPC()]; cpu_fZ = cpu_y==0; cpu_fN = cpu_y>127; cycles = 3; break
        case 0xAC: cpu_y = read(readPCu16());  cpu_fZ = cpu_y==0; cpu_fN = cpu_y>127; cycles = 4; break
        case 0xB4: cpu_y = read(addrZpX());    cpu_fZ = cpu_y==0; cpu_fN = cpu_y>127; cycles = 4; break
        case 0xBC: cpu_y = read(addrAbsX());   cpu_fZ = cpu_y==0; cpu_fN = cpu_y>127; cycles = 4 + pageCrossed; break

        // LDA
        case 0xA1: cpu_a = read(addrIndX()); cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 6; break
        case 0xA5: cpu_a = ramArr[readPC()]; cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 3; break
        case 0xA9: cpu_a = readPC(); cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 2; break
        case 0xAD: { let a=readPCu16(); cpu_a=a<0x2000?ramArr[a&0x7FF]:read(a); cpu_fZ=cpu_a==0; cpu_fN=cpu_a>127; cycles=4; break }
        case 0xB1: cpu_a = read(addrIndY());   cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 5 + pageCrossed; break
        case 0xB5: cpu_a = read(addrZpX());    cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 4; break
        case 0xB9: cpu_a = read(addrAbsY());   cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 4 + pageCrossed; break
        case 0xBD: cpu_a = read(addrAbsX());   cpu_fZ = cpu_a==0; cpu_fN = cpu_a>127; cycles = 4 + pageCrossed; break

        // LDX
        case 0xA2: cpu_x = readPC(); cpu_fZ = cpu_x==0; cpu_fN = cpu_x>127; cycles = 2; break
        case 0xA6: cpu_x = ramArr[readPC()]; cpu_fZ = cpu_x==0; cpu_fN = cpu_x>127; cycles = 3; break
        case 0xAE: cpu_x = read(readPCu16());  cpu_fZ = cpu_x==0; cpu_fN = cpu_x>127; cycles = 4; break
        case 0xB6: cpu_x = read(addrZpY());    cpu_fZ = cpu_x==0; cpu_fN = cpu_x>127; cycles = 4; break
        case 0xBE: cpu_x = read(addrAbsY());   cpu_fZ = cpu_x==0; cpu_fN = cpu_x>127; cycles = 4 + pageCrossed; break

        case 0xA8: cpu_y = cpu_a; cpu_fZ = cpu_y==0; cpu_fN = cpu_y>127; cycles = 2; break  // TAY
        case 0xAA: cpu_x = cpu_a; cpu_fZ = cpu_x==0; cpu_fN = cpu_x>127; cycles = 2; break  // TAX
        case 0xB0: doBranchingOnPredicate(cpu_fC); break  // BCS
        case 0xB8: cpu_fV = false; cycles = 2; break  // CLV
        case 0xBA: cpu_x = cpu_sp; cpu_fZ = cpu_x==0; cpu_fN = cpu_x>127; cycles = 2; break  // TSX

        // CPY
        case 0xC0: { let v=readPC(); cpu_fC=cpu_y>=v; cpu_fZ=((cpu_y-v)&0xFF)==0; cpu_fN=((cpu_y-v)&0x80)!=0; cycles=2; break }
        case 0xC4: { let v=ramArr[readPC()]; cpu_fC=cpu_y>=v; cpu_fZ=((cpu_y-v)&0xFF)==0; cpu_fN=((cpu_y-v)&0x80)!=0; cycles=3; break }
        case 0xCC: doCMP(cpu_y, read(readPCu16()));  cycles = 4; break

        // CMP
        case 0xC1: doCMP(cpu_a, read(addrIndX())); cycles = 6; break
        case 0xC5: { let v=ramArr[readPC()]; cpu_fC=cpu_a>=v; cpu_fZ=((cpu_a-v)&0xFF)==0; cpu_fN=((cpu_a-v)&0x80)!=0; cycles=3; break }
        case 0xC9: { let v=readPC(); cpu_fC=cpu_a>=v; cpu_fZ=((cpu_a-v)&0xFF)==0; cpu_fN=((cpu_a-v)&0x80)!=0; cycles=2; break }
        case 0xCD: doCMP(cpu_a, read(readPCu16()));  cycles = 4; break
        case 0xD1: doCMP(cpu_a, read(addrIndY()));   cycles = 5 + pageCrossed; break
        case 0xD5: doCMP(cpu_a, read(addrZpX()));    cycles = 4; break
        case 0xD9: doCMP(cpu_a, read(addrAbsY()));   cycles = 4 + pageCrossed; break
        case 0xDD: doCMP(cpu_a, read(addrAbsX()));   cycles = 4 + pageCrossed; break

        // CPX
        case 0xE0: { let v=readPC(); cpu_fC=cpu_x>=v; cpu_fZ=((cpu_x-v)&0xFF)==0; cpu_fN=((cpu_x-v)&0x80)!=0; cycles=2; break }
        case 0xE4: { let v=ramArr[readPC()]; cpu_fC=cpu_x>=v; cpu_fZ=((cpu_x-v)&0xFF)==0; cpu_fN=((cpu_x-v)&0x80)!=0; cycles=3; break }
        case 0xEC: doCMP(cpu_x, read(readPCu16()));  cycles = 4; break

        // DEC
        case 0xC6: temp = readPC();    { let v=(read(temp)-1)&0xFF; write(temp,v); cpu_fZ=v==0; cpu_fN=v>127; } cycles = 5; break
        case 0xD6: temp = addrZpX();   { let v=(read(temp)-1)&0xFF; write(temp,v); cpu_fZ=v==0; cpu_fN=v>127; } cycles = 6; break
        case 0xCE: temp = readPCu16(); { let v=(read(temp)-1)&0xFF; write(temp,v); cpu_fZ=v==0; cpu_fN=v>127; } cycles = 6; break
        case 0xDE: temp = addrAbsX();  { let v=(read(temp)-1)&0xFF; write(temp,v); cpu_fZ=v==0; cpu_fN=v>127; } cycles = 7; break

        // INC
        case 0xE6: temp = readPC();    { let v=(read(temp)+1)&0xFF; write(temp,v); cpu_fZ=v==0; cpu_fN=v>127; } cycles = 5; break
        case 0xF6: temp = addrZpX();   { let v=(read(temp)+1)&0xFF; write(temp,v); cpu_fZ=v==0; cpu_fN=v>127; } cycles = 6; break
        case 0xEE: temp = readPCu16(); { let v=(read(temp)+1)&0xFF; write(temp,v); cpu_fZ=v==0; cpu_fN=v>127; } cycles = 6; break
        case 0xFE: temp = addrAbsX();  { let v=(read(temp)+1)&0xFF; write(temp,v); cpu_fZ=v==0; cpu_fN=v>127; } cycles = 7; break

        case 0xC8: cpu_y = (cpu_y+1)&0xFF; cpu_fZ = cpu_y==0; cpu_fN = cpu_y>127; cycles = 2; break  // INY
        case 0xCA: cpu_x = (cpu_x-1)&0xFF; cpu_fZ = cpu_x==0; cpu_fN = cpu_x>127; cycles = 2; break  // DEX
        case 0xE8: cpu_x = (cpu_x+1)&0xFF; cpu_fZ = cpu_x==0; cpu_fN = cpu_x>127; cycles = 2; break  // INX

        case 0xD0: doBranchingOnPredicate(!cpu_fZ); break  // BNE
        case 0xD8: cpu_fD = false; cycles = 2; break         // CLD

        // SBC
        case 0xE1: doSBC(read(addrIndX())); cycles = 6; break
        case 0xE5: doSBC(ramArr[readPC()]); cycles = 3; break
        case 0xE9: case 0xEB: doSBC(readPC()); cycles = 2; break
        case 0xED: doSBC(read(readPCu16()));   cycles = 4; break
        case 0xF1: doSBC(read(addrIndY()));    cycles = 5 + pageCrossed; break
        case 0xF5: doSBC(read(addrZpX()));     cycles = 4; break
        case 0xF9: doSBC(read(addrAbsY()));    cycles = 4 + pageCrossed; break
        case 0xFD: doSBC(read(addrAbsX()));    cycles = 4 + pageCrossed; break

        // 3-byte NOP (unofficial)
        case 0x0C: case 0x1C: case 0x3C: case 0x5C: case 0x7C: case 0xDC: case 0xFC: {
            let base = readPCu16()
            let addr = (base + cpu_x) & 0xFFFF
            pageCrossed = opcode != 0x0C && (base & 0xFF00) != (addr & 0xFF00)
            cycles = 4 + pageCrossed
            break
        }

        // 2-byte NOP (unofficial)
        case 0x04: case 0x14: case 0x34: case 0x44: case 0x54: case 0x64: case 0x74:
        case 0x80: case 0x89: case 0x82: case 0xD4: case 0xC2: case 0xF4: case 0xE2:
            readPC()
            cycles = 2 + ((opcode & 0x1F) == 0x04 ? 1 : ((opcode & 0x1F) == 0x14 ? 2 : 0))
            break

        // 1-byte NOP (unofficial)
        case 0x1A: case 0x3A: case 0x5A: case 0x7A: case 0xDA: case 0xEA: case 0xFA:
            cycles = 2
            break

        case 0xF0: doBranchingOnPredicate(cpu_fZ); break  // BEQ
        case 0xF8: cpu_fD = true; cycles = 2; break         // SED

        // XAA / ANE (unofficial, thermally unstable)
        case 0x8B: {
            let magic = 0xEE
            if (((Math.random()*128)|0) < 1) magic |= 0x10
            if (((Math.random()*128)|0) < 1) magic |= 0x01
            let r = (cpu_a | magic) & cpu_x & readPC()
            cpu_a = r
            cpu_fZ = r == 0; cpu_fN = r > 127
            if (((Math.random()*64)|0) < 1) cpu_fZ = !cpu_fZ
            if (((Math.random()*64)|0) < 1) cpu_fN  = !cpu_fN
            cycles = 2
            break
        }

        // HLT / KIL / JAM (unofficial, freezes CPU)
        case 0x02: case 0x12: case 0x22: case 0x32: case 0x42: case 0x52:
        case 0x62: case 0x72: case 0x92: case 0xB2: case 0xD2: case 0xF2:
            cpu_halted = true
            break

        default:
            serial.println(`Illegal opcode $${opcode.toString(16)} at PC $${((cpu_pc - 1) & 0xFFFF).toString(16)}`)
            cpu_halted = true
            break
    }

    // totalCycles updated here for tracelog; ppuCycleBudget is accumulated by run()
    prof_cpu_cycles  += cycles
    cpu_totalCycles  += cycles
}

///////////////////////////////////////////////////////////////////////////////
// ── Item 1: readPPU uses typed arrays ──
function readPPU(vramAddr) {
    if (vramAddr < 0x2000) {
        return chrArr[vramAddr]
    } else if (vramAddr < 0x3F00) {
        // Nametable read (mirroring via ntSlot LUT)
        return vramArr[ntSlot[(vramAddr >>> 10) & 3] * 0x400 + (vramAddr & 0x3FF)]
    } else {
        // Palette RAM
        if ((vramAddr & 3) == 0) return palArr[vramAddr & 0x0F]
        else                     return palArr[vramAddr & 0x1F]
    }
}


///////////////////////////////////////////////////////////////////////////////
// ── Item 3: per-scanline renderer replacing per-dot emulatePPU ──

// Pre-allocated per-scanline BG tile scratch (avoids GC)
const bgTileLo   = new Uint8Array(34)
const bgTileHi   = new Uint8Array(34)
const bgTileAttr = new Uint8Array(34)
// Pre-allocated sprite line buffers: filled once per scanline, read O(1) per pixel
const sprLinePalLo = new Uint8Array(256)  // 2-bit pixel (0 = transparent)
const sprLinePalHi = new Uint8Array(256)  // palette high bits (4-7 for sprites)
const sprLineFlags = new Uint8Array(256)  // bit 0 = in-front priority, bit 1 = sprite-zero pixel

// ── Sprite schedule: pre-built once per frame at the pre-render scanline ──
// Replaces the 64-entry OAM scan on every visible scanline (15,360 checks/frame)
// with a pre-indexed lookup: typically 0-4 sprites per scanline for mapper-0 games.
const sprSchedCount = new Uint8Array(240)       // active sprite slots per scanline
const sprSchedIdx   = new Uint8Array(240 * 8)  // OAM indices [0..63], up to 8 per scanline

function buildSpriteSchedule() {
    const sprH   = e.ppuUse8x16Sprites ? 16 : 8
    sprSchedCount.fill(0, 0, 240)
    for (let i = 0; i < 64; i++) {
        const y       = oamArr[i * 4]
        const slStart = (y + 1) & 0xFF  // NES: sprite Y is 1 less than rendering scanline; 255+1 wraps to 0 (pre-render → scanline 0)
        for (let j = 0; j < sprH; j++) {
            const sl = slStart + j
            if (sl >= 240) break
            const cnt = sprSchedCount[sl]
            if (cnt < 8) {
                sprSchedIdx[sl * 8 + cnt] = i
                sprSchedCount[sl] = cnt + 1
            } else {
                e.ppuStatusOverflow = true  // only fires if > 8 sprites on this line
            }
        }
    }
}

// ── Item 3: evaluate sprites for one scanline — uses pre-built schedule ──
function evalSpritesForScanline(sl) {
    const count = sprSchedCount[sl]
    const shL = e.ppuSpriteShiftRegL
    const shH = e.ppuSpriteShiftRegH
    const px  = e.ppuSpritePosX

    if (count == 0) {
        e.ppuScanlineContainsSprZero = false
        for (let i = 0; i < 8; i++) { shL[i] = 0; shH[i] = 0; px[i] = 0xFF }
        e.ppuSecondaryOAMsize = 0
        return 0
    }

    const use8x16   = e.ppuUse8x16Sprites
    const sprPTbase = e.ppuSpritePatternTable ? 0x1000 : 0
    const atr = e.ppuSpriteAtr
    const py  = e.ppuSpritePosY
    const ptn = e.ppuSpritePtn
    const schedBase = sl * 8

    // Sprite-zero is on this scanline iff the lowest OAM-index sprite here is sprite 0.
    // (Schedule is built in OAM order, so if sprite 0 hits this scanline it's at slot 0.)
    const sprZero = sprSchedIdx[schedBase] == 0

    for (let slot = 0; slot < count; slot++) {
        const i     = sprSchedIdx[schedBase + slot]
        const base  = i * 4
        const y     = oamArr[base]
        const row   = (sl - y - 1) & 0xFF  // NES +1 offset; & 0xFF handles Y=255 wrap (sl=0 → row=0)
        const spritePtn = oamArr[base + 1]
        const attrs = oamArr[base + 2]
        const posX  = oamArr[base + 3]

        atr[slot] = attrs
        px[slot]  = posX
        py[slot]  = y
        ptn[slot] = spritePtn

        // CHR address (inlined, sprite addresses always < 0x2000 → direct chrArr)
        let chrAddr
        if (!use8x16) {
            let r = (attrs & 0x80) != 0 ? 7 - row : row  // vertical flip
            chrAddr = sprPTbase | (spritePtn << 4) | r
        } else {
            const ptnBase = ((spritePtn & 1) ? 0x1000 : 0) | ((spritePtn & 0xFE) << 4)
            chrAddr = (attrs & 0x80) == 0
                ? (row < 8 ? ptnBase + row        : ptnBase + 16 + (row & 7))
                : (row < 8 ? ptnBase + 16 + (7-row) : ptnBase + (7 - (row & 7)))
        }

        let lo = chrArr[chrAddr]      // direct: sprite CHR always in pattern table
        let hi = chrArr[chrAddr + 8]
        if ((attrs & 0x40) != 0) { lo = bitRev8[lo]; hi = bitRev8[hi] }

        shL[slot] = lo
        shH[slot] = hi
    }

    e.ppuScanlineContainsSprZero = sprZero
    for (let i = count; i < 8; i++) { shL[i] = 0; shH[i] = 0; px[i] = 0xFF }
    e.ppuSecondaryOAMsize = count * 4
    return count
}

// ── Item 3: render one complete scanline ──
function renderScanline(sl) {
    const renderBG  = e.ppuMaskRenderBG
    const renderSpr = e.ppuMaskRenderSprites
    const maskBG8   = e.ppuMask8pxMaskBG
    const maskSp8   = e.ppuMask8pxMaskSprites
    const fineX     = e.ppuScrollFineX
    const fbArr     = e.fbArr
    // ── Item 8: frameskip — still compute sprite-0 hit but skip pixel writes ──
    const skip      = ppu_skipRender
    const fbBase    = sl * 256

    // Sprite evaluation
    const sprSlots = evalSpritesForScanline(sl)
    const shL = e.ppuSpriteShiftRegL
    const shH = e.ppuSpriteShiftRegH
    const sAtr = e.ppuSpriteAtr
    const sPx  = e.ppuSpritePosX
    const sprZeroThisSl = e.ppuScanlineContainsSprZero

    // Fetch 33 BG tiles (33 = 32 visible + 1 extra for fine-X overflow)
    if (renderBG) {
        let va = e.vramAddr
        const highPT = e.ppuBGPatternTable
        for (let tile = 0; tile < 33; tile++) {
            // Nametable read — inline readPPU for 0x2000–0x3EFF range (ntSlot LUT)
            const ntAddr = 0x2000 | (va & 0x0FFF)
            const tileId = vramArr[ntSlot[(ntAddr >>> 10) & 3] * 0x400 + (ntAddr & 0x3FF)]

            // Attribute read — same ntSlot mirroring
            const atAddr = 0x23C0 | (va & 0x0C00) | ((va >>> 4) & 0x38) | ((va >>> 2) & 0x07)
            let attr = vramArr[ntSlot[(atAddr >>> 10) & 3] * 0x400 + (atAddr & 0x3FF)]
            if (va & 2)         attr >>>= 2  // right half of attr cell
            if ((va >>> 5) & 2) attr >>>= 4  // bottom half of attr cell
            attr &= 3

            // Pattern reads — always < 0x2000, direct chrArr access
            const fineY  = (va >>> 12) & 7
            const ptnBase = (highPT ? 0x1000 : 0) | (tileId << 4) | fineY
            bgTileLo[tile]   = chrArr[ptnBase]
            bgTileHi[tile]   = chrArr[ptnBase + 8]
            bgTileAttr[tile] = attr

            // Advance coarse X
            if ((va & 0x1F) == 31) va = (va & ~0x1F) ^ 0x0400
            else                   va++
        }
    }

    // Pre-build sprite line: O(sprSlots × 8) ≤ 64 ops, so pixel loop needs no inner scan.
    // Higher-priority (lower index) sprites win; first opaque write per dot wins.
    sprLinePalLo.fill(0, 0, 256)
    if (renderSpr) {
        for (let i = 0; i < sprSlots; i++) {
            const startDot = sPx[i]
            if (startDot >= 256) continue
            const loB = shL[i], hiB = shH[i]
            const isZero = (i == 0 && sprZeroThisSl) ? 2 : 0
            const prio   = (sAtr[i] & 0x20) == 0 ? 1 : 0  // 1 = in front of BG
            const palH   = (sAtr[i] & 3) | 4              // sprite palettes 4-7
            for (let b = 7; b >= 0; b--) {
                const dot = startDot + (7 - b)
                if (dot >= 256) break
                if (sprLinePalLo[dot] != 0) continue       // higher-priority sprite already here
                const sLo = (loB >>> b) & 1
                const sHi = (hiB >>> b) & 1
                const sPL = (sHi << 1) | sLo
                if (sPL == 0) continue                     // transparent
                sprLinePalLo[dot] = sPL
                sprLinePalHi[dot] = palH
                sprLineFlags[dot] = prio | isZero
            }
        }
    }

    // Pixel loop — O(256), O(1) sprite lookup per dot
    let sprHitPending = sprZeroThisSl  // false once hit fires (fires at most once per scanline)
    for (let dot = 0; dot < 256; dot++) {
        // BG pixel
        let palLo = 0, palHi = 0
        if (renderBG && (dot >= 8 || !maskBG8)) {
            const eff = dot + fineX
            const t   = eff >>> 3
            const b   = 7 - (eff & 7)
            const lo  = (bgTileLo[t] >>> b) & 1
            const hi  = (bgTileHi[t] >>> b) & 1
            palLo     = (hi << 1) | lo
            palHi     = palLo != 0 ? bgTileAttr[t] : 0
        }

        // Sprite pixel (O(1): single array read)
        let finalLo = palLo, finalHi = palHi
        if (renderSpr && (dot >= 8 || !maskSp8)) {
            const sLo = sprLinePalLo[dot]
            if (sLo != 0) {
                const flags = sprLineFlags[dot]
                if (sprHitPending && (flags & 2) != 0 && palLo != 0 && dot < 255) {
                    e.ppuStatusSprZeroHit = true
                    sprHitPending = false
                }
                if ((flags & 1) != 0 || palLo == 0) {  // sprite in front, or BG transparent
                    finalLo = sLo
                    finalHi = sprLinePalHi[dot]
                }
            }
        }

        if (!skip) fbArr[fbBase + dot] = palArr[finalHi * 4 + finalLo]
    }
}

// ── Item 3: PPU budget driver (replaces per-dot emulatePPU) ──
function stepPPU() {
    let budget = ppu_cycleBudget
    if (budget <= 0) return
    ppu_cycleBudget = 0

    let dot = e.ppuDot
    let sl  = e.ppuScanline
    const renderOn = e.ppuMaskRenderBG || e.ppuMaskRenderSprites

    while (budget > 0) {
        let rem = 341 - dot
        if (budget >= rem) {
            // Consume the rest of this scanline
            budget -= rem

            // --- Scanline-end actions ---

            // Vblank set + frame boundary — drawNewFrame fires ONLY here (scanline-end).
            // ppuVblank is set early at dot 1 (mid-scanline check below) for NMI timing,
            // but drawNewFrame must fire exactly once per NES frame.
            if (sl == 241) {
                ppu_vblank    = true
                ppu_drawNewFrame = true
            }
            // Pre-render line: clear status flags + reset Y scroll + rebuild sprite schedule
            if (sl == 261) {
                ppu_vblank            = false
                e.ppuStatusOverflow    = false
                e.ppuStatusSprZeroHit  = false
                if (renderOn) {
                    ppuResetScrollY(e.vramAddr)
                    ppuResetScrollX(e.vramAddr)  // dot-257 equivalent on pre-render scanline
                }
                buildSpriteSchedule()  // OAM stable after vblank; pre-index for next frame
            }
            // Visible scanlines: render then update scrolling
            if (sl < 240) {
                if (renderOn) renderScanline(sl)
                if (renderOn) {
                    ppuIncrementScrollY(e.vramAddr)
                    ppuResetScrollX(e.vramAddr)
                }
                // MMC3 IRQ: tick once per visible scanline (per-scanline approximation of A12)
                if (mapperId == 4 && renderOn) mmc3ClockScanline()
            }
            // MMC3 IRQ: also tick on pre-render scanline
            if (sl == 261 && mapperId == 4 && renderOn) mmc3ClockScanline()

            // Advance to next scanline
            dot = 0
            sl++
            if (sl > 261) sl = 0
        } else {
            // Stay within the current scanline; check for mid-scanline vblank events.
            // Set ppuVblank at dot 1 for NMI edge timing — but NOT drawNewFrame here.
            // drawNewFrame fires only at scanline-end above, preventing double-trigger.
            let newDot = dot + budget
            if (sl == 241 && dot < 1 && newDot >= 1) {
                ppu_vblank = true
            }
            if (sl == 261 && dot < 1 && newDot >= 1) {
                ppu_vblank           = false
                e.ppuStatusOverflow   = false
                e.ppuStatusSprZeroHit = false
            }
            dot    = newDot
            budget = 0
        }
    }

    e.ppuDot      = dot
    e.ppuScanline = sl
}

function ppuIncrementScrollY(vramAddr) {
    if ((vramAddr & 0x7000) != 0x7000) {
        e.vramAddr = vramAddr + 0x1000
    } else {
        vramAddr &= 0x0FFF
        let y = (vramAddr & 0x03E0) >>> 5
        if (y == 29) { y = 0; vramAddr ^= 0x0800 }
        else y = (y + 1) & 0x1F
        e.vramAddr = (vramAddr & 0xFC1F) | (y << 5)
    }
}

function ppuResetScrollX(vramAddr) {
    e.vramAddr = (vramAddr & 0b0111101111100000) | (e.transferAddr & 0b0000010000011111)
}

function ppuResetScrollY(vramAddr) {
    e.vramAddr = (vramAddr & 0b0000010000011111) | (e.transferAddr & 0b0111101111100000)
}

///////////////////////////////////////////////////////////////////////////////
// Debug helpers (not in the hot rendering path)

function drawPatternTable() {
    for (let table = 0; table < 2; table++) {
        for (let row = 0; row < 16; row++) {
            for (let col = 0; col < 16; col++) {
                for (let y = 0; y < 8; y++) {
                    let lo = chrArr[0 + y + col*16 + row*256 + table*4096]
                    let hi = chrArr[8 + y + col*16 + row*256 + table*4096]
                    for (let x = 0; x < 8; x++) {
                        let px = (((lo >>> (7-x)) & 1)) | (((hi >>> (7-x)) & 1) << 1)
                        let palette = [240, 245, 250, 239]
                        e.fbArr[(y + row*8)*256 + (x + col*8 + table*128)] = palette[px]
                    }
                }
            }
        }
    }
}

function drawNameTable() {
    for (let row = 0; row < 30; row++) {
        for (let col = 0; col < 32; col++) {
            let attrOffset = ((col >>> 2) + (row >>> 2) * 8) & 255
            let attr    = vramArr[0x3C0 + attrOffset]
            let quadrant = (((col >>> 1) & 1) + ((row >>> 1) & 1) * 2) & 255
            let pair    = (attr >>> (quadrant * 2)) & 3
            let tileId  = vramArr[col + row * 32]
            let ptBase  = e.ppuBGPatternTable ? 0x1000 : 0

            for (let y = 0; y < 8; y++) {
                let lo = chrArr[ptBase + tileId * 16 + y]
                let hi = chrArr[ptBase + tileId * 16 + y + 8]
                for (let x = 0; x < 8; x++) {
                    let px  = (((lo >>> (7-x)) & 1)) | (((hi >>> (7-x)) & 1) << 1)
                    let col2 = (px == 0) ? palArr[0] : palArr[px + pair * 4]
                    e.fbArr[(y + row*8)*256 + (x + col*8)] = col2
                }
            }
        }
    }
}

///////////////////////////////////////////////////////////////////////////////

function render() {
    fbToGPU()
}

// ── Item 2: flush fbArr to GPU using sys.pokeBytes (single Kotlin call per row) ──
function fbToGPU() {
    // Bulk-copy each visible NES row directly into the GPU framebuffer via sys.pokeBytes.
    // GPU row y_gpu (0-based) starts at MMIO offset 1048577 + y_gpu*280 + 12 (12px left border).
    // Negative TSVM address = -(offset+1) maps to peripheral 1 at that offset.
    for (let y = 8; y < 232; y++) {
        let dest = -(1048577 + (y - 8) * 280 + 12)
        sys.pokeBytes(dest, e.fbArr.subarray(y * 256, y * 256 + 256), 256)
    }
}

// ── Audio adapter bootstrap (called once; idempotent if audioEnable is false) ──
function apuBootAudio() {
    if (!config.audioEnable || apuAudioBooted) return
    // Allocate LibPSG mix buffer: 25ms covers one frame (16.64ms) with slack
    libPsgBuf = psg.makeBuffer(0.025)
    // Native staging buffer for the final interleaved PSG+DMC upload
    apuSumStagingPtr = sys.calloc(1200)  // ≥ 600 stereo samples × 2 bytes
    // JS-side scratch for mix; no need to go through sys.malloc/poke for this step
    apu_sumBuf = new Uint8Array(1200)
    // Initialise playhead 0 (PSG+DMC are mixed into a single stream here)
    audio.resetParams(0)
    audio.purgeQueue(0)
    audio.setPcmMode(0)
    audio.setMasterVolume(0, config.audioVolume)
    audio.setPcmQueueCapacityIndex(0, 3)  // capacity index 3 → 12 chunks ≈ 200ms jitter
    audio.play(0)
    apuAudioBooted = true
}

function secToSamples(sec) { return Math.round(psg.HW_SAMPLING_RATE * sec) }

// Synthesise one NES frame's worth of audio and push to the TSVM Audio Adapter.
// Called every frame, OUTSIDE the frameskip gate so audio is never dropped.
function emitAudioFrame() {
    if (!config.audioEnable) return

    let frameCycles = cpu_totalCycles - apu_frameCyclesStart
    let frameSec    = frameCycles / 1789773.0
    if (frameSec <= 0) return

    let numSlices = apu_sliceCount  // typically 4 (one per QF tick) + initial = up to 5 slots

    // ── Mix PSG channels into libPsgBuf, quarter-frame slice by slice ──
    // Slice buffer positions are computed as integer sample counts first, then converted back
    // to seconds.  This avoids the secToSamples rounding mismatch where
    // round(A*SR) + round(D*SR) ≠ round((A+D)*SR), which would leave 1-sample gaps (stays at
    // the cleared 128 value) or overlaps between slices — visible as a notch + phase jump at
    // each QF event boundary (~133/266/399 samples into the frame).
    const SR = psg.HW_SAMPLING_RATE
    const totalSamples = Math.round(frameSec * SR)
    for (let s = 0; s < numSlices; s++) {
        const sBufStart = Math.round(apu_sliceOff[s] * SR)
        const sBufEnd   = (s + 1 < numSlices) ? Math.round(apu_sliceOff[s + 1] * SR) : totalSamples
        const sBufLen   = sBufEnd - sBufStart
        if (sBufLen <= 0) continue
        // Derive seconds from integer positions so secToSamples() round-trips cleanly
        const sliceStart = sBufStart / SR
        const sliceDur   = sBufLen   / SR

        if (apu_snapP1On[s])  psg.makeSquare(libPsgBuf, sliceDur, sliceStart,
            apu_snapP1Freq[s], apu_snapP1Duty[s], 'add', apu_snapP1Amp[s], 0.0, apu_absTimeSec)
        if (apu_snapP2On[s])  psg.makeSquare(libPsgBuf, sliceDur, sliceStart,
            apu_snapP2Freq[s], apu_snapP2Duty[s], 'add', apu_snapP2Amp[s], 0.0, apu_absTimeSec)
        if (apu_snapTriOn[s]) psg.makeAliasedTriangleNES(libPsgBuf, sliceDur, sliceStart,
            apu_snapTriFreq[s], 0.0, 'add', 0.25, 0.0, apu_absTimeSec)
        if (apu_snapNsOn[s])  psg.makeNoise(libPsgBuf, sliceDur, sliceStart,
            apu_snapNsFreq[s], apu_snapNsMode[s], 'add', apu_snapNsAmp[s], 0.0, apu_absTimeSec)
        // Sunsoft 5B PSG (FME-7 onboard) — fixed 50% duty square waves
        if (apu_snap5bAOn[s]) psg.makeSquare(libPsgBuf, sliceDur, sliceStart,
            apu_snap5bAFreq[s], 0.5, 'add', apu_snap5bAAmp[s], 0.0, apu_absTimeSec)
        if (apu_snap5bBOn[s]) psg.makeSquare(libPsgBuf, sliceDur, sliceStart,
            apu_snap5bBFreq[s], 0.5, 'add', apu_snap5bBAmp[s], 0.0, apu_absTimeSec)
        if (apu_snap5bCOn[s]) psg.makeSquare(libPsgBuf, sliceDur, sliceStart,
            apu_snap5bCFreq[s], 0.5, 'add', apu_snap5bCAmp[s], 0.0, apu_absTimeSec)
        // VRC6: 2 pulse (variable duty) + sawtooth (rising ramp via makeTriangle duty=1.0)
        if (apu_snapVrc6P1On[s]) psg.makeSquare(libPsgBuf, sliceDur, sliceStart,
            apu_snapVrc6P1Freq[s], apu_snapVrc6P1Duty[s], 'add', apu_snapVrc6P1Amp[s], 0.0, apu_absTimeSec)
        if (apu_snapVrc6P2On[s]) psg.makeSquare(libPsgBuf, sliceDur, sliceStart,
            apu_snapVrc6P2Freq[s], apu_snapVrc6P2Duty[s], 'add', apu_snapVrc6P2Amp[s], 0.0, apu_absTimeSec)
        if (apu_snapVrc6SawOn[s]) psg.makeAliasedTriangle(libPsgBuf, sliceDur, sliceStart,
            apu_snapVrc6SawFreq[s], 1.0, 'add', apu_snapVrc6SawAmp[s], 0.0, apu_absTimeSec)
    }

    // ── Mix PSG and DMC buffers into apu_sumBuf, then bulk-copy to hardware ──
    const nSamples = apu_dmcWritePos  // DMC sample count for this frame
    const dmcBytes = nSamples * 2
    const psgL = libPsgBuf[0], psgR = libPsgBuf[1]
    const dmcBuf = apu_dmcBuf, sumBuf = apu_sumBuf
    const lastPsgIdx = totalSamples - 1  // clamp index for rare DMC/PSG length mismatch
    for (let i = 0; i < nSamples; i++) {
        const j = i < totalSamples ? i : lastPsgIdx
        sumBuf[2*i]   = (psgL[j] + dmcBuf[2*i])   >>> 1
        sumBuf[2*i+1] = (psgR[j] + dmcBuf[2*i+1]) >>> 1
    }
    sys.pokeBytes(apuSumStagingPtr, sumBuf.subarray(0, dmcBytes), dmcBytes)
    audio.putPcmDataByPtr(0, apuSumStagingPtr, dmcBytes, 0)
    audio.setSampleUploadLength(0, dmcBytes)
    audio.startSampleUpload(0)

    // ── Reset for next frame ──
    apu_absTimeSec += totalSamples / SR  // integer-aligned so frame boundary is also gapless
    libPsgBuf[0].fill(128, 0, totalSamples)
    libPsgBuf[1].fill(128, 0, totalSamples)
    apu_dmcWritePos = 0
}

function uploadNESmasterPal() {
    let twoc02 = [0x666F,0x019F,0x10AF,0x409F,0x606F,0x602F,0x600F,0x410F,0x230F,0x040F,0x040F,0x041F,0x035F,0x000F,0x000F,0x000F,0xAAAF,0x04DF,0x32FF,0x71FF,0x90BF,0xB16F,0xA20F,0x840F,0x560F,0x270F,0x080F,0x083F,0x069F,0x000F,0x000F,0x000F,0xFFFF,0x5AFF,0x88FF,0xB6FF,0xD6FF,0xF6CF,0xF76F,0xD92F,0xBA0F,0x8C0F,0x5D2F,0x3D6F,0x3CCF,0x444F,0x000F,0x000F,0xFFFF,0xBEFF,0xCDFF,0xECFF,0xFCFF,0xFCEF,0xFCCF,0xFDAF,0xED9F,0xDE9F,0xCEAF,0xBECF,0xBEEF,0xBBBF,0x000F,0x000F]
    let twoc03 = [0x666F,0x029F,0x00DF,0x64DF,0x906F,0xB06F,0xB20F,0x940F,0x640F,0x240F,0x062F,0x090F,0x044F,0x000F,0x000F,0x000F,0xBBBF,0x06DF,0x04FF,0x90FF,0xB0FF,0xF09F,0xF00F,0xD60F,0x960F,0x290F,0x090F,0x0B6F,0x099F,0x000F,0x000F,0x000F,0xFFFF,0x6BFF,0x99FF,0xD6FF,0xF0FF,0xF6FF,0xF90F,0xFB0F,0xDD0F,0x6D0F,0x0F0F,0x4FDF,0x0FFF,0x000F,0x000F,0x000F,0xFFFF,0xBDFF,0xDBFF,0xFBFF,0xF9FF,0xFBBF,0xFD9F,0xFF4F,0xFF6F,0xBF4F,0x9F6F,0x4FDF,0x9DFF,0x000F,0x000F,0x000F]
    let pal = twoc02
    for (let i = 0; i < 64; i++) {
        let rg   = (pal[i] >>> 8) & 0xFF
        let ba   = pal[i] & 0xFF
        let addr = -(1310209 + 2*i)
        sys.poke(addr, rg); sys.poke(addr - 1, ba)
    }
}

///////////////////////////////////////////////////////////////////////////////

graphics.setBackground(0,0,0)
graphics.setGraphicsMode(1)
uploadNESmasterPal()
con.curs_set(0)
graphics.clearText()
graphics.setCursorYX(19, 1)

for (let px = 0; px < 20; px++) {
    for (let py = 0; py < 224; py++) {
        graphics.plotPixelMode1(px, py, 240, 1)
        graphics.plotPixelMode1(280 - px, py, 240, 1)
    }
}

reset()
apuBootAudio()

function updateButtonStatus() {
    let status = 0
    for (let i = -41; i >= -48; i--) {
        let key = sys.peek(i)
        if (key == 0) continue
        if (key == config.p1a)   status |= (1 << 0)
        if (key == config.p1b)   status |= (1 << 1)
        if (key == config.p1sel) status |= (1 << 2)
        if (key == config.p1sta) status |= (1 << 3)
        if (key == config.p1u)   status |= (1 << 4)
        if (key == config.p1d)   status |= (1 << 5)
        if (key == config.p1l)   status |= (1 << 6)
        if (key == config.p1r)   status |= (1 << 7)
    }
    e.currentButtonStatus = status
}

// ── Item 8: main loop with frameskip ──
let frameCounter = 0
// ── Speed regulator: pace to NES NTSC frame rate (60.0988 fps ≈ 16.639ms/frame) ──
// Slowdown is allowed (if the emulator is slower than real time we just run flat-out);
// fast-forward is prevented by sleeping the remainder of each frame's wall-clock budget.
// sys.sleep(ms) adds ~4ms of internal overhead (trailing Thread.sleep(4L) in the
// Kotlin bridge), so only sleep when we have >4ms of slack and subtract that overhead.
const NES_FRAME_NS = 16639267  // 1e9 / 60.0988
let speedTarget = sys.nanoTime() + NES_FRAME_NS
while (!appexit && !cpu_halted) {
    sys.poke(-40, 1)
    let keyCode = sys.peek(-41)

    if (keyCode == config.quit) {
        appexit = true
        break
    }

    updateButtonStatus()

    // Frameskip: on skipped frames the CPU+PPU still run (for correct timing),
    // but pixel writes to fbArr are suppressed. Only the rendered frames are
    // flushed to the GPU.
    frameCounter++
    ppu_skipRender = config.frameskip > 1 && (frameCounter % config.frameskip) != 0

    if (config.audioEnable) apuFrameStart()  // snapshot initial channel state, record frame start cycle
    run()
    { let _ta = sys.nanoTime(); emitAudioFrame(); prof_apu += sys.nanoTime() - _ta }  // always runs — audio must not be skipped with frameskip

    if (!ppu_skipRender) {
        let t2 = sys.nanoTime()
        render()
        prof_render += sys.nanoTime() - t2
        if (traceFile) traceFile.flush()

        prof_frames++
        if (prof_frames % PROF_INTERVAL == 0) {
            let wall = sys.nanoTime() - prof_wallStart
            let fps  = (prof_frames * 1e9 / wall + 0.5) | 0
            let total = prof_cpu + prof_ppu + prof_apu + prof_render
            let pctCPU    = total > 0 ? ((prof_cpu    * 100 / total + 0.5) | 0) : 0
            let pctPPU    = total > 0 ? ((prof_ppu    * 100 / total + 0.5) | 0) : 0
            let pctAPU    = total > 0 ? ((prof_apu    * 100 / total + 0.5) | 0) : 0
            // let pctRender = total > 0 ? ((prof_render * 100 / total + 0.5) | 0) : 0
            // let msPerFrame = total > 0 ? ((total / prof_frames / 1e6 * 10 + 0.5) | 0) / 10 : 0
            // serial.println(`[prof] ${fps} fps | ${msPerFrame}ms/frame | CPU:${pctCPU}% PPU:${pctPPU}% render:${pctRender}%`)

            // ── CPU sub-report ──
            const fi = prof_frames  // rendered-frame count this window
            // const iPerFr  = fi > 0 ? ((prof_cpu_instrs / fi + 0.5) | 0) : 0
            const cPerFr  = fi > 0 ? ((prof_cpu_cycles  / fi + 0.5) | 0) : 0
            // const nmiPerFr= fi > 0 ? ((prof_cpu_nmi * 10 / fi + 0.5) | 0) / 10 : 0
            const cycTotal = prof_cpu_cycles + prof_cpu_skip
            const pctSkip = cycTotal > 0 ? ((prof_cpu_skip * 100 / cycTotal + 0.5) | 0) : 0
            // serial.println(`[cpu ] ${iPerFr} i/fr  ${cPerFr} c/fr  NMI:${nmiPerFr}/fr  skip:${pctSkip}%`)


            graphics.setCursorYX(1, 1)
            println("FPS")
            println(fps+"      ")
            println("CPU")
            println(pctCPU+"       ")
            println("PPU")
            println(pctPPU+"       ")
            println("APU")
            println(pctAPU+"       ")
            println("SKIP")
            println(pctSkip+"       ")

            graphics.setCursorYX(1, 78)
            println("CYC")
            graphics.setCursorYX(2, 76)
            println(cPerFr)

            // ── Top-8 hottest opcodes ──
            /*let hotOps = []
            for (let op = 0; op < 256; op++) {
                if (prof_opcodeHits[op] > 0) hotOps.push([op, prof_opcodeHits[op]])
            }
            hotOps.sort((a, b) => b[1] - a[1])
            const totalInstrs = prof_cpu_instrs
            const hotStr = hotOps.slice(0, 8).map(([op, cnt]) => {
                const pct = totalInstrs > 0 ? ((cnt * 100 / totalInstrs + 0.5) | 0) : 0
                return `${OPCODE_NAMES[op] || '???'}($${op.toString(16).padStart(2,'0')}):${pct}%`
            }).join('  ')
            serial.println(`[cpu ] hot: ${hotStr}`)

            for (let i = 0; i < 8; i++) {
                graphics.setCursorYX(4+i, 78)
                println(OPCODE_NAMES[hotOps[i][0]])
            }*/

            // reset all CPU sub-counters
            prof_cpu = 0; prof_ppu = 0; prof_apu = 0; prof_render = 0; prof_frames = 0; prof_cpu_cycles = 0; prof_cpu_skip = 0
            // prof_cpu_instrs = 0; prof_cpu_nmi = 0;
            // prof_opcodeHits.fill(0)
            prof_wallStart = sys.nanoTime()
        }
    }

    // ── Speed regulator: sleep off any slack vs. the real-time NES frame budget ──
    let nowNs = sys.nanoTime()
    let remNs = speedTarget - nowNs
    if (remNs > 0) {
        let remMs = (remNs / 1e6) | 0
        if (remMs > 4) sys.sleep(remMs - 4)  // subtract the ~4ms sys.sleep overhead
        speedTarget += NES_FRAME_NS
    } else if (-remNs > NES_FRAME_NS) {
        // Running more than a full frame behind — don't try to fast-forward, reset anchor.
        speedTarget = nowNs + NES_FRAME_NS
    } else {
        speedTarget += NES_FRAME_NS
    }
}

if (traceFile) traceFile.flush()

// ── Audio adapter teardown ──
if (config.audioEnable && apuAudioBooted) {
    try {
        audio.stop(0); audio.purgeQueue(0)
        sys.free(apuSumStagingPtr)
        // libPsgBuf and apu_sumBuf are JS-backed; GC handles them
    } catch (_) { /* teardown must not abort cleanup */ }
}

// ── Battery-backed WRAM save (MMC1/3/6) ──
if (battery && savPath != null) {
    try {
        // Only write if wramArr has non-zero content (skip empty saves)
        let hasData = false
        for (let i = 0; i < wramArr.length; i++) { if (wramArr[i] != 0) { hasData = true; break } }
        if (hasData) {
            let savFile = files.open(savPath)
            if (savFile.exists) savFile.remove()
            savFile.mkFile()
            // bwrite expects an array; pass the wramArr directly
            let wramSz = (subMapper == 1) ? 0x400 : 0x2000  // MMC6: 1 KB
            savFile.bwrite(wramArr.subarray(0, wramSz))
        }
    } catch (_) { /* failed save must not abort cleanup */ }
}

con.curs_set(1)
graphics.clearText()
graphics.setCursorYX(1, 1)
graphics.resetPalette()

e.free()
