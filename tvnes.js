// NES Emulator for TSVM
// Based on tutorial by 100thCoin
// https://www.patreon.com/posts/making-your-nes-137873901

// CPU status
const e = {}
// memory space and pointers
e.mem = sys.malloc(65536)
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

// helper functions

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
}

///////////////////////////////////////////////////////////////////////////////

const fullFilePath = _G.shell.resolvePathInput(exec_args[1])
if (fullFilePath === undefined) {
    println(`Usage: ${exec_args[0]} path_to_rom.nes`)
    return 1
}

function read(offset) { // always returns Uint
    // TODO memmap and mirroring
    return (sys.peek(e.mem + offset) >>> 0) & 255
}

function readSigned(offset) {
    let t = read(offset)
    return (t > 127) ? t - 256 : t
}

function write(offset0, value) {
    var offset = offset0; while (offset < 0) offset += 65536; // Q&D negative addr wrapping
    // TODO memmap and mirroring
    if (offset < 0x8000) {
        sys.poke(e.mem + offset, value)
    }
}

function push(value) {
    write(0x100 + e.sp--, value)
}

function pull() {
    return read(0x100 + ++e.sp)
}

function pullu16() {
    let lo = pull()
    let hi = pull()
    return (hi << 8) | lo
}

function reset() {
    let romFile = files.open(fullFilePath.full)
    let romFileSize = romFile.size
    let inesRomPtr = sys.malloc(romFileSize)
    romFile.pread(inesRomPtr, romFileSize, 0)

    // copy ROM
    sys.memcpy(inesRomPtr + 16, e.rom, 0x8000)
    // copy iNES header
    for (let i = 0; i < 16; i++) {
        e.inesHdr[i] = sys.peek(inesRomPtr + i)
    }
    sys.free(inesRomPtr)

    // run RESET vector
    e.fIntdis = true
    let PCL = read(0xFFFC)
    let PCH = read(0xFFFD)
    e.pc = (PCH << 8) | PCL
    e.sp = 0xFD
}

function run() {
    while (!e.halted) {
        emulateCPU()
    }
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
    opcode = e.readPC()

    switch(opcode) {

        // BRK
        case 0x00:
            e.incPC() // skip padding byte
            e.pushPC()
            push(packFlags(true))
            e.fIntdis = true
            e.pc = read(0xFFFE) | (read(0xFFFF) << 8)
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
        case 0xE9: // SBC imm
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

        // NOP
        case 0xEA:
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

        // HLT (unofficial)
        case 0x02:
            e.halted = true
            break

        default:
            // unknown opcode
            printerrln(`Illegal opcode ${opcode.toString(16)} at PC ${(e.pc - 1).toString(16)}`)
            e.halted = true
            break
    }
}

///////////////////////////////////////////////////////////////////////////////

reset()
run()

println(`PC = ${e.pc.toString(16)}`)
println(` A = ${e.a.toString(16)}`)
println(` X = ${e.x.toString(16)}`)
println(` Y = ${e.y.toString(16)}`)

print("MEM:")
for (let i = 0; i < 64; i++) {
    if (i % 16 == 0) print(`\n$${i.toString(16).padStart(4, '0')} : `)
    let v = sys.peek(e.mem + i)
    print(v.toString(16).padStart(2, '0'))
    print(' ')
}
println()


e.free()
