// NES Emulator for TSVM
// Based on tutorial by 100thCoin
// https://www.patreon.com/posts/making-your-nes-137873901

let appexit = false

// config
const config = {}
config.frameskip = 2 // 0: invalid, 1: no skip, 2: every other frame, 3: every 3rd frame
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
// iNES header (16 bytes)
e.inesHdr = new Uint8Array(16)
// ── Item 2: framebuffer as JS typed array; GPU flush done at frame-end ──
e.fbArr = new Uint8Array(256 * 240)  // NES framebuffer (palette indices)
// e.fb usermem scratch removed — fbToGPU now uses sys.pokeBytes directly to GPU
// 6502 registers
e.pc = 0
e.sp = 0
e.a = 0
e.x = 0
e.y = 0
// 6502 flags
e.halted  = false
e.fCarry  = false
e.fZero   = false
e.fIntdis = false
e.fDec    = false
e.fOvf    = false
e.fNeg    = false
// NMI state
e.nmiLevel = false
e.doNMI    = false
e.nmiFired = 0
// PPU registers & internal state
e.writeLatch       = false
e.transferAddr     = 0
e.vramAddr         = 0
e._tempVramAddr    = 0
e.ppuVramInc32Mode = false
e.ppuReadBuffer    = 0
e.ppuDot           = 0
e.ppuScanline      = 0
e.ppuVblank        = false
e.ppuMask8pxMaskBG      = false
e.ppuMask8pxMaskSprites = false
e.ppuMaskRenderBG       = false
e.ppuMaskRenderSprites  = false
e.ppuNametableSelect  = 0
e.ppuSpritePatternTable = false
e.ppuBGPatternTable     = false
e.ppuUse8x16Sprites     = false
e.ppuEnableNMI          = false
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
// ── Item 3: scanline-based PPU budget ──
e.ppuCycleBudget = 0
// ── Item 8: frame skip state ──
e.skipRender = false
// Controller shift registers
e.currentButtonStatus = 0
e.cnt1sr = 0
e.cnt2sr = 0
// Emulation timing
e.drawNewFrame = false
e.totalCycles  = 0     // cumulative CPU cycles (used by tracelogger)

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

function readPC() {
    let pc = e.pc
    let v = pc >= 0x8000 ? e.romArr[pc - 0x8000] : read(pc)
    e.pc = (pc + 1) & 0xFFFF
    return v
}

function readPCs() {
    let v = readPC()
    return v > 127 ? v - 256 : v
}

function readPCu16() {
    let pc = e.pc
    let lo, hi
    if (pc >= 0x8000) {
        lo = e.romArr[pc - 0x8000]
        hi = e.romArr[(pc + 1) - 0x8000]
    } else {
        lo = read(pc)
        hi = read(pc + 1)
    }
    e.pc = (pc + 2) & 0xFFFF
    return (hi << 8) | lo
}

function movPC(offset) {
    e.pc = (e.pc + offset) & 0xFFFF
}

function incPC() { e.pc = (e.pc + 1) & 0xFFFF }
function decPC() { e.pc = e.pc == 0 ? 65535 : e.pc - 1 }

function pushPC() {
    let pc = e.pc
    push((pc >>> 8) & 0xFF)
    push(pc & 0xFF)
}

e.free = () => {
    // no usermem allocations to free (fbArr is a JS typed array)
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
    if (offset < 0x2000) return e.ramArr[offset & 0x7FF]
    // PPU registers ($2000–$3FFF, mirrors of $2000–$2007)
    if (offset < 0x4000) {
        offset &= 0x2007
        switch (offset) {
            case 0x2002: { // PPUSTATUS
                let ppuStatus = 0
                if (e.ppuVblank)            ppuStatus |= 0x80
                if (e.ppuStatusSprZeroHit)  ppuStatus |= 0x40
                if (e.ppuStatusOverflow)    ppuStatus |= 0x20
                e.ppuVblank   = false
                e.writeLatch  = false
                return ppuStatus
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
                return temp
            }
            default: return 0
        }
    }
    // Controller 1 ($4016) — NES shift register sends LSB first (A=bit0, B=bit1, ...)
    if (offset == 0x4016) {
        let bit = e.cnt1sr & 1
        e.cnt1sr = e.cnt1sr >>> 1
        return bit
    }
    // Controller 2 ($4017)
    if (offset == 0x4017) {
        let bit = e.cnt2sr & 1
        e.cnt2sr = e.cnt2sr >>> 1
        return bit
    }
    // PRG ROM ($8000–$FFFF)
    if (offset >= 0x8000) return e.romArr[offset - 0x8000]
    // Unmapped
    return 0
}

function readSigned(offset) {
    let t = read(offset)
    return t > 127 ? t - 256 : t
}

// ── Item 1: write() uses typed arrays ──
function write(offset0, value) {
    let offset = offset0 & 0xFFFF
    // CPU RAM ($0000–$1FFF, 2KB mirrored)
    if (offset < 0x2000) {
        e.ramArr[offset & 0x7FF] = value
        return
    }
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
                e.ppuEnableNMI        = (value & 128) != 0
                // propagate NT bits into _tempVramAddr bits 10–11
                e._tempVramAddr = (e._tempVramAddr & 0b0111001111111111) | ((value & 3) << 10)
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
                e.oamArr[e.ppuOAMaddr] = value
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
                    e._tempVramAddr = (value & 0x3F) << 8
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
                    // CHR RAM (only if no CHR ROM banks)
                    if (e.inesHdr[5] == 0) e.chrArr[vramAddr] = value
                } else if (vramAddr < 0x3F00) {
                    // Nametable VRAM (with mirroring)
                    if ((e.inesHdr[6] & 1) == 0) {
                        // horizontal mirroring
                        e.vramArr[(vramAddr & 0x3FF) | ((vramAddr & 0x800) >>> 1)] = value
                    } else {
                        // vertical mirroring
                        e.vramArr[vramAddr & 0x7FF] = value
                    }
                } else {
                    // Palette RAM
                    if ((vramAddr & 3) == 0) {
                        e.palArr[vramAddr & 0x0F] = value
                    } else {
                        e.palArr[vramAddr & 0x1F] = value
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
                        e.oamArr[i] = e.ramArr[(base + i) & 0x7FF]
                    }
                } else if (src >= 0x8000) {
                    // ROM source (uncommon)
                    let rbase = src - 0x8000
                    for (let i = 0; i < 256; i++) {
                        e.oamArr[i] = e.romArr[rbase + i]
                    }
                } else {
                    // Other sources (slow path, very rare)
                    for (let i = 0; i < 256; i++) {
                        e.oamArr[i] = read(src + i)
                    }
                }
                cycles += 513  // OAM DMA CPU stall
                break
            }
            case 0x4016: // Controller strobe
                e.cnt1sr = e.currentButtonStatus
                e.cnt2sr = 0
                break
        }
        return
    }
    // Cartridge space ($4020–$7FFF): SRAM / expansion — ignored for mapper 0
}

function push(value) {
    write(0x100 + e.sp, value)
    e.sp = (e.sp - 1) & 0xFF
}

function pull() {
    e.sp = (e.sp + 1) & 0xFF
    return read(0x100 + e.sp)
}

function pullu16() {
    let lo = pull()
    let hi = pull()
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

    // Copy PRG ROM, handling 1-bank (16KB, mirrored) and 2-bank (32KB) cases
    let prgBanks = e.inesHdr[4]
    let prgSize  = prgBanks * 0x4000
    for (let i = 0; i < 0x8000; i++) {
        e.romArr[i] = sys.peek(headeredRom + 0x10 + (i % prgSize))
    }

    // Copy CHR ROM (if present; if 0 banks, chrArr stays as CHR RAM)
    let chrBanks = e.inesHdr[5]
    if (chrBanks > 0) {
        let chrOffset = 0x10 + prgSize
        let chrSize = chrBanks * 0x2000
        if (chrSize > 0x2000) chrSize = 0x2000
        for (let i = 0; i < chrSize; i++) {
            e.chrArr[i] = sys.peek(headeredRom + chrOffset + i)
        }
    }

    sys.free(headeredRom)

    // RESET vector
    e.fIntdis = true
    let PCL = read(0xFFFC)
    let PCH = read(0xFFFD)
    e.pc = (PCH << 8) | PCL
    e.sp = 0xFD

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
    if (addr < 0x2000) return e.ramArr[addr & 0x7FF]
    if (addr >= 0x8000) return e.romArr[addr - 0x8000]
    return 0
}

// ── Item 11: tracelogger v2 — matches Tracelogs/SuperMarioBros.txt format ──
let traceLogCnt = 0
let traceFile = null   // set in reset() when config.printTracelog is true
function printTracelog(opcode) {
    // Recover opcode address: PC has already been incremented past the opcode byte.
    let pc = e.pc
    if (!e.doNMI) {
        pc = (pc - 1) & 0xFFFF  // back up to opcode byte address
    }
    if (e.doNMI) opcode = 0x100  // NMI pseudo-opcode

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
                                ((b1 + e.x) & 0xFF).toString(16).padStart(2,'0').toUpperCase(); break
            case 5: instrStr += '<$' + b1.toString(16).padStart(2,'0').toUpperCase() + ', Y -> $' +
                                ((b1 + e.y) & 0xFF).toString(16).padStart(2,'0').toUpperCase(); break
            case 6: instrStr += '$' + b2.toString(16).padStart(2,'0').toUpperCase() +
                                       b1.toString(16).padStart(2,'0').toUpperCase(); break
            case 7: instrStr += '$' + b2.toString(16).padStart(2,'0').toUpperCase() +
                                       b1.toString(16).padStart(2,'0').toUpperCase() +
                                ', X -> $' + ((abs16 + e.x) & 0xFFFF).toString(16).padStart(4,'0').toUpperCase(); break
            case 8: instrStr += '$' + b2.toString(16).padStart(2,'0').toUpperCase() +
                                       b1.toString(16).padStart(2,'0').toUpperCase() +
                                ', Y -> $' + ((abs16 + e.y) & 0xFFFF).toString(16).padStart(4,'0').toUpperCase(); break
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
                let zpAddr = (b1 + e.x) & 0xFF
                let resolved = peekRO(zpAddr) | (peekRO((zpAddr + 1) & 0xFF) << 8)
                instrStr += '($00' + b1.toString(16).padStart(2,'0').toUpperCase() +
                            ', X) -> $' + resolved.toString(16).padStart(4,'0').toUpperCase(); break
            }
            case 12: { // (zp), Y
                let resolved = (peekRO(b1) | (peekRO((b1 + 1) & 0xFF) << 8))
                instrStr += '($00' + b1.toString(16).padStart(2,'0').toUpperCase() +
                            '), Y -> $' + ((resolved + e.y) & 0xFFFF).toString(16).padStart(4,'0').toUpperCase(); break
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
    let flags = (e.fNeg    ? 'N' : 'n') + (e.fOvf    ? 'V' : 'v') + '--' +
                (e.fDec    ? 'D' : 'd') + (e.fIntdis  ? 'I' : 'i') +
                (e.fZero   ? 'Z' : 'z') + (e.fCarry   ? 'C' : 'c')

    // ── PPU cycle formula (matches C# TriCnes logic) ──
    let sl = e.ppuScanline, dot = e.ppuDot, totalCyc = e.totalCycles
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
            'A:' + e.a.toString(16).padStart(2,'0').toUpperCase() + '\t' +
            'X:' + e.x.toString(16).padStart(2,'0').toUpperCase() + '\t' +
            'Y:' + e.y.toString(16).padStart(2,'0').toUpperCase() + '\t' +
            'SP:' + e.sp.toString(16).padStart(2,'0').toUpperCase() + '\t' +
            flags + '\t' +
            'Cycle: ' + totalCyc + '\t' +
            'PPU_cycle: ' + ppuCyc + ' ' + ppuPos + '\t' +
            '\tVRAMAddress:' + e.vramAddr.toString(16).padStart(4,'0').toUpperCase() +
            '\tPPUReadBuffer:' + e.ppuReadBuffer.toString(16).padStart(2,'0').toUpperCase()
    traceFile.sappend(s + '\n')
    traceLogCnt++
}

///////////////////////////////////////////////////////////////////////////////

function run() {
    while (!e.halted) {
        emulateCPU()
        stepPPU()
        if (e.drawNewFrame) {
            e.drawNewFrame = false
            break
        }
    }
    if (e.halted) serial.println('CPU Halted')
}

// Module-level scratch (shared across emulateCPU and address-mode helpers)
let cycles = 0
let temp   = 0
let pageCrossed = false

function doBranchingOnPredicate(p) {
    let sv = readPCs()
    let oldPCh = e.pc >>> 8
    if (p) {
        movPC(sv)
        let newPCh = e.pc >>> 8
        cycles = 3 + ((oldPCh != newPCh) ? 1 : 0)
    } else {
        cycles = 2
    }
}

function readZpU16(addr) {
    let lo = read(addr & 0xFF)
    let hi = read((addr + 1) & 0xFF)
    return (hi << 8) | lo
}

function readU16Wrap(addr) {
    let lo = read(addr)
    let hi = read((addr & 0xFF00) | ((addr + 1) & 0xFF))
    return (hi << 8) | lo
}

// ── Item 5: addressing modes use top-level readPC/readPCu16 ──
function addrZpX()  { return (readPC() + e.x) & 0xFF }
function addrZpY()  { return (readPC() + e.y) & 0xFF }
function addrAbsX() {
    let base = readPCu16()
    let addr = (base + e.x) & 0xFFFF
    pageCrossed = (base & 0xFF00) != (addr & 0xFF00)
    return addr
}
function addrAbsY() {
    let base = readPCu16()
    let addr = (base + e.y) & 0xFFFF
    pageCrossed = (base & 0xFF00) != (addr & 0xFF00)
    return addr
}
function addrIndX() { return readZpU16((readPC() + e.x) & 0xFF) }
function addrIndY() {
    let base = readZpU16(readPC())
    let addr = (base + e.y) & 0xFFFF
    pageCrossed = (base & 0xFF00) != (addr & 0xFF00)
    return addr
}

// ALU helpers (use e.* directly for brevity; hot path is the typed-array reads above)
function doADC(val) {
    let sum = e.a + val + (e.fCarry ? 1 : 0)
    e.fOvf   = ((~(e.a ^ val)) & (e.a ^ sum) & 0x80) != 0
    e.fCarry = sum > 255
    e.a      = sum & 0xFF
    e.fZero  = e.a == 0; e.fNeg = e.a > 127  // ── Item 6: inline setResultFlags ──
}
function doSBC(val) { doADC(val ^ 0xFF) }
function doCMP(reg, val) {
    let diff   = reg - val
    e.fCarry = reg >= val
    e.fZero  = (diff & 0xFF) == 0
    e.fNeg   = (diff & 0x80) != 0
}
function doASL(val) {
    e.fCarry = (val & 0x80) != 0
    let r = (val << 1) & 0xFF
    e.fZero = r == 0; e.fNeg = r > 127
    return r
}
function doLSR(val) {
    e.fCarry = (val & 1) != 0
    let r = val >>> 1
    e.fZero = r == 0; e.fNeg = r > 127
    return r
}
function doROL(val) {
    let oldC = e.fCarry ? 1 : 0
    e.fCarry = (val & 0x80) != 0
    let r = ((val << 1) | oldC) & 0xFF
    e.fZero = r == 0; e.fNeg = r > 127
    return r
}
function doROR(val) {
    let oldC = e.fCarry ? 128 : 0
    e.fCarry = (val & 1) != 0
    let r = (val >>> 1) | oldC
    e.fZero = r == 0; e.fNeg = r > 127
    return r
}
function packFlags(bFlag) {
    return (e.fNeg    ? 0x80 : 0) | (e.fOvf    ? 0x40 : 0) | 0x20 |
           (bFlag     ? 0x10 : 0) | (e.fDec    ? 0x08 : 0) |
           (e.fIntdis ? 0x04 : 0) | (e.fZero   ? 0x02 : 0) | (e.fCarry ? 0x01 : 0)
}
function unpackFlags(val) {
    e.fNeg    = (val & 0x80) != 0
    e.fOvf    = (val & 0x40) != 0
    e.fDec    = (val & 0x08) != 0
    e.fIntdis = (val & 0x04) != 0
    e.fZero   = (val & 0x02) != 0
    e.fCarry  = (val & 0x01) != 0
}

///////////////////////////////////////////////////////////////////////////////
// ── Items 4, 6, 10: emulateCPU with fast opcode fetch, inlined flags ──
function emulateCPU() {
    // NMI edge detection
    let prevNMIlevel = e.nmiLevel
    e.nmiLevel = e.ppuEnableNMI && e.ppuVblank
    if (!prevNMIlevel && e.nmiLevel) e.doNMI = true

    let opcode
    if (!e.doNMI) {
        // ── Item 10: fast opcode fetch from ROM without going through read() ──
        let pc = e.pc
        if (pc >= 0x8000) {
            opcode = e.romArr[pc - 0x8000]
            e.pc = (pc + 1) & 0xFFFF
        } else {
            opcode = read(pc)
            e.pc = (pc + 1) & 0xFFFF
        }
    } else {
        opcode = 0x00
    }

    if (config.printTracelog) printTracelog(opcode)

    switch (opcode) {

        // BRK / NMI / IRQ handler
        case 0x00:
            if (!e.doNMI) incPC()  // skip padding byte
            pushPC()
            push(packFlags(true))
            e.pc    = e.doNMI ? (read(0xFFFA) | (read(0xFFFB) << 8)) : (read(0xFFFE) | (read(0xFFFF) << 8))
            e.doNMI = false
            e.nmiFired++
            cycles  = 7
            break

        // ORA
        case 0x01: e.a = e.a | read(addrIndX()); e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 6; break
        case 0x05: e.a = e.a | read(readPC());    e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 3; break
        case 0x09: e.a = e.a | readPC();           e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 2; break
        case 0x0D: e.a = e.a | read(readPCu16());  e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 4; break
        case 0x11: e.a = e.a | read(addrIndY());   e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 5 + pageCrossed; break
        case 0x15: e.a = e.a | read(addrZpX());    e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 4; break
        case 0x19: e.a = e.a | read(addrAbsY());   e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 4 + pageCrossed; break
        case 0x1D: e.a = e.a | read(addrAbsX());   e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 4 + pageCrossed; break

        // ASL
        case 0x0A: e.a = doASL(e.a); cycles = 2; break
        case 0x06: temp = readPC();    write(temp, doASL(read(temp))); cycles = 5; break
        case 0x16: temp = addrZpX();   write(temp, doASL(read(temp))); cycles = 6; break
        case 0x0E: temp = readPCu16(); write(temp, doASL(read(temp))); cycles = 6; break
        case 0x1E: temp = addrAbsX();  write(temp, doASL(read(temp))); cycles = 7; break

        case 0x08: push(packFlags(true)); cycles = 3; break  // PHP
        case 0x10: doBranchingOnPredicate(!e.fNeg);  break  // BPL
        case 0x18: e.fCarry = false; cycles = 2; break       // CLC

        // JSR
        case 0x20: temp = readPCu16(); decPC(); pushPC(); e.pc = temp; cycles = 6; break

        // AND
        case 0x21: e.a = e.a & read(addrIndX()); e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 6; break
        case 0x25: e.a = e.a & read(readPC());    e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 3; break
        case 0x29: e.a = e.a & readPC();           e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 2; break
        case 0x2D: e.a = e.a & read(readPCu16());  e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 4; break
        case 0x31: e.a = e.a & read(addrIndY());   e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 5 + pageCrossed; break
        case 0x35: e.a = e.a & read(addrZpX());    e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 4; break
        case 0x39: e.a = e.a & read(addrAbsY());   e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 4 + pageCrossed; break
        case 0x3D: e.a = e.a & read(addrAbsX());   e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 4 + pageCrossed; break

        // BIT
        case 0x24: temp = read(readPC());    e.fZero = (e.a & temp)==0; e.fOvf = (temp&0x40)!=0; e.fNeg = (temp&0x80)!=0; cycles = 3; break
        case 0x2C: temp = read(readPCu16()); e.fZero = (e.a & temp)==0; e.fOvf = (temp&0x40)!=0; e.fNeg = (temp&0x80)!=0; cycles = 4; break

        // ROL
        case 0x2A: e.a = doROL(e.a); cycles = 2; break
        case 0x26: temp = readPC();    write(temp, doROL(read(temp))); cycles = 5; break
        case 0x36: temp = addrZpX();   write(temp, doROL(read(temp))); cycles = 6; break
        case 0x2E: temp = readPCu16(); write(temp, doROL(read(temp))); cycles = 6; break
        case 0x3E: temp = addrAbsX();  write(temp, doROL(read(temp))); cycles = 7; break

        case 0x28: unpackFlags(pull()); cycles = 4; break  // PLP
        case 0x30: doBranchingOnPredicate(e.fNeg);  break  // BMI
        case 0x38: e.fCarry = true;  cycles = 2; break      // SEC

        // RTI
        case 0x40: unpackFlags(pull()); e.pc = pullu16(); cycles = 6; break

        // EOR
        case 0x41: e.a = e.a ^ read(addrIndX()); e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 6; break
        case 0x45: e.a = e.a ^ read(readPC());    e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 3; break
        case 0x49: e.a = e.a ^ readPC();           e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 2; break
        case 0x4D: e.a = e.a ^ read(readPCu16());  e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 4; break
        case 0x51: e.a = e.a ^ read(addrIndY());   e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 5 + pageCrossed; break
        case 0x55: e.a = e.a ^ read(addrZpX());    e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 4; break
        case 0x59: e.a = e.a ^ read(addrAbsY());   e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 4 + pageCrossed; break
        case 0x5D: e.a = e.a ^ read(addrAbsX());   e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 4 + pageCrossed; break

        // LSR
        case 0x4A: e.a = doLSR(e.a); cycles = 2; break
        case 0x46: temp = readPC();    write(temp, doLSR(read(temp))); cycles = 5; break
        case 0x56: temp = addrZpX();   write(temp, doLSR(read(temp))); cycles = 6; break
        case 0x4E: temp = readPCu16(); write(temp, doLSR(read(temp))); cycles = 6; break
        case 0x5E: temp = addrAbsX();  write(temp, doLSR(read(temp))); cycles = 7; break

        case 0x48: push(e.a); cycles = 3; break             // PHA
        case 0x4C: e.pc = readPCu16(); cycles = 3; break    // JMP abs
        case 0x6C: e.pc = readU16Wrap(readPCu16()); cycles = 5; break  // JMP indirect

        case 0x50: doBranchingOnPredicate(!e.fOvf); break  // BVC
        case 0x58: e.fIntdis = false; cycles = 2;  break  // CLI

        // RTS
        case 0x60: e.pc = pullu16() + 1; cycles = 6; break

        // ADC
        case 0x61: doADC(read(addrIndX())); cycles = 6; break
        case 0x65: doADC(read(readPC()));    cycles = 3; break
        case 0x69: doADC(readPC());           cycles = 2; break
        case 0x6D: doADC(read(readPCu16()));  cycles = 4; break
        case 0x71: doADC(read(addrIndY()));   cycles = 5 + pageCrossed; break
        case 0x75: doADC(read(addrZpX()));    cycles = 4; break
        case 0x79: doADC(read(addrAbsY()));   cycles = 4 + pageCrossed; break
        case 0x7D: doADC(read(addrAbsX()));   cycles = 4 + pageCrossed; break

        // ROR
        case 0x6A: e.a = doROR(e.a); cycles = 2; break
        case 0x66: temp = readPC();    write(temp, doROR(read(temp))); cycles = 5; break
        case 0x76: temp = addrZpX();   write(temp, doROR(read(temp))); cycles = 6; break
        case 0x6E: temp = readPCu16(); write(temp, doROR(read(temp))); cycles = 6; break
        case 0x7E: temp = addrAbsX();  write(temp, doROR(read(temp))); cycles = 7; break

        case 0x68: e.a = pull(); e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 4; break  // PLA
        case 0x70: doBranchingOnPredicate(e.fOvf); break  // BVS
        case 0x78: e.fIntdis = true; cycles = 2; break    // SEI

        // STA
        case 0x81: write(addrIndX(), e.a); cycles = 6; break
        case 0x85: write(readPC(),   e.a); cycles = 3; break
        case 0x8D: write(readPCu16(), e.a); cycles = 4; break
        case 0x91: write(addrIndY(), e.a); cycles = 6; break
        case 0x95: write(addrZpX(),  e.a); cycles = 4; break
        case 0x99: write(addrAbsY(), e.a); cycles = 5; break
        case 0x9D: write(addrAbsX(), e.a); cycles = 5; break

        // STY
        case 0x84: write(readPC(),    e.y); cycles = 3; break
        case 0x8C: write(readPCu16(), e.y); cycles = 4; break
        case 0x94: write(addrZpX(),   e.y); cycles = 4; break

        // STX
        case 0x86: write(readPC(),    e.x); cycles = 3; break
        case 0x8E: write(readPCu16(), e.x); cycles = 4; break
        case 0x96: write(addrZpY(),   e.x); cycles = 4; break

        case 0x88: e.y = (e.y-1)&0xFF; e.fZero = e.y==0; e.fNeg = e.y>127; cycles = 2; break  // DEY
        case 0x8A: e.a = e.x;          e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 2; break  // TXA
        case 0x90: doBranchingOnPredicate(!e.fCarry); break  // BCC
        case 0x98: e.a = e.y;          e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 2; break  // TYA
        case 0x9A: e.sp = e.x; cycles = 2; break  // TXS

        // LDY
        case 0xA0: e.y = readPC();           e.fZero = e.y==0; e.fNeg = e.y>127; cycles = 2; break
        case 0xA4: e.y = read(readPC());     e.fZero = e.y==0; e.fNeg = e.y>127; cycles = 3; break
        case 0xAC: e.y = read(readPCu16());  e.fZero = e.y==0; e.fNeg = e.y>127; cycles = 4; break
        case 0xB4: e.y = read(addrZpX());    e.fZero = e.y==0; e.fNeg = e.y>127; cycles = 4; break
        case 0xBC: e.y = read(addrAbsX());   e.fZero = e.y==0; e.fNeg = e.y>127; cycles = 4 + pageCrossed; break

        // LDA
        case 0xA1: e.a = read(addrIndX()); e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 6; break
        case 0xA5: e.a = read(readPC());    e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 3; break
        case 0xA9: e.a = readPC();           e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 2; break
        case 0xAD: e.a = read(readPCu16());  e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 4; break
        case 0xB1: e.a = read(addrIndY());   e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 5 + pageCrossed; break
        case 0xB5: e.a = read(addrZpX());    e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 4; break
        case 0xB9: e.a = read(addrAbsY());   e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 4 + pageCrossed; break
        case 0xBD: e.a = read(addrAbsX());   e.fZero = e.a==0; e.fNeg = e.a>127; cycles = 4 + pageCrossed; break

        // LDX
        case 0xA2: e.x = readPC();           e.fZero = e.x==0; e.fNeg = e.x>127; cycles = 2; break
        case 0xA6: e.x = read(readPC());     e.fZero = e.x==0; e.fNeg = e.x>127; cycles = 3; break
        case 0xAE: e.x = read(readPCu16());  e.fZero = e.x==0; e.fNeg = e.x>127; cycles = 4; break
        case 0xB6: e.x = read(addrZpY());    e.fZero = e.x==0; e.fNeg = e.x>127; cycles = 4; break
        case 0xBE: e.x = read(addrAbsY());   e.fZero = e.x==0; e.fNeg = e.x>127; cycles = 4 + pageCrossed; break

        case 0xA8: e.y = e.a; e.fZero = e.y==0; e.fNeg = e.y>127; cycles = 2; break  // TAY
        case 0xAA: e.x = e.a; e.fZero = e.x==0; e.fNeg = e.x>127; cycles = 2; break  // TAX
        case 0xB0: doBranchingOnPredicate(e.fCarry); break  // BCS
        case 0xB8: e.fOvf = false; cycles = 2; break  // CLV
        case 0xBA: e.x = e.sp; e.fZero = e.x==0; e.fNeg = e.x>127; cycles = 2; break  // TSX

        // CPY
        case 0xC0: doCMP(e.y, readPC());           cycles = 2; break
        case 0xC4: doCMP(e.y, read(readPC()));     cycles = 3; break
        case 0xCC: doCMP(e.y, read(readPCu16()));  cycles = 4; break

        // CMP
        case 0xC1: doCMP(e.a, read(addrIndX())); cycles = 6; break
        case 0xC5: doCMP(e.a, read(readPC()));    cycles = 3; break
        case 0xC9: doCMP(e.a, readPC());           cycles = 2; break
        case 0xCD: doCMP(e.a, read(readPCu16()));  cycles = 4; break
        case 0xD1: doCMP(e.a, read(addrIndY()));   cycles = 5 + pageCrossed; break
        case 0xD5: doCMP(e.a, read(addrZpX()));    cycles = 4; break
        case 0xD9: doCMP(e.a, read(addrAbsY()));   cycles = 4 + pageCrossed; break
        case 0xDD: doCMP(e.a, read(addrAbsX()));   cycles = 4 + pageCrossed; break

        // CPX
        case 0xE0: doCMP(e.x, readPC());           cycles = 2; break
        case 0xE4: doCMP(e.x, read(readPC()));     cycles = 3; break
        case 0xEC: doCMP(e.x, read(readPCu16()));  cycles = 4; break

        // DEC
        case 0xC6: temp = readPC();    { let v=(read(temp)-1)&0xFF; write(temp,v); e.fZero=v==0; e.fNeg=v>127; } cycles = 5; break
        case 0xD6: temp = addrZpX();   { let v=(read(temp)-1)&0xFF; write(temp,v); e.fZero=v==0; e.fNeg=v>127; } cycles = 6; break
        case 0xCE: temp = readPCu16(); { let v=(read(temp)-1)&0xFF; write(temp,v); e.fZero=v==0; e.fNeg=v>127; } cycles = 6; break
        case 0xDE: temp = addrAbsX();  { let v=(read(temp)-1)&0xFF; write(temp,v); e.fZero=v==0; e.fNeg=v>127; } cycles = 7; break

        // INC
        case 0xE6: temp = readPC();    { let v=(read(temp)+1)&0xFF; write(temp,v); e.fZero=v==0; e.fNeg=v>127; } cycles = 5; break
        case 0xF6: temp = addrZpX();   { let v=(read(temp)+1)&0xFF; write(temp,v); e.fZero=v==0; e.fNeg=v>127; } cycles = 6; break
        case 0xEE: temp = readPCu16(); { let v=(read(temp)+1)&0xFF; write(temp,v); e.fZero=v==0; e.fNeg=v>127; } cycles = 6; break
        case 0xFE: temp = addrAbsX();  { let v=(read(temp)+1)&0xFF; write(temp,v); e.fZero=v==0; e.fNeg=v>127; } cycles = 7; break

        case 0xC8: e.y = (e.y+1)&0xFF; e.fZero = e.y==0; e.fNeg = e.y>127; cycles = 2; break  // INY
        case 0xCA: e.x = (e.x-1)&0xFF; e.fZero = e.x==0; e.fNeg = e.x>127; cycles = 2; break  // DEX
        case 0xE8: e.x = (e.x+1)&0xFF; e.fZero = e.x==0; e.fNeg = e.x>127; cycles = 2; break  // INX

        case 0xD0: doBranchingOnPredicate(!e.fZero); break  // BNE
        case 0xD8: e.fDec = false; cycles = 2; break         // CLD

        // SBC
        case 0xE1: doSBC(read(addrIndX())); cycles = 6; break
        case 0xE5: doSBC(read(readPC()));    cycles = 3; break
        case 0xE9: case 0xEB: doSBC(readPC()); cycles = 2; break
        case 0xED: doSBC(read(readPCu16()));   cycles = 4; break
        case 0xF1: doSBC(read(addrIndY()));    cycles = 5 + pageCrossed; break
        case 0xF5: doSBC(read(addrZpX()));     cycles = 4; break
        case 0xF9: doSBC(read(addrAbsY()));    cycles = 4 + pageCrossed; break
        case 0xFD: doSBC(read(addrAbsX()));    cycles = 4 + pageCrossed; break

        // 3-byte NOP (unofficial)
        case 0x0C: case 0x1C: case 0x3C: case 0x5C: case 0x7C: case 0xDC: case 0xFC: {
            let base = readPCu16()
            let addr = (base + e.x) & 0xFFFF
            pageCrossed = opcode != 0x0C && (base & 0xFF00) != (addr & 0xFF00)
            cycles = 4 + pageCrossed
            break
        }

        // 2-byte NOP (unofficial)
        case 0x04: case 0x14: case 0x34: case 0x44: case 0x54: case 0x80:
        case 0x89: case 0x82: case 0xD4: case 0xC2: case 0xF4: case 0xE2:
            readPC()
            cycles = 2 + ((opcode & 0x1F) == 0x04 ? 1 : ((opcode & 0x1F) == 0x14 ? 2 : 0))
            break

        // 1-byte NOP (unofficial)
        case 0x1A: case 0x3A: case 0x5A: case 0x7A: case 0xDA: case 0xEA: case 0xFA:
            cycles = 2
            break

        case 0xF0: doBranchingOnPredicate(e.fZero); break  // BEQ
        case 0xF8: e.fDec = true; cycles = 2; break         // SED

        // XAA / ANE (unofficial, thermally unstable)
        case 0x8B: {
            let magic = 0xEE
            if (((Math.random()*128)|0) < 1) magic |= 0x10
            if (((Math.random()*128)|0) < 1) magic |= 0x01
            let r = (e.a | magic) & e.x & readPC()
            e.a = r
            e.fZero = r == 0; e.fNeg = r > 127
            if (((Math.random()*64)|0) < 1) e.fZero = !e.fZero
            if (((Math.random()*64)|0) < 1) e.fNeg  = !e.fNeg
            cycles = 2
            break
        }

        // HLT / KIL / JAM (unofficial, freezes CPU)
        case 0x02: case 0x12: case 0x22: case 0x32: case 0x42: case 0x52:
        case 0x62: case 0x72: case 0x92: case 0xB2: case 0xD2: case 0xF2:
            e.halted = true
            break

        default:
            serial.println(`Illegal opcode ${opcode.toString(16)} at PC ${((e.pc - 1) & 0xFFFF).toString(16)}`)
            e.halted = true
            break
    }

    // ── Item 3: accumulate PPU budget instead of calling emulatePPU inline ──
    e.ppuCycleBudget += cycles * 3
    e.totalCycles    += cycles
}

///////////////////////////////////////////////////////////////////////////////
// ── Item 1: readPPU uses typed arrays ──
function readPPU(vramAddr) {
    if (vramAddr < 0x2000) {
        return e.chrArr[vramAddr]
    } else if (vramAddr < 0x3F00) {
        // Nametable read (with H/V mirroring)
        if ((e.inesHdr[6] & 1) == 0) {
            // horizontal mirroring
            return e.vramArr[(vramAddr & 0x3FF) | ((vramAddr & 0x800) >>> 1)]
        } else {
            // vertical mirroring
            return e.vramArr[vramAddr & 0x7FF]
        }
    } else {
        // Palette RAM
        if ((vramAddr & 3) == 0) return e.palArr[vramAddr & 0x0F]
        else                     return e.palArr[vramAddr & 0x1F]
    }
}

function findCHRaddrForSprite(slot, ppuScanline) {
    if (!e.ppuUse8x16Sprites) {
        let row = ppuScanline - e.ppuSpritePosY[slot]
        let flipped = ((e.ppuSpriteAtr[slot] >>> 7) & 1) != 0
        if (flipped) row = 7 - row
        return (e.ppuSpritePatternTable ? 0x1000 : 0) | (e.ppuSpritePtn[slot] << 4) | row
    } else {
        let row = ppuScanline - e.ppuSpritePosY[slot]
        let flipped = ((e.ppuSpriteAtr[slot] >>> 7) & 1) != 0
        let ptnBase = ((e.ppuSpritePtn[slot] & 1) ? 0x1000 : 0) | ((e.ppuSpritePtn[slot] & 0xFE) << 4)
        if (!flipped) {
            if (row < 8) return ptnBase + row
            else         return ptnBase + 16 + (row & 7)
        } else {
            if (row < 8) return ptnBase + 16 + (7 - row)
            else         return ptnBase + (7 - (row & 7))
        }
    }
}

///////////////////////////////////////////////////////////////////////////////
// ── Item 3: per-scanline renderer replacing per-dot emulatePPU ──

// Pre-allocated per-scanline BG tile scratch (avoids GC)
const bgTileLo   = new Uint8Array(34)
const bgTileHi   = new Uint8Array(34)
const bgTileAttr = new Uint8Array(34)

// ── Item 3: evaluate sprites for one scanline (called once per visible line) ──
function evalSpritesForScanline(sl) {
    const oamArr = e.oamArr
    const sprH   = e.ppuUse8x16Sprites ? 16 : 8
    const shL = e.ppuSpriteShiftRegL
    const shH = e.ppuSpriteShiftRegH
    const atr = e.ppuSpriteAtr
    const px  = e.ppuSpritePosX
    const py  = e.ppuSpritePosY

    let slot = 0
    e.ppuScanlineContainsSprZero = false
    // Note: e.ppuStatusOverflow is a frame-level flag; cleared at sl 261, not here

    for (let i = 0; i < 64; i++) {
        let y   = oamArr[i * 4]
        let row = sl - y
        if (row < 0 || row >= sprH) continue

        if (i == 0) e.ppuScanlineContainsSprZero = true

        if (slot >= 8) {
            e.ppuStatusOverflow = true
            continue
        }

        let ptn   = oamArr[i * 4 + 1]
        let attrs = oamArr[i * 4 + 2]
        let posX  = oamArr[i * 4 + 3]

        atr[slot]           = attrs
        px[slot]            = posX
        py[slot]            = y
        e.ppuSpritePtn[slot] = ptn

        let chrAddr = findCHRaddrForSprite(slot, sl)
        let lo = readPPU(chrAddr)
        let hi = readPPU(chrAddr + 8)

        // ── Item 7: bit-reverse LUT for horizontal flip ──
        if ((attrs & 0x40) != 0) { lo = bitRev8[lo]; hi = bitRev8[hi] }

        shL[slot] = lo
        shH[slot] = hi
        slot++
    }

    // Clear unused sprite slots
    for (let i = slot; i < 8; i++) {
        shL[i] = 0; shH[i] = 0; px[i] = 0xFF
    }
    e.ppuSecondaryOAMsize = slot * 4
    return slot
}

// ── Item 3: render one complete scanline ──
function renderScanline(sl) {
    const renderBG  = e.ppuMaskRenderBG
    const renderSpr = e.ppuMaskRenderSprites
    const maskBG8   = e.ppuMask8pxMaskBG
    const maskSp8   = e.ppuMask8pxMaskSprites
    const fineX     = e.ppuScrollFineX
    const palArr    = e.palArr
    const fbArr     = e.fbArr
    // ── Item 8: frameskip — still compute sprite-0 hit but skip pixel writes ──
    const skip      = e.skipRender
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
            let tileId = readPPU(0x2000 | (va & 0x0FFF))

            let atAddr = 0x23C0 | (va & 0x0C00) | ((va >>> 4) & 0x38) | ((va >>> 2) & 0x07)
            let attr   = readPPU(atAddr)
            if (va & 2)           attr >>>= 2  // right half of attr cell
            if ((va >>> 5) & 2)   attr >>>= 4  // bottom half of attr cell
            attr &= 3

            let fineY    = (va >>> 12) & 7
            let ptnBase  = (highPT ? 0x1000 : 0) | (tileId << 4) | fineY
            bgTileLo[tile]   = readPPU(ptnBase)
            bgTileHi[tile]   = readPPU(ptnBase + 8)
            bgTileAttr[tile] = attr

            // Advance coarse X
            if ((va & 0x1F) == 31) va = (va & ~0x1F) ^ 0x0400
            else                   va++
        }
    }

    // Pixel loop
    for (let dot = 0; dot < 256; dot++) {
        // BG pixel
        let palLo = 0, palHi = 0
        if (renderBG && (dot >= 8 || !maskBG8)) {
            let eff = dot + fineX
            let t   = eff >>> 3
            let b   = 7 - (eff & 7)
            let lo  = (bgTileLo[t]   >>> b) & 1
            let hi  = (bgTileHi[t]   >>> b) & 1
            palLo   = (hi << 1) | lo
            palHi   = palLo != 0 ? bgTileAttr[t] : 0
        }

        // Sprite pixel
        let spritePalLo = 0, spritePalHi = 0, spritePriority = false
        if (renderSpr && (dot >= 8 || !maskSp8)) {
            for (let i = 0; i < sprSlots; i++) {
                let sdot = dot - sPx[i]
                if (sdot < 0 || sdot >= 8) continue
                let b    = 7 - sdot
                let sLo  = (shL[i] >>> b) & 1
                let sHi  = (shH[i] >>> b) & 1
                let sPL  = (sHi << 1) | sLo
                if (sPL == 0) continue  // transparent pixel

                // Sprite-0 hit detection
                if (i == 0 && sprZeroThisSl && palLo != 0 && dot < 255) {
                    e.ppuStatusSprZeroHit = true
                }

                spritePalLo  = sPL
                spritePalHi  = (sAtr[i] & 3) | 4  // sprite palettes are indices 4-7
                spritePriority = (sAtr[i] & 0x20) == 0  // priority bit: 0 = in front
                break
            }
        }

        // BG vs sprite mux
        let finalLo = palLo, finalHi = palHi
        if ((spritePriority && spritePalLo != 0) || palLo == 0) {
            finalLo = spritePalLo
            finalHi = spritePalHi
            if (finalLo == 0) finalHi = 0
        }

        if (!skip) fbArr[fbBase + dot] = palArr[finalHi * 4 + finalLo]
    }
}

// ── Item 3: PPU budget driver (replaces per-dot emulatePPU) ──
function stepPPU() {
    let budget = e.ppuCycleBudget
    if (budget <= 0) return
    e.ppuCycleBudget = 0

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
                e.ppuVblank    = true
                e.drawNewFrame = true
            }
            // Pre-render line: clear status flags + reset Y scroll
            if (sl == 261) {
                e.ppuVblank            = false
                e.ppuStatusOverflow    = false
                e.ppuStatusSprZeroHit  = false
                if (renderOn) ppuResetScrollY(e.vramAddr)
            }
            // Visible scanlines: render then update scrolling
            if (sl < 240) {
                if (renderOn) renderScanline(sl)
                if (renderOn) {
                    ppuIncrementScrollY(e.vramAddr)
                    ppuResetScrollX(e.vramAddr)
                }
            }

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
                e.ppuVblank = true
            }
            if (sl == 261 && dot < 1 && newDot >= 1) {
                e.ppuVblank           = false
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
                    let lo = e.chrArr[0 + y + col*16 + row*256 + table*4096]
                    let hi = e.chrArr[8 + y + col*16 + row*256 + table*4096]
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
            let attr    = e.vramArr[0x3C0 + attrOffset]
            let quadrant = (((col >>> 1) & 1) + ((row >>> 1) & 1) * 2) & 255
            let pair    = (attr >>> (quadrant * 2)) & 3
            let tileId  = e.vramArr[col + row * 32]
            let ptBase  = e.ppuBGPatternTable ? 0x1000 : 0

            for (let y = 0; y < 8; y++) {
                let lo = e.chrArr[ptBase + tileId * 16 + y]
                let hi = e.chrArr[ptBase + tileId * 16 + y + 8]
                for (let x = 0; x < 8; x++) {
                    let px  = (((lo >>> (7-x)) & 1)) | (((hi >>> (7-x)) & 1) << 1)
                    let col2 = (px == 0) ? e.palArr[0] : e.palArr[px + pair * 4]
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

function uploadNESmasterPal() {
    let twoc02 = [0x666F,0x019F,0x10AF,0x409F,0x606F,0x602F,0x600F,0x410F,0x230F,0x040F,0x040F,0x041F,0x035F,0x000F,0x000F,0x000F,0xAAAF,0x04DF,0x32FF,0x71FF,0x90BF,0xB16F,0xA20F,0x840F,0x560F,0x270F,0x080F,0x083F,0x069F,0x000F,0x000F,0x000F,0xFFFF,0x5AFF,0x88FF,0xB6FF,0xD6FF,0xF6CF,0xF76F,0xD92F,0xBA0F,0x8C0F,0x5D2F,0x3D6F,0x3CCF,0x444F,0x000F,0x000F,0xFFFF,0xBEFF,0xCDFF,0xECFF,0xFCFF,0xFCEF,0xFCCF,0xFDAF,0xED9F,0xDE9F,0xCEAF,0xBECF,0xBEEF,0xBBBF,0x000F,0x000F]
    for (let i = 0; i < 64; i++) {
        let rg   = (twoc02[i] >>> 8) & 0xFF
        let ba   = twoc02[i] & 0xFF
        let addr = -(1310209 + 2*i)
        sys.poke(addr, rg); sys.poke(addr - 1, ba)
    }
}

///////////////////////////////////////////////////////////////////////////////

graphics.setGraphicsMode(1)
uploadNESmasterPal()
con.curs_set(0)
graphics.clearText()
graphics.setCursorYX(19, 1)

reset()

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
while (!appexit && !e.halted) {
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
    e.skipRender = config.frameskip > 1 && (frameCounter % config.frameskip) != 0

    run()

    if (!e.skipRender) {
        render()
        if (traceFile) traceFile.flush()
    }
}

if (traceFile) traceFile.flush()

con.curs_set(1)
graphics.clearText()
graphics.setCursorYX(1, 1)
graphics.resetPalette()

e.free()
