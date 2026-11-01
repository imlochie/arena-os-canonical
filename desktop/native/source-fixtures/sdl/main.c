/* Original Arena source-build acceptance fixture. SPDX-License-Identifier: MIT */
#include <SDL.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static double phase;
static void tone(void *unused, Uint8 *bytes, int count) {
  (void)unused;
  float *samples = (float *)bytes;
  for (int n = 0; n < count / (int)sizeof(float); n += 2) {
    float value = (float)(sin(phase) * 0.035);
    samples[n] = value; samples[n + 1] = value;
    phase += 2.0 * 3.141592653589793 * 440.0 / 48000.0;
  }
}
int main(int argc, char **argv) {
  (void)argc; (void)argv;
  const char *profile = getenv("ARENA_ARCADE_PROFILE");
  if (!profile || !*profile || SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO) != 0) return 2;
  char save[4096];
  if (snprintf(save, sizeof(save), "%s/source-sdl-score.txt", profile) >= (int)sizeof(save)) return 3;
  int score = 0;
  FILE *input = fopen(save, "r");
  if (input) { if (fscanf(input, "%d", &score) != 1 || score < 0) score = 0; fclose(input); }
  SDL_Window *window = SDL_CreateWindow("Arena SDL source acceptance", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED, 640, 360, 0);
  SDL_Renderer *renderer = window ? SDL_CreateRenderer(window, -1, SDL_RENDERER_SOFTWARE) : NULL;
  if (!renderer) return 4;
  SDL_AudioSpec wanted, actual; SDL_zero(wanted);
  wanted.freq = 48000; wanted.channels = 2; wanted.format = AUDIO_F32SYS; wanted.samples = 1024; wanted.callback = tone;
  SDL_AudioDeviceID audio = SDL_OpenAudioDevice(NULL, 0, &wanted, &actual, 0);
  if (!audio || !SDL_GetCurrentAudioDriver() || strcmp(SDL_GetCurrentAudioDriver(), "dummy") == 0) return 5;
  SDL_PauseAudioDevice(audio, 0);
  int running = 1;
  while (running) {
    SDL_Event event;
    while (SDL_PollEvent(&event)) {
      if (event.type == SDL_QUIT) running = 0;
      if (event.type == SDL_KEYDOWN && !event.key.repeat) {
        if (event.key.keysym.sym == SDLK_ESCAPE) running = 0;
        if (event.key.keysym.sym == SDLK_RIGHT) {
          score++;
          FILE *output = fopen(save, "w");
          if (!output || fprintf(output, "%d\n", score) < 0) return 6;
          if (fclose(output) != 0) return 7;
        }
      }
    }
    char title[160]; snprintf(title, sizeof(title), "Arena SDL source acceptance - score %d - Right moves, Esc closes", score);
    SDL_SetWindowTitle(window, title);
    SDL_SetRenderDrawColor(renderer, 10, 16, 24, 255); SDL_RenderClear(renderer);
    SDL_Rect square = {32 + (score % 24) * 20, 140, 32, 32};
    SDL_SetRenderDrawColor(renderer, 30, 230, 90, 255); SDL_RenderFillRect(renderer, &square); SDL_RenderPresent(renderer);
    SDL_Delay(16);
  }
  SDL_CloseAudioDevice(audio); SDL_DestroyRenderer(renderer); SDL_DestroyWindow(window); SDL_Quit(); return 0;
}
