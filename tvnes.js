// NES Emulator for TSVM
// Based on tutorial by 100thCoin
// https://www.patreon.com/posts/making-your-nes-137873901

// CPU status
const e = {}
// memory space and pointers
e.memspc = sys.malloc(65536)
e.ram = e.memspc + 0
e.rom = e.memspc + 0x8000
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

// increment PC by 1 with wrapping
e.movPC = (offset) => {
    e.pc = e.pc + offset
    while (e.pc > 65535) {
        e.pc -= 65536
    }
    while (e.pc < 0) {
        e.pc += 65536
    }
}
e.incPC = () => { e.pc = (e.pc + 1) % 65536 }
e.decPC = () => { e.pc = (e.pc == 0) ? 65535 : e.pc = e.pc - 1 }
// read a byte from index PC then increment PC
e.readPC = () => { const v = read(e.pc); e.incPC(); return v }
e.readPCs = () => { const v = readSigned(e.pc); e.incPC(); return v }
// read an ushort from index PC then increment PC twice
e.readPCu16 = () => {
    const lo = e.readPC()
    const hi = e.readPC()
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
    sys.free(e.memspc)
}

///////////////////////////////////////////////////////////////////////////////

const fullFilePath = _G.shell.resolvePathInput(exec_args[1])

function read(offset) { // always returns Uint
    // TODO memmap and mirroring
    return (sys.peek(e.memspc + offset) >>> 0) & 255
}

function readSigned(offset) {
    let t = read(offset)
    return (t > 127) ? t - 256 : t
}

function write(offset0, value) {
    var offset = offset0; while (offset < 0) offset += 65536; // Q&D negative addr wrapping
    // TODO memmap and mirroring
    if (offset < 0x8000) {
        sys.poke(e.memspc + offset, value)
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
function doBranchingOnPredicate(p) {
    let sv = e.readPCs()
    let oldPCh = e.pc >>> 8
    if (p) {
        e.movPC(sv)
        let newPCh = e.pc >>> 8
        cycles = 3 + (oldPCh != newPCh) // 4 if high byte of PC has changed
    }
    else {
        cycles = 2
    }
}

function emulateCPU() {
//    if (cycle == 0) {
        opcode = e.readPC()
//        cycle++
//    }
//    else {
    switch(opcode) {
        case 0x02: // HLT
            e.halted = true
            break

        case 0x48: // PHA
            push(e.a)
            cycles = 3
            break
        case 0x68: // PLA
            e.a = pull()
            e.setResultFlags(e.a)
            cycles = 4
            break

        case 0x20: // JSR
            temp = e.readPCu16(); e.decPC()
            e.pushPC()
            e.pc = temp
            cycles = 6
            break
        case 0x60: // RTS
            temp = pullu16()
            e.pc = temp + 1
            cycles = 6
            break

        case 0x84: // STY zero page
            write(e.readPC(), e.y)
            cycles = 3
            break
        case 0x85: // STA zero page
            write(e.readPC(), e.a)
            cycles = 3
            break
        case 0x86: // STX zero page
            write(e.readPC(), e.x)
            cycles = 3
            break
        case 0x8C: // STY absolute
            write(e.readPCu16(), e.y)
            cycles = 4
            break
        case 0x8D: // STA absolute
            write(e.readPCu16(), e.a)
            cycles = 4
            break
        case 0x8E: // STX absolute
            write(e.readPCu16(), e.x)
            cycles = 4
            break


        case 0xA0: // LDY imm
            e.y = e.readPC()
            e.setResultFlags(e.y)
            cycles = 2
            break
        case 0xA2: // LDX imm
            e.x = e.readPC()
            e.setResultFlags(e.x)
            cycles = 2
            break
        case 0xA4: // LDY zero page
            e.y = read(e.readPC())
            e.setResultFlags(e.y)
            cycles = 3
            break
        case 0xA5: // LDA zero page
            e.a = read(e.readPC())
            e.setResultFlags(e.a)
            cycles = 3
            break
        case 0xA6: // LDX zero page
            e.x = read(e.readPC())
            e.setResultFlags(e.x)
            cycles = 3
            break
        case 0xA9: // LDA imm
            e.a = e.readPC()
            e.setResultFlags(e.a)
            cycles = 2
            break
        case 0xAC: // LDY absolute
            e.y = read(e.readPCu16())
            e.setResultFlags(e.y)
            cycles = 4
            break
        case 0xAD: // LDA absolute
            e.a = read(e.readPCu16())
            e.setResultFlags(e.a)
            cycles = 4
            break
        case 0xAE: // LDX absolute
            e.x = read(e.readPCu16())
            e.setResultFlags(e.x)
            cycles = 4
            break

        case 0xD0: // BNE
            doBranchingOnPredicate(!e.fZero)
            break
        case 0x90: // BCC
            doBranchingOnPredicate(!e.fCarry)
            break
        case 0xB0: // BCS
            doBranchingOnPredicate(e.fCarry)
            break
        case 0xF0: // BEQ
            doBranchingOnPredicate(e.fZero)
            break
        case 0x30: // BMI
            doBranchingOnPredicate(e.fNeg)
            break
        case 0x10: // BPL
            doBranchingOnPredicate(!e.fNeg)
            break
        case 0x50: // BVC
            doBranchingOnPredicate(!e.fOvf)
            break
        case 0x70: // BVS
            doBranchingOnPredicate(e.fOvf)
            break
        case 0x18: // CLC
            e.fCarry = 0
            cycles = 2
            break
        case 0xD8: // CLD
            e.fDec = 0
            cycles = 2
            break
        case 0x58: // CLI
            e.fIntdis = 0
            cycles = 2
            break
        case 0xB8: // CLV
            e.fOvf = 0
            cycles = 2
            break

        default:
            // unknown opcode
            printerrln(`Illegal opcode ${opcode.toString(16)} at PC ${e.pc.toString(16)}`)
            e.halted = true
            break
    }
//    }
}

///////////////////////////////////////////////////////////////////////////////

reset()
run()

println(`PC = ${e.pc.toString(16)}`)
println(` A = ${e.a.toString(16)}`)
println(` X = ${e.x.toString(16)}`)
println(` Y = ${e.y.toString(16)}`)

println(`MEM[$0000] = ${sys.peek(e.ram + 0x0000).toString(16)}`)
println(`MEM[$0001] = ${sys.peek(e.ram + 0x0001).toString(16)}`)
println(`MEM[$0002] = ${sys.peek(e.ram + 0x0002).toString(16)}`)
println(`MEM[$0550] = ${sys.peek(e.ram + 0x0550).toString(16)}`)


e.free()