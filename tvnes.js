// CPU status
const emulStat = {}
// memory space and pointers
emulStat.memspc = sys.malloc(65536)
emulStat.ram = emulStat.memspc + 0
emulStat.rom = emulStat.memspc + 0x8000
// iNES header goes here
emulStat.inesHdr = new Uint8Array(16)
// 6502 registers
emulStat.pc = (0x0) >>> 0
emulStat.sp = (0x0) >>> 0
emulStat.a = 0|0
emulStat.x = 0|0
emulStat.y = 0|0
// 6502 flags
emulStat.halted = false // Break command
emulStat.fCarry = false // Carry flag
emulStat.fZero = false // Zero flag
emulStat.fIntdis = false // Interrupt disable
emulStat.fDec = false // Decimal mode. Does absolutely nothing on NES
emulStat.fOvf = false // Overflow flag
emulStat.fNeg = false // negative flag

// helper functions

// increment PC by 1 with wrapping
emulStat.incPC = () => { emulStat.pc = (emulStat.pc + 1) % 65536 }
// read a byte from index PC then increment PC
emulStat.readPC = () => { const v = read(emulStat.pc); emulStat.incPC(); return v }
emulStat.readPCs = () => { const v = readSigned(emulStat.pc); emulStat.incPC(); return v }
// read an ushort from index PC then increment PC twice
emulStat.readPCu16 = () => {
    const lo = emulStat.readPC()
    const hi = emulStat.readPC()
    return hi * 0x100 + lo
}

// set 6502 flags by computation results
emulStat.setResultFlags = (val) => {
    emulStat.fZero = (val == 0)
    emulStat.fNeg = (val > 127)
}

emulStat.free = () => {
    sys.free(emulStat.memspc)
}

///////////////////////////////////////////////////////////////////////////////

const fullFilePath = _G.shell.resolvePathInput(exec_args[1])

function read(offset) { // always returns Uint
    // TODO memmap and mirroring
    return (sys.peek(emulStat.memspc + offset) >>> 0) & 255
}

function readSigned(offset) {
    let t = read(offset)
    return (t > 127) ? t - 256 : t
}

function write(offset0, value) {
    var offset = offset0; while (offset < 0) offset += 65536; // Q&D negative addr wrapping
    // TODO memmap and mirroring
    if (offset < 0x8000) {
        sys.poke(emulStat.memspc + offset, value)
    }
}

function reset() {
    let romFile = files.open(fullFilePath.full)
    let romFileSize = romFile.size
    let inesRomPtr = sys.malloc(romFileSize)
    romFile.pread(inesRomPtr, romFileSize, 0)

    // copy ROM
    sys.memcpy(inesRomPtr + 16, emulStat.rom, 0x8000)
    // copy iNES header
    for (let i = 0; i < 16; i++) {
        emulStat.inesHdr[i] = sys.peek(inesRomPtr + i)
    }
    sys.free(inesRomPtr)

    // run RESET vector
    emulStat.fIntdis = true
    let PCL = read(0xFFFC)
    let PCH = read(0xFFFD)
    emulStat.pc = PCH * 0x100 + PCL

}

function run() {
    while (!emulStat.halted) {
        emulateCPU()
    }
}

let cycles = 0
let opcode = 0
function emulateCPU() {
//    if (cycle == 0) {
        opcode = emulStat.readPC()
//        cycle++
//    }
//    else {
    switch(opcode) {
        case 0x02: // HLT
            emulStat.halted = true
            break
        case 0x85: // STA zero page
            write(emulStat.readPC(), emulStat.a)
            cycles = 3
            break
        case 0x8D: // STA absolute
            write(emulStat.readPCu16(), emulStat.a)
            cycles = 4
            break
        case 0xA0: // LDY imm
            emulStat.y = emulStat.readPC()
            emulStat.setResultFlags(emulStat.y)
            cycles = 2
            break
        case 0xA2: // LDX imm
            emulStat.x = emulStat.readPC()
            emulStat.setResultFlags(emulStat.x)
            cycles = 2
            break
        case 0xA9: // LDA imm
            emulStat.a = emulStat.readPC()
            emulStat.setResultFlags(emulStat.a)
            cycles = 2
            break

        default:
            // unknown opcode
            printerr("Illegal opcode: "+opcode.toString(16))
            break
    }
//    }
}

///////////////////////////////////////////////////////////////////////////////

reset()
run()

println(`PC = ${emulStat.pc.toString(16)}`)
println(` A = ${emulStat.a.toString(16)}`)
println(` X = ${emulStat.x.toString(16)}`)
println(` Y = ${emulStat.y.toString(16)}`)

emulStat.free()