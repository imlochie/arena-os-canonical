/* MIT License, Copyright Arena contributors.
 * Permission is granted to use, copy, modify and distribute this original
 * fixture with this notice. Provided AS IS, without warranty.
 * GBDK 4.5.0 / SDCC library licenses and exceptions accompany the built ROM.
 * No proprietary game, boot ROM, artwork or audio data is used. */
#include <gb/gb.h>
#include <gbdk/console.h>
#include <stdint.h>
#include <stdio.h>

void main(void) {
    volatile uint8_t *save = (volatile uint8_t *)0xA000;
    uint8_t previous = 0, x = 1, coin = 7, keys;
    ENABLE_RAM_MBC1;
    if (save[1] != 0x42 || save[0] > 9) { save[0] = 0; save[1] = 0x42; }
    NR52_REG = 0x80; NR50_REG = 0x77; NR51_REG = 0x11;
    DISPLAY_ON;
    printf("ARENA COIN TRAIL\n\nOriginal homebrew\n\nArrows: move\nA: collect at coin\nB: new game\n\n");
    while (1) {
        keys = joypad();
        if ((keys & J_LEFT) && !(previous & J_LEFT) && x > 1) x--;
        if ((keys & J_RIGHT) && !(previous & J_RIGHT) && x < 18) x++;
        coin = (uint8_t)((save[0] * 3u + 6u) % 18u + 1u);
        if ((keys & J_A) && !(previous & J_A) && x == coin && save[0] < 9) {
            save[0]++;
            NR10_REG = 0; NR11_REG = 0x80; NR12_REG = 0xF3;
            NR13_REG = 0; NR14_REG = 0x87;
        }
        if ((keys & J_B) && !(previous & J_B)) save[0] = 0;
        gotoxy(0, 9); printf("Coins: %u/9  ", (unsigned int)save[0]);
        gotoxy(0, 11); printf("                    ");
        gotoxy(coin, 11); printf("o");
        gotoxy(x, 11); printf("@");
        gotoxy(0, 13); printf(save[0] == 9 ? "You win! B restarts" : "Progress uses SRAM ");
        previous = keys;
        vsync();
    }
}
