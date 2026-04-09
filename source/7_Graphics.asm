	;;;; HEADER AND COMPILER STUFF ;;;;
	.inesprg 2  ; 2 banks
	.ineschr 1  ; 
	.inesmap 0  ; mapper 0 = NROM
	.inesmir 1  ; background mirroring, vertical
	;;;; ASSEMBLY CODE ;;;;	
	.org $8000
RESET:
	LDA #$3F
	STA $2006
	LDA #0
	STA $2006 ; move VRAMAddress to $3F00
	
	LDA #$0F
	STA $2007 ; block
	LDA #0
	STA $2007 ; grey
	LDA #$10
	STA $2007 ; light grey
	LDA #$30
	STA $2007 ; white
	
	; with color palette 0 all set up, let's write "Hello" to the nametable.
	
	LDA #$20
	STA $2006
	LDA #0
	STA $2006 ; move VRAMAddress to $2000
	
	LDA #$11
	STA $2007 ; H
	
	LDA #$0E
	STA $2007 ; E
	
	LDA #$15
	STA $2007 ; L
	STA $2007 ; L

	LDA #$18
	STA $2007 ; O
	
	LDA #$24
	STA $2007 ;  
	
	LDA #$20
	STA $2007 ; W
	
	LDA #$18
	STA $2007 ; O
	
	LDA #$1B
	STA $2007 ; R
	
	LDA #$15
	STA $2007 ; L
	
	LDA #$0D
	STA $2007 ; D
	
	LDA #$26
	STA $2007 ; !
	
	.byte $02
	
	.bank 3
	
	.org $FFFA	; Interrupt vectors go here:
	.word $FFFF ; NMI
	.word RESET ; Reset
	.word $FFFF ; IRQ
	
	;;;; NESASM COMPILER STUFF, ADDING THE PATTERN DATA ;;;;

	.incchr "BG.pcx"
	.incchr "Sprites.pcx"