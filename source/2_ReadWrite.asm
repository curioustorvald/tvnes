	;;;; HEADER AND COMPILER STUFF ;;;;
	.inesprg 2  ; 2 banks
	.ineschr 0  ; 
	.inesmap 0  ; mapper 0 = NROM
	.inesmir 1  ; background mirroring, vertical
	;;;; ASSEMBLY CODE ;;;;	
	.org $8100
RESET:
	LDA #$5A
	STA <$00
	LDA #$80
	STA $550
	LDA <$00
	STA <$01
	LDA $550
	STA <$02
	
	.byte $02

	.bank 3
	
	.org $FFFA	; Interrupt vectors go here:
	.word $FFFF ; NMI
	.word RESET ; Reset
	.word $FFFF ; IRQ