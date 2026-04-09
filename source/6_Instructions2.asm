	;;;; HEADER AND COMPILER STUFF ;;;;
	.inesprg 2  ; 2 banks
	.ineschr 0  ; 
	.inesmap 0  ; mapper 0 = NROM
	.inesmir 1  ; background mirroring, vertical
	;;;; ASSEMBLY CODE ;;;;	
	.org $8000
RESET:
	; Let's do something fun with loops, like the fibonacci sequence or something.
	
	LDA #$01
	LDX #$00
	STA <$00,X
	INX
	STA <$00,X
	
	LDX #0
	; The loop
Loop:
	LDA <$00,X
	CLC
	ADC <$01,X
	STA <$02,X
	
	INX
	CPX #11
	BNE Loop
	JMP PostTable
	; How about reading from a look-up table?
Table:
	.byte "Hello world!"

PostTable:
	
	LDX #11
Loop2:
	LDA Table,X
	STA <$10,X
	DEX
	BPL Loop2 ; Loop until X underflows, which sets the Negative Flag.
	
	LDA #00
	STA <$FF
	LDA #$20
	STA <$FE
	LDY #0
	
Loop3:
	TYA
	STA [$FE],Y
	INY
	CPY #$10
	BNE Loop3
	
	; and now to test indexed indirect addressing.
	
	LDA #$30
	STA <$FE
	LDX #2
	LDA #$80
	STA [$FC,X]
	
	; And last but not least, let's make an indirect JMP!

	LDA #$10
	STA <$31
	LDA #$90
	STA <$32
	JMP [$0031]
	.byte $02 ; HLT. We don't want to execute this one.
	
	.org $9010
	LDA #1
	STA <$33
	.byte $02 ; HLT, we *do* want to execute this one.




	.bank 3
	
	.org $FFFA	; Interrupt vectors go here:
	.word $FFFF ; NMI
	.word RESET ; Reset
	.word $FFFF ; IRQ