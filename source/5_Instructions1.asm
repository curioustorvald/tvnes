	;;;; HEADER AND COMPILER STUFF ;;;;
	.inesprg 2  ; 2 banks
	.ineschr 0  ; 
	.inesmap 0  ; mapper 0 = NROM
	.inesmir 1  ; background mirroring, vertical
	;;;; ASSEMBLY CODE ;;;;	
	.org $8000
RESET:
	; I pretty much need an excuse to use every opcode mentioned in this section...
	; Let's start with JMP.
	JMP skip
	.byte $02 ; HLT. We don't want to execute this.
skip:
	;
	LDX #1
	INX ; X now equals 2.
	STX <$00 ; write 2 to address $0000
	DEX
	TXA
	TAY
	STY <$01 ; write 1 to address $0001
	TSX ; X should now be $FD
	STX <$02 ; write $FD to address $0002
	INY ; Y = 2
	TYA ; A = 2
	TAX ; X = 2
	TXS ; Stack pointer = 2.
	PHP ; Write $3D to $102
	SEC ; let's play around with the status flags a bit. This sets the carry flag.
	SED ; This sets the decimal flag.
	SEI ; This sets the interrupt flag.
	PHP ; Write $34 to $102
	PLP ; And pull them back off.
	PLP ; undo all that flag stuff, ha.
	LDA $101 ; that second PHP should have written to address $101
	STA <$03 ; This should write $3D to address $0003
	LDA $102 ; that first PHP should have written to address $102
	STA <$04 ; This should write $34 to address $0004
	LDX #$FD ; While we're here, let's reset the stack pointer.
	TXS
	
	NOP ; NOPS. woo!
	NOP
	NOP ; These do nothing, but it's nice to have them implemented.
	
	LDA #$81
	ASL A
	STA <$05 ; write $02 to address $0005
	ROL <$05 ; Rotate address $0005 to the left, resulting in the value $05.
	
	LDA #$7F
	AND #$F0 ; A = $70
	EOR #$3C ; A = $4C
	ORA #$01 ; A = $4D
	STA <$06 ; write $4D to address $0006
	SEC
	ROR <$06 ; address $0006 becomes $A6
	LSR <$06 ; Address $0006 becomes $53
	
	LDA #$F0
	SEC
	ADC #$20 ; This sets the carry flag.
	STA <$07 ; store $11 at address $0007
	BVS Fail
	BCS skip2
	.byte $02 ; HLT. We don't want to execute this.
skip2:
	LDA #$70
	CLC
	ADC #$20 ; This sets the overflow flag.
	STA <$08 ; store $90 in address $0008
	BCS Fail
	BVS skip3
	.byte $02 ; HLT. We don't want to execute this.
skip3:
	LDA #$11
	CLC
	SBC #$20
	STA <$09 ; Write $F0 to address $0009
	BVS Fail
	BCC skip4
	.byte $02 ; HLT. We don't want to execute this.
skip4:
	LDA #$90
	SEC
	SBC #$20
	STA <$0A ; write $70 to address $000A
	BCC Fail
	BVS skip5
Fail:
	.byte $02 ; HLT. We don't want to execute this.
skip5:

	LDA #$50
	CMP #$50 ; this sets the carry and zero flags, while clearing the negative flag.
	BNE Fail
	BMI Fail
	BCC Fail

	CLV

	LDA #$70
	BIT <$09 ; BIT test with address $0009, which has the value $F0.
	BPL Fail
	BVC Fail
	BEQ Fail
	
	BRK
	NOP ; This NOP should not be executed. Remember, BRK's return address is 1 byte later than expected.
	
	STA <$0C
	
	.byte $02 ; HLT. We do want to execute this one.
	
IRQ:
	LDA #1
	STA <$0B
	RTI

	.bank 3
	
	.org $FFFA	; Interrupt vectors go here:
	.word $FFFF ; NMI
	.word RESET ; Reset
	.word IRQ ; IRQ