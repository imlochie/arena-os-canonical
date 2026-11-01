// Original MIT-licensed acceptance game. SDL is loaded from its independently
// installed pinned runtime, never downloaded or installed by the game.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
namespace fs = std::filesystem;
struct Rect { int x, y, w, h; };
struct AudioSpec { int freq; uint16_t format; uint8_t channels, silence; uint16_t samples, padding; uint32_t size; void(*callback)(void*, uint8_t*, int); void* userdata; };
static std::atomic<unsigned> samples{0};
static void audio(void*, uint8_t* stream, int bytes) {
  static double phase = 0;
  auto output = reinterpret_cast<int16_t*>(stream);
  for (int i = 0; i < bytes / 2; i++) { output[i] = static_cast<int16_t>(std::sin(phase) * 2000); phase += 6.283185307179586 * 220 / 48000; }
  samples.fetch_add(static_cast<unsigned>(bytes / 2));
}
template<class T> static T api(HMODULE library, const char* name) {
  auto value = reinterpret_cast<T>(GetProcAddress(library, name));
  if (!value) throw std::runtime_error(std::string("Missing SDL API: ") + name);
  return value;
}
int wmain(int argc, wchar_t** argv) {
  try {
    if (argc < 3) throw std::runtime_error("Expected pinned runtime directory and writable profile.");
    const fs::path runtime(argv[1]), profile(argv[2]);
    const bool acceptance = argc > 3 && std::wstring(argv[3]) == L"--acceptance";
    HMODULE library = LoadLibraryExW((runtime / "SDL2.dll").c_str(), nullptr, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_SYSTEM32);
    if (!library) throw std::runtime_error("Pinned SDL runtime did not load.");
    auto init = api<int(*)(uint32_t)>(library, "SDL_Init");
    auto error = api<const char*(*)()>(library, "SDL_GetError");
    auto window = api<void*(*)(const char*, int, int, int, int, uint32_t)>(library, "SDL_CreateWindow");
    auto renderer = api<void*(*)(void*, int, uint32_t)>(library, "SDL_CreateRenderer");
    auto color = api<int(*)(void*, uint8_t, uint8_t, uint8_t, uint8_t)>(library, "SDL_SetRenderDrawColor");
    auto clear = api<int(*)(void*)>(library, "SDL_RenderClear");
    auto fill = api<int(*)(void*, const Rect*)>(library, "SDL_RenderFillRect");
    auto present = api<void(*)(void*)>(library, "SDL_RenderPresent");
    auto poll = api<int(*)(void*)>(library, "SDL_PollEvent");
    auto pixels = api<int(*)(void*, const Rect*, uint32_t, void*, int)>(library, "SDL_RenderReadPixels");
    auto openAudio = api<uint32_t(*)(const char*, int, const AudioSpec*, AudioSpec*, int)>(library, "SDL_OpenAudioDevice");
    auto pauseAudio = api<void(*)(uint32_t, int)>(library, "SDL_PauseAudioDevice");
    auto closeAudio = api<void(*)(uint32_t)>(library, "SDL_CloseAudioDevice");
    auto quit = api<void(*)()>(library, "SDL_Quit");
    if (init(0x20 | 0x10) != 0) throw std::runtime_error(error());
    void* screen = window("Arena SDL fixture - arrows move; close to save", 100, 100, 320, 240, 4);
    if (!screen) throw std::runtime_error(error());
    void* draw = renderer(screen, -1, 1); // Software renderer, no host GPU prerequisite.
    if (!draw) throw std::runtime_error(error());
    AudioSpec desired{}; desired.freq = 48000; desired.format = 0x8010; desired.channels = 1; desired.samples = 512; desired.callback = audio;
    AudioSpec actual{}; uint32_t device = openAudio(nullptr, 0, &desired, &actual, 0);
    if (!device) throw std::runtime_error(std::string("Audio output unavailable: ") + error());
    pauseAudio(device, 0);
    int saved = 0;
    const auto save = profile / "fixture-score.txt";
    if (fs::exists(save)) {
      std::ifstream input(save); if (!(input >> saved) || saved < 0 || saved > 1000000000) throw std::runtime_error("Invalid save retained without overwrite.");
    }
    int score = saved, x = 20; bool running = true, inputObserved = false, rendered = false;
    unsigned frames = 0; ULONGLONG start = GetTickCount64();
    while (running) {
      alignas(8) uint8_t event[64]{};
      while (poll(event)) {
        const auto type = *reinterpret_cast<uint32_t*>(event);
        if (type == 0x100) running = false;
        if (type == 0x300) {
          const auto key = *reinterpret_cast<int32_t*>(event + 16);
          if (key == 79 || key == 80) {
            if (key == 79 && score < 1000000000) score++;
            if (key == 80 && score > 0) score--;
            inputObserved = true;
          }
        }
      }
      x = (20 + (score % 28) * 10) % 280;
      color(draw, 10, 15, 25, 255); clear(draw);
      color(draw, 40, 220, 100, 255); Rect rectangle{x, 90, 24, 24}; fill(draw, &rectangle);
      if (acceptance && inputObserved) {
        Rect sample{x + 5, 95, 1, 1}; uint32_t pixel = 0;
        if (pixels(draw, &sample, 0x16362004 /* SDL_PIXELFORMAT_ARGB8888 */, &pixel, 4) != 0) throw std::runtime_error("SDL render readback failed.");
        rendered = ((pixel >> 8) & 255) > 180;
      }
      present(draw); frames++;
      if (acceptance && ((inputObserved && frames > 30 && samples.load() > 1024) || GetTickCount64() - start > 10000)) running = false;
      Sleep(16);
    }
    const auto temporary = profile / "fixture-score.tmp";
    { std::ofstream output(temporary); output << score; if (!output) throw std::runtime_error("Save write failed."); }
    if (!MoveFileExW(temporary.c_str(), save.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) throw std::runtime_error("Save activation failed; previous save retained.");
    closeAudio(device); quit();
    if (acceptance) {
      if (!inputObserved || !rendered || frames < 20 || samples.load() < 1024 || score != saved + 1) throw std::runtime_error("Native render/input/audio/save acceptance failed.");
      std::cout << "{\"fixture\":\"arena-sdl-v1\",\"renderReadback\":true,\"input\":\"Win32 keyboard event\",\"audioCallbacks\":" << samples.load()
        << ",\"savedBefore\":" << saved << ",\"savedAfter\":" << score << ",\"xBefore\":" << ((20 + (saved % 28) * 10) % 280) << ",\"xAfter\":" << x << "}" << std::endl;
    }
    FreeLibrary(library); return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << std::endl; return 1; }
}
