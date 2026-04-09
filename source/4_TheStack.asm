	;;;; HEADER AND COMPILER STUFF ;;;;
	.inesprg 2  ; 2 banks
	.ineschr 0  ; 
	.inesmap 0  ; mapper 0 = NROM
	.inesmir 1  ; background mirroring, vertical
	;;;; ASSEMBLY CODE ;;;;	
	.org $8000
RESET:
	JSR $9000
	LDA $01FB
	STA <$00
	.byte $02
	
	.org $9000
	LDA #$01
	PHA
	LDA #$5A
	PLA
	RTS

	.bank 3
	
	.org $FFFA	; Interrupt vectors go here:
	.word $FFFF ; NMI
	.word RESET ; Reset
	.word $FFFF ; IRQ