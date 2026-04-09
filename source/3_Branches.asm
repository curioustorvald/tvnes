	;;;; HEADER AND COMPILER STUFF ;;;;
	.inesprg 2  ; 2 banks
	.ineschr 0  ; 
	.inesmap 0  ; mapper 0 = NROM
	.inesmir 1  ; background mirroring, vertical
	;;;; ASSEMBLY CODE ;;;;	
	.org $8000
RESET:
	LDA #$8A
	BNE Skip1
	.byte $02
Skip1:
	BMI Skip2
	.byte $02
Skip2:
	LDA #$00
	BNE Fail1
	BEQ Skip3
Fail1:
	.byte $02
Skip3:
	BPL Skip4
	.byte $02
Skip4:
	LDA #01
	STA <$00
	.byte $02

	.bank 3
	
	.org $FFFA	; Interrupt vectors go here:
	.word $FFFF ; NMI
	.word RESET ; Reset
	.word $FFFF ; IRQ