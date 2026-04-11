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

// CPU status
const e = {}
// memory space and pointers
e.mem = sys.calloc(0x10000)
e.ram = e.mem + 0
e.rom = e.mem + 0x8000
// iNES header goes here
e.inesHdr = new Uint8Array(16)
// 6502 registers
e.pc = (0x0) >>> 0
e.sp = (0x0) >>> 0
e.a = 0|0
e.x = 0|0
e.y = 0|0
// 6502 flags
e.halted = false // Break command
e.fCarry = false // Carry flag
e.fZero = false // Zero flag
e.fIntdis = false // Interrupt disable
e.fDec = false // Decimal mode. Does absolutely nothing on NES
e.fOvf = false // Overflow flag
e.fNeg = false // negative flag
e.nmiLevel = false
e.doNMI = false
e.nmiFired = 0
// PPU stuffs
e.chr = e.mem + 0x2000
e.vram = e.chr + 0x2000
e.pal = e.chr + 0x3F00
e.oam = sys.calloc(0x100)
e.secondaryOAM = sys.calloc(0x20)
e.fb = sys.calloc(256 * 240) // only 224 scanlines are visible but 240 lines should be rendered
e.writeLatch = false
e.transferAddr = (0x0) >>> 0
e.vramAddr = (0x0) >>> 0
e._tempVramAddr = (0x0) >>> 0
e.ppuVramInc32Mode = false
e.ppuReadBuffer = 0|0
e.ppuDot = 0|0 // scanning beam X pos
e.ppuScanline = 0|0 // scanning beam Y pos
e.ppuVblank = false
e.ppuMask8pxMaskBG = false
e.ppuMask8pxMaskSprites = false
e.ppuMaskRenderBG = false
e.ppuMaskRenderSprites = false
e.ppuNametableSelect = 0|0
e.ppuSpritePatternTable = false
e.ppuBGPatternTable = false
e.ppuUse8x16Sprites = false
e.ppuEnableNMI = false
e.ppuStatusOverflow = false
e.ppuStatusSprZeroHit = false
e.ppuShiftRegPtnL = (0x0) >>> 0
e.ppuShiftRegPtnH = (0x0) >>> 0
e.ppuShiftRegAtrL = (0x0) >>> 0
e.ppuShiftRegAtrH = (0x0) >>> 0
e.ppu8stepPtnLoBitplane = 0|0
e.ppu8stepPtnHiBitplane = 0|0
e.ppu8stepAttr = 0|0
e.ppuAddrBus = (0x0) >>> 0
e.ppu8stepTemp = 0|0
e.ppu8stepNextChar = 0|0
e.ppuScrollFineX = 0|0
e.ppuSpriteEvalTemp = 0|0
e.ppuOAMaddr = 0|0
e.ppuSecondaryOAMaddr = 0|0
e.ppuSecondaryOAMfull = false
e.ppuSpriteEvalTick = 0|0
e.ppuScanlineContainsSprZero = false
e.ppuSpriteEvalOAMovf = false
e.ppuSecondaryOAMsize = 0|0
e.ppuSpriteShiftRegL = new Uint8Array(8)
e.ppuSpriteShiftRegH = new Uint8Array(8)
e.ppuSpriteAtr = new Uint8Array(8)
e.ppuSpritePtn = new Uint8Array(8)
e.ppuSpritePosX = new Uint8Array(8)
e.ppuSpritePosY = new Uint8Array(8)
// controller stuffs
e.currentButtonStatus = 0|0
e.cnt1sr = 0|0
e.cnt2sr = 0|0
// emulation stuffs
e.drawNewFrame = false


// helper functions

e.plotFB = (x, y, value) => {
    sys.poke(e.fb + y*256 + x, value)
}

// change PC by offset with wrapping
e.movPC = (offset) => {
    e.pc = e.pc + offset
    while (e.pc > 65535) {
        e.pc -= 65536
    }
    while (e.pc < 0) {
        e.pc += 65536
    }
}
// increment PC by 1 with wrapping
e.incPC = () => { let pc = e.pc; e.pc = (pc + 1) % 65536 }
// decrement PC by 1 with wrapping
e.decPC = () => { let pc = e.pc; e.pc = (pc == 0) ? 65535 : pc - 1 }
// read a byte from index PC then increment PC atomically
e.readPC = () => {
    let pc = e.pc // capture the value
    const v = read(pc)
    e.pc = (pc + 1) % 65536
    return v
}
// read a signed byte from index PC then increment PC atomically
e.readPCs = () => {
    let pc = e.pc // capture the value
    const v = readSigned(pc)
    e.pc = (pc + 1) % 65536
    return v
}
// read an ushort from index PC then increment PC twice atomically
e.readPCu16 = () => {
    let pc = e.pc // capture the value
    const lo = read(pc)
    const hi = read(pc+1)
    e.pc = (pc + 2) % 65536
    return (hi << 8) | lo
}

// set 6502 flags by computation results
e.setResultFlags = (val) => {
    e.fZero = (val == 0)
    e.fNeg = (val > 127)
}

// push current PC into stack
e.pushPC = () => {
    let pc = e.pc // capture the value
    push((pc >>> 8) & 255)
    push(pc & 255)
}

e.free = () => {
    sys.free(e.mem)
    sys.free(e.oam)
    sys.free(e.secondaryOAM)
    sys.free(e.fb)
}

///////////////////////////////////////////////////////////////////////////////

const fullFilePath = _G.shell.resolvePathInput(exec_args[1])
if (fullFilePath === undefined) {
    println(`Usage: ${exec_args[0]} path_to_rom.nes`)
    return 1
}

function read(offset) { // always returns Uint
    // TODO memmap and mirroring

    // reading from PPU
    if (0x2000 <= offset && offset < 0x4000) {
        offset &= 0x2007
        switch (offset) {
            case 0x2002: // PPUSTATUS
                let ppuStatus = 0|0
                ppuStatus |= (e.ppuVblank) ? 0x80 : 0
                ppuStatus |= (e.ppuStatusSprZeroHit) ? 0x40 : 0
                ppuStatus |= (e.ppuStatusOverflow) ? 0x20 : 0
                e.ppuVblank = false
                e.writeLatch = false
                return ppuStatus
            case 0x2007: // PPUDATA
                let temp = e.ppuReadBuffer
                let vramAddr = e.vramAddr // latch

                // read from the pattern table
                if (vramAddr > 0x3F00) {
                    temp = readPPU(vramAddr)
                }
                else {
                    e.ppuReadBuffer = readPPU(vramAddr)
                }
                // auto-increment
                e.vramAddr = (vramAddr + ((e.ppuVramInc32Mode) ? 32 : 1)) & 0x3FFF
                return temp
            default:
                return 0
        }
    }
    // reading from Controller 1
    if (offset == 0x4016) {
        let controllerBit = (e.cnt1sr & 0x80) >> 7
        e.cnt1sr <<= 1
        return controllerBit
    }
    // reading from Controller 2
    else if (offset == 0x4017) {
        let controllerBit = (e.cnt2sr & 0x80) >> 7
        e.cnt2sr <<= 1
        return controllerBit
    }
    return sys.peek(e.mem + offset)
}

function readSigned(offset) {
    let t = read(offset)
    return (t > 127) ? t - 256 : t
}

function write(offset0, value) {
    var offset = offset0; while (offset < 0) offset += 65536; // Q&D negative addr wrapping
    // TODO memmap and mirroring

    // write to PPU
    if (0x2000 <= offset && offset < 0x4000) {
        offset &= 0x2007
        switch (offset) {
            case 0x2000: // PPUCTRL
                e.ppuNametableSelect = value & 3
                e.ppuVramInc32Mode = (value & 4) != 0
                e.ppuSpritePatternTable = (value & 8) != 0
                e.ppuBGPatternTable = (value & 16) != 0
                e.ppuUse8x16Sprites = (value & 32) != 0
                e.ppuEnableNMI = (value & 128) != 0
                break
            case 0x2001: // PPUMASK
                e.ppuMask8pxMaskBG = (value & 2) != 0
                e.ppuMask8pxMaskSprites = (value & 4) != 0
                e.ppuMaskRenderBG = (value & 8) != 0
                e.ppuMaskRenderSprites = (value & 16) != 0
                break
            case 0x2002: // PPUSTATUS
                break
            case 0x2003: // OAMADDR
                break
            case 0x2004: // OAMDATA
                break
            case 0x2005: // PPUSCROLL
                if (!e.writeLatch) {
                    e.ppuScrollFineX = value & 7
                    e._tempVramAddr = (e._tempVramAddr & 0b0111111111100000) | (value >>> 3)
                    e.writeLatch = true
                }
                else {
                    e.transferAddr = (e._tempVramAddr & 0b0000110000011111) | (((value & 0xF8) << 2) | ((value & 7) << 12))
                    e.writeLatch = false
                }
                break
            case 0x2006: // PPUADDR
                // writing high byte?
                if (!e.writeLatch) {
                    e._tempVramAddr = (value & 0x3F) << 8
                    e.writeLatch = true
                }
                // writing low byte?
                else {
                    let w = e._tempVramAddr | value
                    e.vramAddr = w
                    e.transferAddr = w
                    e.writeLatch = false
                }
                break
            case 0x2007: // PPUDATA
                let vramAddr = e.vramAddr // latch
                // to pattern table
                if (vramAddr < 0x2000) {
                    // write to pattern table, if cartridge has CHR RAM instead of ROM
                    if (e.inesHdr[5] == 0) {
                        sys.poke(e.chr + vramAddr, value)
                    }
                }
                // to nametable
                else if (vramAddr < 0x3F00) {
                    // horizontal mirroring
                    if ((e.inesHdr[6] & 1) == 0) {
                        sys.poke(e.vram + ((vramAddr & 0x3FF) | (vramAddr & 0x800) >>> 1), value)
                    }
                    // vertical mirroring
                    else {
                        sys.poke(e.vram + (vramAddr & 0x7FF), value)
                    }
                }
                // to palette RAM
                else {
                    if ((vramAddr & 3) == 0) {
                        sys.poke(e.pal + (vramAddr & 0x0F), value)
                    }
                    else {
                        sys.poke(e.pal + (vramAddr & 0x1F), value)
                    }
                }
                // auto-increment
                e.vramAddr = (vramAddr + ((e.ppuVramInc32Mode) ? 32 : 1)) & 0x3FFF
                break
        }
    }
    // write to RAM with mirroring
    else if (offset < 0x2000) {
        sys.poke(e.mem + (offset & 0x7FF), value)
    }
    // APU / IO registers
    else if (offset < 0x4020) {
        // TODO: $4014 OAM DMA, $4016 controller strobe, APU channels
        // for now, just swallow the write so it doesn't corrupt zero page
        switch (offset) {
            case 0x4014: // OAM DMA
                for (let i = 0; i < 256; i++) {
                    sys.poke(e.oam + i, read((value << 8) + i))
                }
                break
            case 0x4016: // Controller strobe
                e.cnt1sr = e.currentButtonStatus
                e.cnt2sr = 0
                break
        }
    }
    // cartridge space ($4020-$7FFF): SRAM / expansion, unused on mapper 0
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

function reset() {
    let romFile = files.open(fullFilePath.full)
    let romFileSize = romFile.size
    let headeredRom = sys.calloc(romFileSize)
    romFile.pread(headeredRom, romFileSize, 0)

    // copy ROM
    sys.memcpy(headeredRom + 0x10, e.rom, 0x8000)
    // copy CHR
    sys.memcpy(headeredRom + 0x8010, e.chr, 0x2000)
    // copy iNES header
    for (let i = 0; i < 16; i++) {
        e.inesHdr[i] = sys.peek(headeredRom + i)
    }
    sys.free(headeredRom)

    // run RESET vector
    e.fIntdis = true
    let PCL = read(0xFFFC)
    let PCH = read(0xFFFD)
    e.pc = (PCH << 8) | PCL
    e.sp = 0xFD
}

const opcodeNames = [
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
'BNE','CMP','HLT','DCP','NOP','CMP','DEC','DPC','CLD','CMP','NOP','DCP','NOP','CMP','DEC','DCP',
'CPX','SBC','NOP','ISC','CPX','SBC','INC','ISC','INX','SBC','NOP','SBC','CPX','SBC','INC','ISC',
'BEQ','SBC','HLT','ISC','NOP','SBC','INC','ISC','SED','SBC','NOP','ISC','NOP','SBC','INC','ISC','NMI'
]

let traceLogCnt = 0
function printTracelog(opcode) {
    let pc = e.pc // latch
    if (!e.doNMI) { pc-- }
    if (pc < 0) pc += 65536
    if (e.doNMI) { opcode = 0x100 }
    let sp = e.sp
    let a = e.a
    let x = e.x
    let y = e.y
    let flags = (e.fNeg ? 'N' : 'n') + (e.fOvf ? 'V' : 'v') + '--' + (e.fDec ? 'D' : 'd') +
            (e.fIntdis ? 'I' : 'i') + (e.fZero ? 'Z' : 'z') + (e.fCarry ? 'C' : 'c')
    let s = `${traceLogCnt.toString().padStart(8,' ')} ; PC = $${pc.toString(16).padStart(4,'0')}    ` +
            `Op = ${opcode.toString(16).padStart(2,'0')} (${opcodeNames[opcode]})    ` +
            `A: ${a.toString(16).padStart(2,'0')} , ` +
            `X: ${x.toString(16).padStart(2,'0')} , ` +
            `Y: ${y.toString(16).padStart(2,'0')} , ` +
            `SP: ${sp.toString(16).padStart(2,'0')}    ` +
            `Flags: ${flags}`

    serial.println(s)

    traceLogCnt++
}

function run() {
    while (!e.halted) {
        emulateCPU()
        if (e.drawNewFrame) {
            e.drawNewFrame = false
            break
        }
    }

    if (e.halted) serial.println("CPU Halted");
}

let cycles = 0
let opcode = 0
let temp = 0
let pageCrossed = false

function doBranchingOnPredicate(p) {
    let sv = e.readPCs()
    let oldPCh = e.pc >>> 8
    if (p) {
        e.movPC(sv)
        let newPCh = e.pc >>> 8
        cycles = 3 + (oldPCh != newPCh) // add 1 if page crossed
    }
    else {
        cycles = 2
    }
}

// Zero page 16-bit read with wrapping
function readZpU16(addr) {
    let lo = read(addr & 0xFF)
    let hi = read((addr + 1) & 0xFF)
    return (hi << 8) | lo
}

// 16-bit read with page boundary bug (for JMP indirect)
function readU16Wrap(addr) {
    let lo = read(addr)
    let hi = read((addr & 0xFF00) | ((addr + 1) & 0xFF))
    return (hi << 8) | lo
}

// Addressing modes
function addrZpX() { return (e.readPC() + e.x) & 0xFF }
function addrZpY() { return (e.readPC() + e.y) & 0xFF }
function addrAbsX() {
    let base = e.readPCu16()
    let addr = (base + e.x) & 0xFFFF
    pageCrossed = (base & 0xFF00) != (addr & 0xFF00)
    return addr
}
function addrAbsY() {
    let base = e.readPCu16()
    let addr = (base + e.y) & 0xFFFF
    pageCrossed = (base & 0xFF00) != (addr & 0xFF00)
    return addr
}
function addrIndX() {
    return readZpU16((e.readPC() + e.x) & 0xFF)
}
function addrIndY() {
    let base = readZpU16(e.readPC())
    let addr = (base + e.y) & 0xFFFF
    pageCrossed = (base & 0xFF00) != (addr & 0xFF00)
    return addr
}

// ALU helpers
function doADC(val) {
    let sum = e.a + val + (e.fCarry ? 1 : 0)
    e.fOvf = ((~(e.a ^ val)) & (e.a ^ sum) & 0x80) != 0
    e.fCarry = sum > 255
    e.a = sum & 0xFF
    e.setResultFlags(e.a)
}

function doSBC(val) {
    doADC(val ^ 0xFF)
}

function doCMP(reg, val) {
    let diff = reg - val
    e.fCarry = reg >= val
    e.fZero = (diff & 0xFF) == 0
    e.fNeg = (diff & 0x80) != 0
}

function doASL(val) {
    e.fCarry = (val & 0x80) != 0
    let result = (val << 1) & 0xFF
    e.setResultFlags(result)
    return result
}

function doLSR(val) {
    e.fCarry = (val & 0x01) != 0
    let result = val >>> 1
    e.setResultFlags(result)
    return result
}

function doROL(val) {
    let oldCarry = e.fCarry ? 1 : 0
    e.fCarry = (val & 0x80) != 0
    let result = ((val << 1) | oldCarry) & 0xFF
    e.setResultFlags(result)
    return result
}

function doROR(val) {
    let oldCarry = e.fCarry ? 128 : 0
    e.fCarry = (val & 0x01) != 0
    let result = (val >>> 1) | oldCarry
    e.setResultFlags(result)
    return result
}

function packFlags(bFlag) {
    return (e.fNeg ? 0x80 : 0) |
           (e.fOvf ? 0x40 : 0) |
           0x20 |
           (bFlag ? 0x10 : 0) |
           (e.fDec ? 0x08 : 0) |
           (e.fIntdis ? 0x04 : 0) |
           (e.fZero ? 0x02 : 0) |
           (e.fCarry ? 0x01 : 0)
}

function unpackFlags(val) {
    e.fNeg = (val & 0x80) != 0
    e.fOvf = (val & 0x40) != 0
    e.fDec = (val & 0x08) != 0
    e.fIntdis = (val & 0x04) != 0
    e.fZero = (val & 0x02) != 0
    e.fCarry = (val & 0x01) != 0
}

function emulateCPU() {
    let prevNMIlevel = e.nmiLevel
    e.nmiLevel = e.ppuEnableNMI && e.ppuVblank
    if (!prevNMIlevel && e.nmiLevel) {
        e.doNMI = true
    }

    if (!e.doNMI) {
        opcode = e.readPC()
    }
    else {
        opcode = 0x00
    }

    if (config.printTracelog) printTracelog(opcode);

    switch(opcode) {

        // BRK
        case 0x00:
            if (!e.doNMI) {
                e.incPC() // skip padding byte
            }
            e.pushPC()
            push(packFlags(true))
            e.pc = (e.doNMI) ? (read(0xFFFA) | (read(0xFFFB) << 8)) : (read(0xFFFE) | (read(0xFFFF) << 8))
            e.doNMI = false
            e.nmiFired++
            cycles = 7
            break

        // ORA
        case 0x01: // ORA (ind,X)
            e.a = e.a | read(addrIndX())
            e.setResultFlags(e.a)
            cycles = 6
            break
        case 0x05: // ORA zp
            e.a = e.a | read(e.readPC())
            e.setResultFlags(e.a)
            cycles = 3
            break
        case 0x09: // ORA imm
            e.a = e.a | e.readPC()
            e.setResultFlags(e.a)
            cycles = 2
            break
        case 0x0D: // ORA abs
            e.a = e.a | read(e.readPCu16())
            e.setResultFlags(e.a)
            cycles = 4
            break
        case 0x11: // ORA (ind),Y
            e.a = e.a | read(addrIndY())
            e.setResultFlags(e.a)
            cycles = 5 + pageCrossed
            break
        case 0x15: // ORA zp,X
            e.a = e.a | read(addrZpX())
            e.setResultFlags(e.a)
            cycles = 4
            break
        case 0x19: // ORA abs,Y
            e.a = e.a | read(addrAbsY())
            e.setResultFlags(e.a)
            cycles = 4 + pageCrossed
            break
        case 0x1D: // ORA abs,X
            e.a = e.a | read(addrAbsX())
            e.setResultFlags(e.a)
            cycles = 4 + pageCrossed
            break

        // ASL
        case 0x0A: // ASL A
            e.a = doASL(e.a)
            cycles = 2
            break
        case 0x06: // ASL zp
            temp = e.readPC()
            write(temp, doASL(read(temp)))
            cycles = 5
            break
        case 0x16: // ASL zp,X
            temp = addrZpX()
            write(temp, doASL(read(temp)))
            cycles = 6
            break
        case 0x0E: // ASL abs
            temp = e.readPCu16()
            write(temp, doASL(read(temp)))
            cycles = 6
            break
        case 0x1E: // ASL abs,X
            temp = addrAbsX()
            write(temp, doASL(read(temp)))
            cycles = 7
            break

        // PHP
        case 0x08:
            push(packFlags(true))
            cycles = 3
            break

        // BPL
        case 0x10:
            doBranchingOnPredicate(!e.fNeg)
            break

        // CLC
        case 0x18:
            e.fCarry = false
            cycles = 2
            break

        // JSR
        case 0x20:
            temp = e.readPCu16(); e.decPC()
            e.pushPC()
            e.pc = temp
            cycles = 6
            break

        // AND
        case 0x21: // AND (ind,X)
            e.a = e.a & read(addrIndX())
            e.setResultFlags(e.a)
            cycles = 6
            break
        case 0x25: // AND zp
            e.a = e.a & read(e.readPC())
            e.setResultFlags(e.a)
            cycles = 3
            break
        case 0x29: // AND imm
            e.a = e.a & e.readPC()
            e.setResultFlags(e.a)
            cycles = 2
            break
        case 0x2D: // AND abs
            e.a = e.a & read(e.readPCu16())
            e.setResultFlags(e.a)
            cycles = 4
            break
        case 0x31: // AND (ind),Y
            e.a = e.a & read(addrIndY())
            e.setResultFlags(e.a)
            cycles = 5 + pageCrossed
            break
        case 0x35: // AND zp,X
            e.a = e.a & read(addrZpX())
            e.setResultFlags(e.a)
            cycles = 4
            break
        case 0x39: // AND abs,Y
            e.a = e.a & read(addrAbsY())
            e.setResultFlags(e.a)
            cycles = 4 + pageCrossed
            break
        case 0x3D: // AND abs,X
            e.a = e.a & read(addrAbsX())
            e.setResultFlags(e.a)
            cycles = 4 + pageCrossed
            break

        // BIT
        case 0x24: // BIT zp
            temp = read(e.readPC())
            e.fZero = (e.a & temp) == 0
            e.fOvf = (temp & 0x40) != 0
            e.fNeg = (temp & 0x80) != 0
            cycles = 3
            break
        case 0x2C: // BIT abs
            temp = read(e.readPCu16())
            e.fZero = (e.a & temp) == 0
            e.fOvf = (temp & 0x40) != 0
            e.fNeg = (temp & 0x80) != 0
            cycles = 4
            break

        // ROL
        case 0x2A: // ROL A
            e.a = doROL(e.a)
            cycles = 2
            break
        case 0x26: // ROL zp
            temp = e.readPC()
            write(temp, doROL(read(temp)))
            cycles = 5
            break
        case 0x36: // ROL zp,X
            temp = addrZpX()
            write(temp, doROL(read(temp)))
            cycles = 6
            break
        case 0x2E: // ROL abs
            temp = e.readPCu16()
            write(temp, doROL(read(temp)))
            cycles = 6
            break
        case 0x3E: // ROL abs,X
            temp = addrAbsX()
            write(temp, doROL(read(temp)))
            cycles = 7
            break

        // PLP
        case 0x28:
            unpackFlags(pull())
            cycles = 4
            break

        // BMI
        case 0x30:
            doBranchingOnPredicate(e.fNeg)
            break

        // SEC
        case 0x38:
            e.fCarry = true
            cycles = 2
            break

        // RTI
        case 0x40:
            unpackFlags(pull())
            e.pc = pullu16()
            cycles = 6
            break

        // EOR
        case 0x41: // EOR (ind,X)
            e.a = e.a ^ read(addrIndX())
            e.setResultFlags(e.a)
            cycles = 6
            break
        case 0x45: // EOR zp
            e.a = e.a ^ read(e.readPC())
            e.setResultFlags(e.a)
            cycles = 3
            break
        case 0x49: // EOR imm
            e.a = e.a ^ e.readPC()
            e.setResultFlags(e.a)
            cycles = 2
            break
        case 0x4D: // EOR abs
            e.a = e.a ^ read(e.readPCu16())
            e.setResultFlags(e.a)
            cycles = 4
            break
        case 0x51: // EOR (ind),Y
            e.a = e.a ^ read(addrIndY())
            e.setResultFlags(e.a)
            cycles = 5 + pageCrossed
            break
        case 0x55: // EOR zp,X
            e.a = e.a ^ read(addrZpX())
            e.setResultFlags(e.a)
            cycles = 4
            break
        case 0x59: // EOR abs,Y
            e.a = e.a ^ read(addrAbsY())
            e.setResultFlags(e.a)
            cycles = 4 + pageCrossed
            break
        case 0x5D: // EOR abs,X
            e.a = e.a ^ read(addrAbsX())
            e.setResultFlags(e.a)
            cycles = 4 + pageCrossed
            break

        // LSR
        case 0x4A: // LSR A
            e.a = doLSR(e.a)
            cycles = 2
            break
        case 0x46: // LSR zp
            temp = e.readPC()
            write(temp, doLSR(read(temp)))
            cycles = 5
            break
        case 0x56: // LSR zp,X
            temp = addrZpX()
            write(temp, doLSR(read(temp)))
            cycles = 6
            break
        case 0x4E: // LSR abs
            temp = e.readPCu16()
            write(temp, doLSR(read(temp)))
            cycles = 6
            break
        case 0x5E: // LSR abs,X
            temp = addrAbsX()
            write(temp, doLSR(read(temp)))
            cycles = 7
            break

        // PHA
        case 0x48:
            push(e.a)
            cycles = 3
            break

        // JMP
        case 0x4C: // JMP abs
            e.pc = e.readPCu16()
            cycles = 3
            break
        case 0x6C: // JMP indirect (with page boundary bug)
            e.pc = readU16Wrap(e.readPCu16())
            cycles = 5
            break

        // BVC
        case 0x50:
            doBranchingOnPredicate(!e.fOvf)
            break

        // CLI
        case 0x58:
            e.fIntdis = false
            cycles = 2
            break

        // RTS
        case 0x60:
            temp = pullu16()
            e.pc = temp + 1
            cycles = 6
            break

        // ADC
        case 0x61: // ADC (ind,X)
            doADC(read(addrIndX()))
            cycles = 6
            break
        case 0x65: // ADC zp
            doADC(read(e.readPC()))
            cycles = 3
            break
        case 0x69: // ADC imm
            doADC(e.readPC())
            cycles = 2
            break
        case 0x6D: // ADC abs
            doADC(read(e.readPCu16()))
            cycles = 4
            break
        case 0x71: // ADC (ind),Y
            doADC(read(addrIndY()))
            cycles = 5 + pageCrossed
            break
        case 0x75: // ADC zp,X
            doADC(read(addrZpX()))
            cycles = 4
            break
        case 0x79: // ADC abs,Y
            doADC(read(addrAbsY()))
            cycles = 4 + pageCrossed
            break
        case 0x7D: // ADC abs,X
            doADC(read(addrAbsX()))
            cycles = 4 + pageCrossed
            break

        // ROR
        case 0x6A: // ROR A
            e.a = doROR(e.a)
            cycles = 2
            break
        case 0x66: // ROR zp
            temp = e.readPC()
            write(temp, doROR(read(temp)))
            cycles = 5
            break
        case 0x76: // ROR zp,X
            temp = addrZpX()
            write(temp, doROR(read(temp)))
            cycles = 6
            break
        case 0x6E: // ROR abs
            temp = e.readPCu16()
            write(temp, doROR(read(temp)))
            cycles = 6
            break
        case 0x7E: // ROR abs,X
            temp = addrAbsX()
            write(temp, doROR(read(temp)))
            cycles = 7
            break

        // PLA
        case 0x68:
            e.a = pull()
            e.setResultFlags(e.a)
            cycles = 4
            break

        // BVS
        case 0x70:
            doBranchingOnPredicate(e.fOvf)
            break

        // SEI
        case 0x78:
            e.fIntdis = true
            cycles = 2
            break

        // STA
        case 0x81: // STA (ind,X)
            write(addrIndX(), e.a)
            cycles = 6
            break
        case 0x85: // STA zp
            write(e.readPC(), e.a)
            cycles = 3
            break
        case 0x8D: // STA abs
            write(e.readPCu16(), e.a)
            cycles = 4
            break
        case 0x91: // STA (ind),Y
            write(addrIndY(), e.a)
            cycles = 6
            break
        case 0x95: // STA zp,X
            write(addrZpX(), e.a)
            cycles = 4
            break
        case 0x99: // STA abs,Y
            write(addrAbsY(), e.a)
            cycles = 5
            break
        case 0x9D: // STA abs,X
            write(addrAbsX(), e.a)
            cycles = 5
            break

        // STY
        case 0x84: // STY zp
            write(e.readPC(), e.y)
            cycles = 3
            break
        case 0x8C: // STY abs
            write(e.readPCu16(), e.y)
            cycles = 4
            break
        case 0x94: // STY zp,X
            write(addrZpX(), e.y)
            cycles = 4
            break

        // STX
        case 0x86: // STX zp
            write(e.readPC(), e.x)
            cycles = 3
            break
        case 0x8E: // STX abs
            write(e.readPCu16(), e.x)
            cycles = 4
            break
        case 0x96: // STX zp,Y
            write(addrZpY(), e.x)
            cycles = 4
            break

        // DEY
        case 0x88:
            e.y = (e.y - 1) & 0xFF
            e.setResultFlags(e.y)
            cycles = 2
            break

        // TXA
        case 0x8A:
            e.a = e.x
            e.setResultFlags(e.a)
            cycles = 2
            break

        // BCC
        case 0x90:
            doBranchingOnPredicate(!e.fCarry)
            break

        // TYA
        case 0x98:
            e.a = e.y
            e.setResultFlags(e.a)
            cycles = 2
            break

        // TXS
        case 0x9A:
            e.sp = e.x
            cycles = 2
            break

        // LDY
        case 0xA0: // LDY imm
            e.y = e.readPC()
            e.setResultFlags(e.y)
            cycles = 2
            break
        case 0xA4: // LDY zp
            e.y = read(e.readPC())
            e.setResultFlags(e.y)
            cycles = 3
            break
        case 0xAC: // LDY abs
            e.y = read(e.readPCu16())
            e.setResultFlags(e.y)
            cycles = 4
            break
        case 0xB4: // LDY zp,X
            e.y = read(addrZpX())
            e.setResultFlags(e.y)
            cycles = 4
            break
        case 0xBC: // LDY abs,X
            e.y = read(addrAbsX())
            e.setResultFlags(e.y)
            cycles = 4 + pageCrossed
            break

        // LDA
        case 0xA1: // LDA (ind,X)
            e.a = read(addrIndX())
            e.setResultFlags(e.a)
            cycles = 6
            break
        case 0xA5: // LDA zp
            e.a = read(e.readPC())
            e.setResultFlags(e.a)
            cycles = 3
            break
        case 0xA9: // LDA imm
            e.a = e.readPC()
            e.setResultFlags(e.a)
            cycles = 2
            break
        case 0xAD: // LDA abs
            e.a = read(e.readPCu16())
            e.setResultFlags(e.a)
            cycles = 4
            break
        case 0xB1: // LDA (ind),Y
            e.a = read(addrIndY())
            e.setResultFlags(e.a)
            cycles = 5 + pageCrossed
            break
        case 0xB5: // LDA zp,X
            e.a = read(addrZpX())
            e.setResultFlags(e.a)
            cycles = 4
            break
        case 0xB9: // LDA abs,Y
            e.a = read(addrAbsY())
            e.setResultFlags(e.a)
            cycles = 4 + pageCrossed
            break
        case 0xBD: // LDA abs,X
            e.a = read(addrAbsX())
            e.setResultFlags(e.a)
            cycles = 4 + pageCrossed
            break

        // LDX
        case 0xA2: // LDX imm
            e.x = e.readPC()
            e.setResultFlags(e.x)
            cycles = 2
            break
        case 0xA6: // LDX zp
            e.x = read(e.readPC())
            e.setResultFlags(e.x)
            cycles = 3
            break
        case 0xAE: // LDX abs
            e.x = read(e.readPCu16())
            e.setResultFlags(e.x)
            cycles = 4
            break
        case 0xB6: // LDX zp,Y
            e.x = read(addrZpY())
            e.setResultFlags(e.x)
            cycles = 4
            break
        case 0xBE: // LDX abs,Y
            e.x = read(addrAbsY())
            e.setResultFlags(e.x)
            cycles = 4 + pageCrossed
            break

        // TAY
        case 0xA8:
            e.y = e.a
            e.setResultFlags(e.y)
            cycles = 2
            break

        // TAX
        case 0xAA:
            e.x = e.a
            e.setResultFlags(e.x)
            cycles = 2
            break

        // BCS
        case 0xB0:
            doBranchingOnPredicate(e.fCarry)
            break

        // CLV
        case 0xB8:
            e.fOvf = false
            cycles = 2
            break

        // TSX
        case 0xBA:
            e.x = e.sp
            e.setResultFlags(e.x)
            cycles = 2
            break

        // CPY
        case 0xC0: // CPY imm
            doCMP(e.y, e.readPC())
            cycles = 2
            break
        case 0xC4: // CPY zp
            doCMP(e.y, read(e.readPC()))
            cycles = 3
            break
        case 0xCC: // CPY abs
            doCMP(e.y, read(e.readPCu16()))
            cycles = 4
            break

        // CMP
        case 0xC1: // CMP (ind,X)
            doCMP(e.a, read(addrIndX()))
            cycles = 6
            break
        case 0xC5: // CMP zp
            doCMP(e.a, read(e.readPC()))
            cycles = 3
            break
        case 0xC9: // CMP imm
            doCMP(e.a, e.readPC())
            cycles = 2
            break
        case 0xCD: // CMP abs
            doCMP(e.a, read(e.readPCu16()))
            cycles = 4
            break
        case 0xD1: // CMP (ind),Y
            doCMP(e.a, read(addrIndY()))
            cycles = 5 + pageCrossed
            break
        case 0xD5: // CMP zp,X
            doCMP(e.a, read(addrZpX()))
            cycles = 4
            break
        case 0xD9: // CMP abs,Y
            doCMP(e.a, read(addrAbsY()))
            cycles = 4 + pageCrossed
            break
        case 0xDD: // CMP abs,X
            doCMP(e.a, read(addrAbsX()))
            cycles = 4 + pageCrossed
            break

        // CPX
        case 0xE0: // CPX imm
            doCMP(e.x, e.readPC())
            cycles = 2
            break
        case 0xE4: // CPX zp
            doCMP(e.x, read(e.readPC()))
            cycles = 3
            break
        case 0xEC: // CPX abs
            doCMP(e.x, read(e.readPCu16()))
            cycles = 4
            break

        // INC/DEC
        case 0xC6: // DEC zp
            temp = e.readPC()
            { let v = (read(temp) - 1) & 0xFF; write(temp, v); e.setResultFlags(v) }
            cycles = 5
            break
        case 0xD6: // DEC zp,X
            temp = addrZpX()
            { let v = (read(temp) - 1) & 0xFF; write(temp, v); e.setResultFlags(v) }
            cycles = 6
            break
        case 0xCE: // DEC abs
            temp = e.readPCu16()
            { let v = (read(temp) - 1) & 0xFF; write(temp, v); e.setResultFlags(v) }
            cycles = 6
            break
        case 0xDE: // DEC abs,X
            temp = addrAbsX()
            { let v = (read(temp) - 1) & 0xFF; write(temp, v); e.setResultFlags(v) }
            cycles = 7
            break
        case 0xE6: // INC zp
            temp = e.readPC()
            { let v = (read(temp) + 1) & 0xFF; write(temp, v); e.setResultFlags(v) }
            cycles = 5
            break
        case 0xF6: // INC zp,X
            temp = addrZpX()
            { let v = (read(temp) + 1) & 0xFF; write(temp, v); e.setResultFlags(v) }
            cycles = 6
            break
        case 0xEE: // INC abs
            temp = e.readPCu16()
            { let v = (read(temp) + 1) & 0xFF; write(temp, v); e.setResultFlags(v) }
            cycles = 6
            break
        case 0xFE: // INC abs,X
            temp = addrAbsX()
            { let v = (read(temp) + 1) & 0xFF; write(temp, v); e.setResultFlags(v) }
            cycles = 7
            break

        // INY
        case 0xC8:
            e.y = (e.y + 1) & 0xFF
            e.setResultFlags(e.y)
            cycles = 2
            break

        // DEX
        case 0xCA:
            e.x = (e.x - 1) & 0xFF
            e.setResultFlags(e.x)
            cycles = 2
            break

        // INX
        case 0xE8:
            e.x = (e.x + 1) & 0xFF
            e.setResultFlags(e.x)
            cycles = 2
            break

        // BNE
        case 0xD0:
            doBranchingOnPredicate(!e.fZero)
            break

        // CLD
        case 0xD8:
            e.fDec = false
            cycles = 2
            break

        // SBC
        case 0xE1: // SBC (ind,X)
            doSBC(read(addrIndX()))
            cycles = 6
            break
        case 0xE5: // SBC zp
            doSBC(read(e.readPC()))
            cycles = 3
            break
        case 0xE9: case 0xEB: // SBC imm
            doSBC(e.readPC())
            cycles = 2
            break
        case 0xED: // SBC abs
            doSBC(read(e.readPCu16()))
            cycles = 4
            break
        case 0xF1: // SBC (ind),Y
            doSBC(read(addrIndY()))
            cycles = 5 + pageCrossed
            break
        case 0xF5: // SBC zp,X
            doSBC(read(addrZpX()))
            cycles = 4
            break
        case 0xF9: // SBC abs,Y
            doSBC(read(addrAbsY()))
            cycles = 4 + pageCrossed
            break
        case 0xFD: // SBC abs,X
            doSBC(read(addrAbsX()))
            cycles = 4 + pageCrossed
            break

        // 3-byte NOP
        case 0x0C: case 0x1C: case 0x3C: case 0x5C: case 0x7C: case 0xDC: case 0xFC:
            let base = e.readPCu16()
            let addr  = (base + e.x) & 0xFFFF
            pageCrossed = opcode != 0x0C && (base & 0xFF00) != (addr & 0xFF00)
            cycles = 4 + pageCrossed
            break

        // 2-byte NOP
        case 0x04: case 0x14: case 0x34: case 0x44: case 0x54: case 0x80:
        case 0x89: case 0x82: case 0xD4: case 0xC2: case 0xF4: case 0xE2:
            e.readPC()
            cycles = 2 + (opcode & 0x1F == 0x04) ? 1 : (opcode & 0x1F == 0x14) ? 2 : 0
            break

        // 1-byte NOP
        case 0x1A: case 0x3A: case 0x5A: case 0x7A: case 0xDA: case 0xEA: case 0xFA:
            cycles = 2
            break

        // BEQ
        case 0xF0:
            doBranchingOnPredicate(e.fZero)
            break

        // SED
        case 0xF8:
            e.fDec = true
            cycles = 2
            break

        // XAA aka ANE
        case 0x8B:
            // many different 6502 variations show different results
            // this code roughly follows MOS C01437706 0782 / 6502 KOREA 5231 07 03-82
            let magic = 0xEE
            // simulate thermal effects
            if ((Math.random()*128)|0 < 1) magic |= 0x10;
            if ((Math.random()*128)|0 < 1) magic |= 0x01;
            let result = (e.a | magic) & e.x & e.readPC()
            e.a = result
            e.setResultFlags(result)
            // randomly flip N and Z flag
            if ((Math.random()*64)|0 < 1) e.fZero = !e.fZero;
            if ((Math.random()*64)|0 < 1) e.fNeg = !e.fNeg;
            cycles = 2
            break

        // HLT (unofficial)
        case 0x02:
            e.halted = true
            break

        default:
            // unknown opcode
            serial.println(`Illegal opcode ${opcode.toString(16)} at PC ${(e.pc - 1).toString(16)}`)
            e.halted = true
            break
    }

    // this is timing-inaccurate but oh well
    while (cycles > 0) {
        cycles--
        emulatePPU()
        emulatePPU()
        emulatePPU()
    }
}

function readPPU(vramAddr) {
    if (vramAddr < 0x2000) {
        return sys.peek(e.chr + vramAddr)
    }
    // read from the nametables
    else if (vramAddr < 0x3F00) {
        // horizontal mirroring
        if ((e.inesHdr[6] & 1) == 0) {
            return sys.peek(e.vram + ((vramAddr & 0x3FF) | (vramAddr & 0x800) >>> 1))
        }
        // vertical mirroring
        else {
            return sys.peek(e.vram + (vramAddr & 0x7FF))
        }
    }
    // read from palette RAM
    else {
        if ((vramAddr & 3) == 0) {
            return sys.peek(e.pal + (vramAddr & 0x0F))
        }
        else {
            return sys.peek(e.pal + (vramAddr & 0x1F))
        }
    }
}

function findCHRaddrForSprite(secondaryOAMslot, ppuScanline) {
    // 8x8 sprites
    if (!e.ppuUse8x16Sprites) {
        if (((e.ppuSpriteAtr[secondaryOAMslot] >>> 7) & 1) == 0) {
            return ((e.ppuSpritePatternTable ? 0x1000 : 0) | (e.ppuSpritePtn[secondaryOAMslot] << 4) | (e.ppuScanline - e.ppuSpritePosY[secondaryOAMslot]))
        }
        else {
            return ((e.ppuSpritePatternTable ? 0x1000 : 0) | (e.ppuSpritePtn[secondaryOAMslot] << 4) | ((7 - (e.ppuScanline - e.ppuSpritePosY[secondaryOAMslot])) & 7))
        }
    }
    // 8x16 sprites
    else {
        if (((e.ppuSpriteAtr[secondaryOAMslot] >>> 7) & 1) == 0) {
            if (ppuScanline - e.ppuSpritePosY[secondaryOAMslot] < 8) {
                return (((e.ppuSpritePtn[secondaryOAMslot] & 1) == 1) ? 0x1000 : 0) | ((e.ppuSpritePtn[secondaryOAMslot] & 0xFE) << 4) + (e.ppuScanline - e.ppuSpritePosY[secondaryOAMslot])
            }
            else {
                return (((e.ppuSpritePtn[secondaryOAMslot] & 1) == 1) ? 0x1000 : 0) | (((e.ppuSpritePtn[secondaryOAMslot] & 0xFE) << 4) + 16) + ((e.ppuScanline - e.ppuSpritePosY[secondaryOAMslot]) & 7)
            }
        }
        else {
            if (ppuScanline - e.ppuSpritePosY[secondaryOAMslot] < 8) {
                return (((e.ppuSpritePtn[secondaryOAMslot] & 1) == 1) ? 0x1000 : 0) | (((e.ppuSpritePtn[secondaryOAMslot] & 0xFE) << 4) + 16) - ((e.ppuScanline - e.ppuSpritePosY[secondaryOAMslot]) & 7) + 7
            }
            else {
                return (((e.ppuSpritePtn[secondaryOAMslot] & 1) == 1) ? 0x1000 : 0) | (((e.ppuSpritePtn[secondaryOAMslot] & 0xFE) << 4) + 7) - ((e.ppuScanline - e.ppuSpritePosY[secondaryOAMslot]) & 7)
            }
        }
    }
}

function evalSprites(ppuDot, ppuScanline) {
    if (ppuDot == 0) {
        e.ppuSecondaryOAMaddr = 0
        e.ppuSecondaryOAMfull = false
    }
    else if (0 < ppuDot && ppuDot <= 64) {
        if ((ppuDot & 1) == 1) {
            e.ppuSpriteEvalTemp = 0xFF
        }
        else {
            sys.poke(e.secondaryOAM + (ppuDot >> 1), e.ppuSpriteEvalTemp)
            e.ppuSecondaryOAMaddr = (e.ppuSecondaryOAMaddr + 1) & 0x1F
        }
    }
    else if (64 < ppuDot && ppuDot <= 256) {
        if (ppuDot == 65) {
            // reset per-scanline state before evaluation begins (matches C# reference dot 65)
            e.ppuScanlineContainsSprZero = false
            e.ppuSecondaryOAMaddr = 0
            e.ppuSpriteEvalTick = 0
            e.ppuSpriteEvalOAMovf = false
        }
        if ((ppuDot & 1) == 1) {
            e.ppuSpriteEvalTemp = sys.peek(e.oam + (e.ppuOAMaddr & 0xFF))
        }
        else {
            if (!e.ppuSpriteEvalOAMovf) {
                if (!e.ppuSecondaryOAMfull) {
                    sys.poke(e.secondaryOAM + (e.ppuSecondaryOAMaddr & 0x1F), e.ppuSpriteEvalTemp)
                }
                if (e.ppuSpriteEvalTick == 0) {
                    if (ppuScanline - e.ppuSpriteEvalTemp >= 0 && ppuScanline - e.ppuSpriteEvalTemp < (e.ppuUse8x16Sprites ? 16 : 8)) {
                        // this object is on this scanline!

                        if (!e.ppuSecondaryOAMfull) {
                            e.ppuSecondaryOAMaddr++
                            e.ppuOAMaddr++
                            if (ppuDot == 66) {
                                e.ppuScanlineContainsSprZero = true
                            }
                        } else {
                            e.ppuStatusOverflow = true
                        }
                        e.ppuSpriteEvalTick++
                    } else {
                        e.ppuOAMaddr += 4
                    }
                } else {
                    e.ppuSecondaryOAMaddr++
                    e.ppuOAMaddr++
                    if (e.ppuSecondaryOAMaddr == 0x20) {
                        e.ppuSecondaryOAMfull = true
                    }
                    e.ppuSpriteEvalTick = (e.ppuSpriteEvalTick + 1) & 3
                }
                if (e.ppuOAMaddr >= 0x100) {
                    e.ppuOAMaddr = 0
                    e.ppuSpriteEvalOAMovf = true
                }
            }
        }
    }
    else if (256 < ppuDot && ppuDot <= 320) {
        e.ppuOAMaddr = 0
        if (ppuDot == 257) {
            e.ppuSecondaryOAMsize = e.ppuSecondaryOAMaddr
            e.ppuSecondaryOAMaddr = 0
            e.ppuSpriteEvalTick = 0
        }

        let ppuSecondaryOAMaddr = e.ppuSecondaryOAMaddr
        let ppuSecondaryOAMslot = ppuSecondaryOAMaddr >>> 2
        let ppuSpriteEvalTemp = 0|0 // every read* function have side effects
        switch (e.ppuSpriteEvalTick) {
            case 0:
                e.ppuSpritePosY[ppuSecondaryOAMslot] = sys.peek(e.secondaryOAM + ppuSecondaryOAMaddr)
                e.ppuSecondaryOAMaddr = ppuSecondaryOAMaddr + 1
                break
            case 1:
                e.ppuSpritePtn[ppuSecondaryOAMslot] = sys.peek(e.secondaryOAM + ppuSecondaryOAMaddr)
                e.ppuSecondaryOAMaddr = ppuSecondaryOAMaddr + 1
                break
            case 2:
                e.ppuSpriteAtr[ppuSecondaryOAMslot] = sys.peek(e.secondaryOAM + ppuSecondaryOAMaddr)
                e.ppuSecondaryOAMaddr = ppuSecondaryOAMaddr + 1
                break
            case 3:
                e.ppuSpritePosX[ppuSecondaryOAMslot] = sys.peek(e.secondaryOAM + ppuSecondaryOAMaddr)
                break
            case 4:
                e.ppuAddrBus = findCHRaddrForSprite(ppuSecondaryOAMslot, ppuScanline)
                break
            case 5:
                ppuSpriteEvalTemp = readPPU(e.ppuAddrBus)
                if (ppuScanline == 261) {
                    ppuSpriteEvalTemp = 0
                }
                if (((e.ppuSpriteAtr[ppuSecondaryOAMslot] >>> 6) & 1) == 1) { // flip x?
                    // reverse the 8 bits
                    ppuSpriteEvalTemp = ((ppuSpriteEvalTemp & 0b11110000) >>> 4) | ((ppuSpriteEvalTemp & 0b00001111) << 4)
                    ppuSpriteEvalTemp = ((ppuSpriteEvalTemp & 0b11001100) >>> 2) | ((ppuSpriteEvalTemp & 0b00110011) << 2)
                    ppuSpriteEvalTemp = ((ppuSpriteEvalTemp & 0b10101010) >>> 1) | ((ppuSpriteEvalTemp & 0b01010101) << 1)
                }
                e.ppuSpriteShiftRegL[ppuSecondaryOAMslot] = ppuSpriteEvalTemp
                e.ppuSpriteEvalTemp = ppuSpriteEvalTemp
                break
            case 6:
                e.ppuAddrBus = (e.ppuAddrBus + 8) & 0x3FFF
                break
            case 7:
                ppuSpriteEvalTemp = readPPU(e.ppuAddrBus)
                if (ppuScanline == 261) {
                    ppuSpriteEvalTemp = 0
                }
                if (((e.ppuSpriteAtr[ppuSecondaryOAMslot] >>> 6) & 1) == 1) { // flip x?
                    // reverse the 8 bits
                    ppuSpriteEvalTemp = ((ppuSpriteEvalTemp & 0b11110000) >>> 4) | ((ppuSpriteEvalTemp & 0b00001111) << 4)
                    ppuSpriteEvalTemp = ((ppuSpriteEvalTemp & 0b11001100) >>> 2) | ((ppuSpriteEvalTemp & 0b00110011) << 2)
                    ppuSpriteEvalTemp = ((ppuSpriteEvalTemp & 0b10101010) >>> 1) | ((ppuSpriteEvalTemp & 0b01010101) << 1)
                }
                e.ppuSpriteShiftRegH[ppuSecondaryOAMslot] = ppuSpriteEvalTemp
                e.ppuSpriteEvalTemp = ppuSpriteEvalTemp
                e.ppuSecondaryOAMaddr = ppuSecondaryOAMaddr + 1
                break
        }

        e.ppuSpriteEvalTick = (e.ppuSpriteEvalTick + 1) & 7
    }
}

function emulatePPU() {
    let ppuDot = e.ppuDot // latch
    let ppuScanline = e.ppuScanline

    if (ppuDot == 1 && ppuScanline == 241) {
        e.ppuVblank = true
        e.drawNewFrame = true
    }
    else if (ppuDot == 1 && ppuScanline == 261) {
        e.ppuVblank = false
        e.ppuStatusOverflow = false
        e.ppuStatusSprZeroHit = false
    }

    // is it visible or pre-render scanline
    if (ppuScanline < 240 || ppuScanline == 261) {
        // Sprite evaluation runs across the full scanline (dots 0..320). The
        // eval function itself dispatches on the dot range, so call it
        // unconditionally here, matching the C# reference's structure.
        if (e.ppuMaskRenderBG || e.ppuMaskRenderSprites) {
            evalSprites(ppuDot, ppuScanline)
        }

        if ((0 < ppuDot && ppuDot <= 256) || (320 < ppuDot && ppuDot <= 336)) {
            // if rendering is enabled
            if (e.ppuMaskRenderBG || e.ppuMaskRenderSprites) {
                // if rendering the background, update the shift registers
                if (e.ppuMaskRenderBG) {
                    e.ppuShiftRegPtnL = (e.ppuShiftRegPtnL << 1) & 0xFFFF
                    e.ppuShiftRegPtnH = (e.ppuShiftRegPtnH << 1) & 0xFFFF
                    e.ppuShiftRegAtrL = (e.ppuShiftRegAtrL << 1) & 0xFFFF
                    e.ppuShiftRegAtrH = (e.ppuShiftRegAtrH << 1) & 0xFFFF
                }
                if (1 <= ppuDot && ppuDot <= 256) {
                    for (let i = 0; i < 8; i++) {
                        if (e.ppuSpritePosX[i] > 0) {
                            e.ppuSpritePosX[i] = e.ppuSpritePosX[i] - 1
                        }
                        else {
                            e.ppuSpriteShiftRegL[i] = e.ppuSpriteShiftRegL[i] << 1
                            e.ppuSpriteShiftRegH[i] = e.ppuSpriteShiftRegH[i] << 1
                        }
                    }
                }

                let cycleTick = (ppuDot - 1) & 7
                let vramAddr = e.vramAddr
                let ppuAddrBus = e.ppuAddrBus
                switch (cycleTick) {
                    case 0:
                        e.ppuShiftRegPtnL = (e.ppuShiftRegPtnL & 0xFF00) | e.ppu8stepPtnLoBitplane
                        e.ppuShiftRegPtnH = (e.ppuShiftRegPtnH & 0xFF00) | e.ppu8stepPtnHiBitplane
                        e.ppuShiftRegAtrL = (e.ppuShiftRegAtrL & 0xFF00) | ((e.ppu8stepAttr & 1) == 1 ? 0xFF : 0)
                        e.ppuShiftRegAtrH = (e.ppuShiftRegAtrH & 0xFF00) | ((e.ppu8stepAttr & 2) == 2 ? 0xFF : 0)
                        ppuAddrBus = 0x2000 | (e.vramAddr & 0x0FFF)
                        e.ppuAddrBus = ppuAddrBus
                        e.ppu8stepTemp = readPPU(ppuAddrBus)
                        break
                    case 1:
                        e.ppu8stepNextChar = e.ppu8stepTemp
                        break
                    case 2:
                        ppuAddrBus = 0x23C0 | (vramAddr & 0x0C00) | ((vramAddr >>> 4) & 0x38) | ((vramAddr >>> 2) & 0x07)
                        e.ppuAddrBus = ppuAddrBus
                        e.ppu8stepTemp = readPPU(ppuAddrBus)
                        break
                    case 3:
                        let ppu8stepAttr = e.ppu8stepTemp
                        // 1 byte of attribute covers 4 tiles. Figure out which title this is for
                        if ((vramAddr & 3) >= 2) { // is right tile?
                            ppu8stepAttr >>>= 2
                        }
                        if ((((vramAddr & 0b0000001111100000) >>> 5) & 3) >= 2) { // is bottom tile?
                            ppu8stepAttr >>>= 4
                        }
                        ppu8stepAttr &= 3
                        e.ppu8stepAttr = ppu8stepAttr
                        break
                    case 4:
                        ppuAddrBus = (((vramAddr & 0x7000) >>> 12) | e.ppu8stepNextChar * 16 | (e.ppuBGPatternTable ? 0x1000 : 0))
                        e.ppuAddrBus = ppuAddrBus
                        e.ppu8stepTemp = readPPU(ppuAddrBus)
                        break
                    case 5:
                        e.ppu8stepPtnLoBitplane = e.ppu8stepTemp
                        e.ppuAddrBus += 8
                        break
                    case 6:
                        e.ppu8stepTemp = readPPU(e.ppuAddrBus)
                        break
                    case 7:
                        e.ppu8stepPtnHiBitplane = e.ppu8stepTemp

                        if ((vramAddr & 0x001F) == 31) {
                            vramAddr &= 0xFFE0 // resetting the scroll
                            vramAddr ^= 0x0400 // crossing into the next nametable
                        }
                        else {
                            vramAddr++
                        }
                        e.vramAddr = vramAddr
                        break
                }
            }
        }
    }


    if (ppuScanline < 241 && 0 < ppuDot && ppuDot <= 256) {
        let palHi = 0
        let palLo = 0

        if (e.ppuMaskRenderBG && (ppuDot > 8 || e.ppuMask8pxMaskBG)) {
            let col0 = ((e.ppuShiftRegPtnL >>> (15 - e.ppuScrollFineX))) & 1
            let col1 = ((e.ppuShiftRegPtnH >>> (15 - e.ppuScrollFineX))) & 1
            palLo = (col1 << 1) | col0

            let pal0 = ((e.ppuShiftRegAtrL >>> (15 - e.ppuScrollFineX))) & 1
            let pal1 = ((e.ppuShiftRegAtrH >>> (15 - e.ppuScrollFineX))) & 1
            palHi = (pal1 << 1) | pal0

            if (palLo == 0 && palHi != 0) {
                palHi = 0
            }
        }

        let spritePalHi = 0
        let spritePalLo = 0
        let spritePriority = false
        if (e.ppuMaskRenderSprites && (ppuDot > 8 || e.ppuMask8pxMaskSprites)) {
            for (let i = 0; i < 8; i++) {
                if (e.ppuSpritePosX[i] == 0 && i < (e.ppuSecondaryOAMsize >>> 2)) {
                    let sPixelL = ((e.ppuSpriteShiftRegL[i]) & 0x80) != 0
                    let sPixelH = ((e.ppuSpriteShiftRegH[i]) & 0x80) != 0
                    spritePalLo = 0
                    if (sPixelL) spritePalLo = 1;
                    if (sPixelH) spritePalLo |= 2;

                    spritePalHi = ((e.ppuSpriteAtr[i]) & 0x03) | 0x04
                    spritePriority = ((e.ppuSpriteAtr[i] >> 5) & 1) == 0
                }
                else {
                    continue
                }
                if (spritePalLo != 0) {
                    if (i == 0 && e.ppuScanlineContainsSprZero && spritePalLo != 0 && palLo != 0 && e.ppuMaskRenderBG && ppuDot < 256) {
                        e.ppuStatusSprZeroHit = true
                    }
                    break
                }
            }
        }

        // render to FB
        if ((spritePriority && spritePalLo != 0) || palLo == 0) {
            palLo = spritePalLo
            palHi = spritePalHi
            if (palLo == 0) {
                palHi = 0
            }
        }
        let col = sys.peek(e.pal + palHi * 4 + palLo)
        e.plotFB(ppuDot - 1, ppuScanline, col)
    }


    // scroll register updates only happen during visible/pre-render scanlines,
    // and only when rendering is enabled. Running these unconditionally would
    // corrupt vramAddr during CPU-driven $2007 uploads (rendering off), because
    // the X reset at dot 257 copies transferAddr.coarseX into vramAddr.coarseX,
    // wiping out the auto-increment and causing writes to overwrite earlier tiles.
    if ((e.ppuMaskRenderBG || e.ppuMaskRenderSprites) && (ppuScanline < 240 || ppuScanline == 261)) {
        if (ppuDot == 256) {
            ppuIncrementScrollY(e.vramAddr)
        }
        else if (ppuDot == 257) {
            ppuResetScrollX(e.vramAddr)
        }
        else if (280 <= ppuDot && ppuDot <= 304 && ppuScanline == 261) {
            ppuResetScrollY(e.vramAddr)
        }
    }

    e.ppuDot = ppuDot + 1

    // wrap scanning beams
    if (ppuDot > 341) {
        ppuDot = 0; e.ppuDot = 0
        ppuScanline++; e.ppuScanline = ppuScanline
        if (ppuScanline > 261) {
            ppuScanline = 0; e.ppuScanline = 0
        }
    }
}

function ppuIncrementScrollY(vramAddr) {
    if ((vramAddr & 0x7000) != 0x7000) {
        e.vramAddr = vramAddr + 0x1000
    }
    else {
        vramAddr &= 0x0FFF
        let y = (vramAddr & 0x03E0) >>> 5
        if (y == 29) {
            y = 0
            vramAddr ^= 0x0800
        }
        else {
            y = (y+1) & 0x1F
        }

        e.vramAddr = (vramAddr & 0xFC1F) | (y << 5)
    }
}

function ppuResetScrollX(vramAddr) {
    e.vramAddr = ((vramAddr & 0b0111101111100000) | (e.transferAddr & 0b0000010000011111))
}

function ppuResetScrollY(vramAddr) {
    e.vramAddr = ((vramAddr & 0b0000010000011111) | (e.transferAddr & 0b0111101111100000))
}

function drawPatternTable() {
    for (let table = 0; table < 2; table++) {
        for (let row = 0; row < 16; row++) {
            for (let column = 0; column < 16; column++) {
                for (let y = 0; y < 8; y++) {
                    let loByte = sys.peek(e.chr + (0+y + column*16 + row*256 + table*4096))
                    let hiByte = sys.peek(e.chr + (8+y + column*16 + row*256 + table*4096))
                    for (let x = 0; x < 8; x++) {
                        let twobit = (((loByte >>> (7-x)) & 1) == 1) ? 1 : 0
                           twobit += (((hiByte >>> (7-x)) & 1) == 1) ? 2 : 0

                        // TODO read from palette
                        let palette = [240, 245, 250, 239]
                        let pixel = palette[twobit]
                        e.plotFB(x + column*8 + table*128, y + row*8, pixel)
                    }
                }
            }
        }
    }
}

function drawNameTable() {
    for (let row = 0; row < 30; row++) {
        for (let column = 0; column < 32; column++) {
            let attrOffset = ((column >>> 2) + (row >>> 2) * 8) & 255
            let attr = sys.peek(e.vram + 0x3C0 + attrOffset)
            let quadrant = (((column >>> 1) & 1) + ((row >>> 1) & 1) * 2) & 255
            let pair = (attr >>> (quadrant * 2)) & 3

            for (let y = 0; y < 8; y++) {
                let useSecondPatternTable = e.ppuBGPatternTable ? 4096 : 0
                let loByte = sys.peek(e.chr + sys.peek(e.vram + column + row*32) * 16 + y + useSecondPatternTable)
                let hiByte = sys.peek(e.chr + sys.peek(e.vram + column + row*32) * 16 + y + 8 + useSecondPatternTable)

                for (let x = 0; x < 8; x++) {
                    let twobit = (((loByte >>> (7-x)) & 1) == 1) ? 1 : 0
                       twobit += (((hiByte >>> (7-x)) & 1) == 1) ? 2 : 0
                    // backdrop colour (index 0 always use colour 0 of palette 0)
                    let pixel = (twobit == 0) ? sys.peek(e.pal) : sys.peek(e.pal + twobit + pair * 4)

                    e.plotFB(x + column*8, y + row*8, pixel)
                }
            }
        }
    }
}


///////////////////////////////////////////////////////////////////////////////

function render() {
    // drawNameTable()
    // drawPatternTable()
    fbToGPU(e.fb)
}

// copy framebuffer data to GPU
function fbToGPU(fb) {
    for (let y = 8; y < 232; y++) {
        let from = fb + y * 256
        let to = -(1048577 + (y - 8) * 280 + 12)
        sys.memcpy(from, to, 256)
    }
}

function uploadNESmasterPal() {
    let twoc02 = [0x666F,0x019F,0x10AF,0x409F,0x606F,0x602F,0x600F,0x410F,0x230F,0x040F,0x040F,0x041F,0x035F,0x000F,0x000F,0x000F,0xAAAF,0x04DF,0x32FF,0x71FF,0x90BF,0xB16F,0xA20F,0x840F,0x560F,0x270F,0x080F,0x083F,0x069F,0x000F,0x000F,0x000F,0xFFFF,0x5AFF,0x88FF,0xB6FF,0xD6FF,0xF6CF,0xF76F,0xD92F,0xBA0F,0x8C0F,0x5D2F,0x3D6F,0x3CCF,0x444F,0x000F,0x000F,0xFFFF,0xBEFF,0xCDFF,0xECFF,0xFCFF,0xFCEF,0xFCCF,0xFDAF,0xED9F,0xDE9F,0xCEAF,0xBECF,0xBEEF,0xBBBF,0x000F,0x000F]
    let twoc03 = [0x666F,0x029F,0x00DF,0x64DF,0x906F,0xB06F,0xB20F,0x940F,0x640F,0x240F,0x062F,0x090F,0x044F,0x000F,0x000F,0x000F,0xBBBF,0x06DF,0x04FF,0x90FF,0xB0FF,0xF09F,0xF00F,0xD60F,0x960F,0x290F,0x090F,0x0B6F,0x099F,0x000F,0x000F,0x000F,0xFFFF,0x6BFF,0x99FF,0xD6FF,0xF0FF,0xF6FF,0xF90F,0xFB0F,0xDD0F,0x6D0F,0x0F0F,0x4FDF,0x0FFF,0x000F,0x000F,0x000F,0xFFFF,0xBDFF,0xDBFF,0xFBFF,0xF9FF,0xFBBF,0xFD9F,0xFF4F,0xFF6F,0xBF4F,0x9F6F,0x4FDF,0x9DFF,0x000F,0x000F,0x000F]
    let rgba = twoc02

    // upload to TSVM palette index 0..63
    for (let i = 0; i < 64; i++) {
        let rg = (rgba[i] >>> 8) & 0xFF
        let ba = rgba[i] & 0xFF
        let addr = -(1310209 + 2*i)
        sys.poke(addr, rg); sys.poke(addr - 1, ba)
    }
}

///////////////////////////////////////////////////////////////////////////////

graphics.setGraphicsMode(1)
uploadNESmasterPal()
con.curs_set(0) // hide cursor
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

    serial.println("Current controller bit: "+status)
}

while (!appexit && !e.halted) {
    sys.poke(-40, 1)
    let keyCode = sys.peek(-41)

    if (keyCode == config.quit) {
        appexit = true
        break
    }

    updateButtonStatus()
    run()
    render()
}

con.curs_set(1) // end of emulation loop, show cursor

graphics.clearText()
graphics.setCursorYX(1, 1)
graphics.resetPalette()


/*println(`PC = ${e.pc.toString(16)}`)
println(` A = ${e.a.toString(16)}`)
println(` X = ${e.x.toString(16)}`)
println(` Y = ${e.y.toString(16)}`)

print("PTN:")
for (let i = 0; i < 64; i++) {
    if (i % 16 == 0) print(`\n$${(i+0x8000).toString(16).padStart(4, '0')} : `)
    let v = sys.peek(e.chr + i)
    print(v.toString(16).padStart(2, '0'))
    print(' ')
}
println()*/


e.free()
