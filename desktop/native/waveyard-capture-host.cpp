#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <windows.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <mmdeviceapi.h>
#include <propsys.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <deque>
#include <iostream>
#include <limits>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

constexpr std::size_t kMaxFormatBytes = 4096;
constexpr std::size_t kMaxQueuedPcmBytes = 16 * 1024 * 1024;
constexpr DWORD kAudioWaitMs = 250;
constexpr ULONGLONG kStartHandshakeTimeoutMs = 30'000;

std::mutex g_eventMutex;

std::string hresultMessage(const char* operation, HRESULT result) {
  std::ostringstream output;
  output << operation << " failed (HRESULT 0x" << std::hex << std::uppercase
         << static_cast<unsigned long>(result) << ")";
  return output.str();
}

void requireHr(HRESULT result, const char* operation) {
  if (FAILED(result)) throw std::runtime_error(hresultMessage(operation, result));
}

std::string utf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (length <= 0) return {};
  std::string output(static_cast<std::size_t>(length), '\0');
  WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), output.data(), length, nullptr, nullptr);
  return output;
}

std::string jsonEscape(const std::string& value) {
  std::ostringstream output;
  for (const unsigned char character : value) {
    switch (character) {
      case '"': output << "\\\""; break;
      case '\\': output << "\\\\"; break;
      case '\b': output << "\\b"; break;
      case '\f': output << "\\f"; break;
      case '\n': output << "\\n"; break;
      case '\r': output << "\\r"; break;
      case '\t': output << "\\t"; break;
      default:
        if (character < 0x20) {
          output << "\\u00";
          constexpr char hex[] = "0123456789abcdef";
          output << hex[(character >> 4) & 0x0f] << hex[character & 0x0f];
        } else {
          output << static_cast<char>(character);
        }
    }
  }
  return output.str();
}

std::string base64(const BYTE* bytes, std::size_t length) {
  constexpr char alphabet[] =
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::string output;
  output.reserve(((length + 2) / 3) * 4);
  for (std::size_t index = 0; index < length; index += 3) {
    const std::uint32_t first = bytes[index];
    const std::uint32_t second = index + 1 < length ? bytes[index + 1] : 0;
    const std::uint32_t third = index + 2 < length ? bytes[index + 2] : 0;
    const std::uint32_t value = (first << 16) | (second << 8) | third;
    output.push_back(alphabet[(value >> 18) & 0x3f]);
    output.push_back(alphabet[(value >> 12) & 0x3f]);
    output.push_back(index + 1 < length ? alphabet[(value >> 6) & 0x3f] : '=');
    output.push_back(index + 2 < length ? alphabet[value & 0x3f] : '=');
  }
  return output;
}

bool writeAll(HANDLE handle, const void* bytes, std::size_t length) {
  const auto* cursor = static_cast<const BYTE*>(bytes);
  while (length > 0) {
    const DWORD requested = static_cast<DWORD>(std::min<std::size_t>(length, MAXDWORD));
    DWORD written = 0;
    if (!WriteFile(handle, cursor, requested, &written, nullptr) || written == 0) return false;
    cursor += written;
    length -= written;
  }
  return true;
}

void writeLine(HANDLE handle, const std::string& line) {
  const std::string output = line + "\n";
  if (!writeAll(handle, output.data(), output.size())) {
    throw std::runtime_error("Could not write the capture host protocol response.");
  }
}

void emitEvent(const std::string& json) {
  std::lock_guard<std::mutex> lock(g_eventMutex);
  const HANDLE error = GetStdHandle(STD_ERROR_HANDLE);
  if (error && error != INVALID_HANDLE_VALUE) writeLine(error, json);
}

std::string friendlyName(IMMDevice* device) {
  ComPtr<IPropertyStore> properties;
  requireHr(device->OpenPropertyStore(STGM_READ, &properties), "Open audio endpoint properties");
  PROPVARIANT value;
  PropVariantInit(&value);
  const HRESULT result = properties->GetValue(PKEY_Device_FriendlyName, &value);
  if (FAILED(result)) {
    PropVariantClear(&value);
    throw std::runtime_error(hresultMessage("Read audio endpoint name", result));
  }
  std::wstring name;
  if (value.vt == VT_LPWSTR && value.pwszVal) name = value.pwszVal;
  PropVariantClear(&value);
  return utf8(name);
}

std::wstring endpointId(IMMDevice* device) {
  LPWSTR id = nullptr;
  requireHr(device->GetId(&id), "Read audio endpoint ID");
  std::wstring value(id ? id : L"");
  CoTaskMemFree(id);
  return value;
}

ComPtr<IMMDeviceEnumerator> createEnumerator() {
  ComPtr<IMMDeviceEnumerator> enumerator;
  requireHr(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
      IID_PPV_ARGS(&enumerator)), "Create Windows audio endpoint enumerator");
  return enumerator;
}

std::wstring defaultRenderEndpointId(IMMDeviceEnumerator* enumerator) {
  ComPtr<IMMDevice> device;
  requireHr(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device),
      "Find default playback endpoint");
  return endpointId(device.Get());
}

void listDevices() {
  auto enumerator = createEnumerator();
  std::wstring defaultId;
  try {
    defaultId = defaultRenderEndpointId(enumerator.Get());
  } catch (...) {
    // A headless Windows runner can have no default output endpoint. Device
    // discovery still returns an honest empty list instead of crashing.
  }
  ComPtr<IMMDeviceCollection> devices;
  requireHr(enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices),
      "Enumerate active playback endpoints");
  UINT count = 0;
  requireHr(devices->GetCount(&count), "Count playback endpoints");

  std::ostringstream output;
  output << "{\"devices\":[";
  for (UINT index = 0; index < count; ++index) {
    ComPtr<IMMDevice> device;
    requireHr(devices->Item(index, &device), "Read playback endpoint");
    if (index > 0) output << ',';
    const std::wstring id = endpointId(device.Get());
    output << "{\"id\":\"" << jsonEscape(utf8(id))
           << "\",\"name\":\"" << jsonEscape(friendlyName(device.Get()))
           << "\",\"isDefault\":" << (id == defaultId ? "true" : "false") << '}';
  }
  output << "]}";
  writeLine(GetStdHandle(STD_OUTPUT_HANDLE), output.str());
}

class ControlPipe {
 public:
  ControlPipe() : handle_(GetStdHandle(STD_INPUT_HANDLE)) {}

  bool closed() const { return closed_; }

  bool pollLine(std::string& line) {
    const auto newline = pending_.find('\n');
    if (newline != std::string::npos) {
      line = pending_.substr(0, newline);
      pending_.erase(0, newline + 1);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      return true;
    }
    if (!handle_ || handle_ == INVALID_HANDLE_VALUE) {
      closed_ = true;
      return false;
    }

    DWORD available = 0;
    if (!PeekNamedPipe(handle_, nullptr, 0, nullptr, &available, nullptr)) {
      closed_ = true;
      return false;
    }
    if (available == 0) return false;

    char buffer[1024];
    DWORD read = 0;
    if (!ReadFile(handle_, buffer, std::min<DWORD>(available, static_cast<DWORD>(sizeof(buffer))), &read, nullptr)) {
      closed_ = true;
      return false;
    }
    pending_.append(buffer, read);
    return pollLine(line);
  }

 private:
  HANDLE handle_;
  std::string pending_;
  bool closed_ = false;
};

class PcmOutputQueue {
 public:
  PcmOutputQueue() : worker_([this] { run(); }) {}
  PcmOutputQueue(const PcmOutputQueue&) = delete;
  PcmOutputQueue& operator=(const PcmOutputQueue&) = delete;

  ~PcmOutputQueue() { finish(); }

  bool push(std::vector<BYTE>&& bytes) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (failed_ || finished_ || queuedBytes_ + bytes.size() > kMaxQueuedPcmBytes) {
      overflowed_ = queuedBytes_ + bytes.size() > kMaxQueuedPcmBytes;
      return false;
    }
    queuedBytes_ += bytes.size();
    chunks_.push_back(std::move(bytes));
    condition_.notify_one();
    return true;
  }

  void finish() {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      finished_ = true;
    }
    condition_.notify_all();
    if (worker_.joinable()) worker_.join();
  }

  bool failed() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return failed_;
  }

  bool overflowed() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return overflowed_;
  }

 private:
  void run() {
    const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    while (true) {
      std::vector<BYTE> chunk;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        condition_.wait(lock, [this] { return finished_ || !chunks_.empty(); });
        if (chunks_.empty() && finished_) return;
        chunk = std::move(chunks_.front());
        chunks_.pop_front();
        queuedBytes_ -= chunk.size();
      }
      if (!writeAll(output, chunk.data(), chunk.size())) {
        std::lock_guard<std::mutex> lock(mutex_);
        failed_ = true;
        chunks_.clear();
        queuedBytes_ = 0;
        finished_ = true;
        condition_.notify_all();
        return;
      }
    }
  }

  mutable std::mutex mutex_;
  std::condition_variable condition_;
  std::deque<std::vector<BYTE>> chunks_;
  std::size_t queuedBytes_ = 0;
  bool failed_ = false;
  bool overflowed_ = false;
  bool finished_ = false;
  std::thread worker_;
};

std::string audioFormatEvent(const std::wstring& id, const std::string& name,
    const WAVEFORMATEX* format, std::size_t formatBytes) {
  std::ostringstream output;
  output << "{\"type\":\"ready\",\"mode\":\"system-loopback\",\"deviceId\":\""
         << jsonEscape(utf8(id)) << "\",\"deviceName\":\"" << jsonEscape(name)
         << "\",\"formatChunkBase64\":\""
         << base64(reinterpret_cast<const BYTE*>(format), formatBytes)
         << "\",\"sampleRate\":" << format->nSamplesPerSec
         << ",\"channels\":" << format->nChannels
         << ",\"blockAlign\":" << format->nBlockAlign
         << ",\"bitsPerSample\":" << format->wBitsPerSample << '}';
  return output.str();
}

void recordLoopback(const std::wstring& requestedId) {
  auto enumerator = createEnumerator();
  ComPtr<IMMDevice> device;
  if (requestedId.empty()) {
    requireHr(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device),
        "Find default playback endpoint");
  } else {
    requireHr(enumerator->GetDevice(requestedId.c_str(), &device), "Open selected playback endpoint");
  }
  const std::wstring id = endpointId(device.Get());
  const std::string name = friendlyName(device.Get());

  ComPtr<IAudioClient> audioClient;
  requireHr(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
      reinterpret_cast<void**>(audioClient.GetAddressOf())), "Activate WASAPI playback client");

  WAVEFORMATEX* mixFormat = nullptr;
  requireHr(audioClient->GetMixFormat(&mixFormat), "Read Windows playback mix format");
  if (!mixFormat) throw std::runtime_error("Windows returned an empty playback mix format.");
  const std::size_t formatBytes = sizeof(WAVEFORMATEX) + mixFormat->cbSize;
  if (formatBytes > kMaxFormatBytes || mixFormat->nChannels == 0 ||
      mixFormat->nBlockAlign == 0 || mixFormat->nSamplesPerSec == 0) {
    CoTaskMemFree(mixFormat);
    throw std::runtime_error("Windows returned an unsupported playback mix format.");
  }
  const std::uint16_t blockAlign = mixFormat->nBlockAlign;

  HANDLE audioEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  if (!audioEvent) {
    CoTaskMemFree(mixFormat);
    throw std::runtime_error("Could not create the WASAPI capture event.");
  }

  HRESULT initialize = audioClient->Initialize(
      AUDCLNT_SHAREMODE_SHARED,
      AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
      0, 0, mixFormat, nullptr);
  if (FAILED(initialize)) {
    CloseHandle(audioEvent);
    CoTaskMemFree(mixFormat);
    throw std::runtime_error(hresultMessage("Initialize system audio loopback", initialize));
  }
  HRESULT setEvent = audioClient->SetEventHandle(audioEvent);
  if (FAILED(setEvent)) {
    CloseHandle(audioEvent);
    CoTaskMemFree(mixFormat);
    throw std::runtime_error(hresultMessage("Connect WASAPI capture event", setEvent));
  }

  ComPtr<IAudioCaptureClient> captureClient;
  HRESULT getService = audioClient->GetService(IID_PPV_ARGS(&captureClient));
  if (FAILED(getService)) {
    CloseHandle(audioEvent);
    CoTaskMemFree(mixFormat);
    throw std::runtime_error(hresultMessage("Create WASAPI capture client", getService));
  }

  emitEvent(audioFormatEvent(id, name, mixFormat, formatBytes));
  CoTaskMemFree(mixFormat);
  ControlPipe control;
  const ULONGLONG handshakeStart = GetTickCount64();
  bool started = false;
  while (!started) {
    std::string command;
    if (control.pollLine(command)) {
      if (command == "start") started = true;
      else if (command == "stop") {
        CloseHandle(audioEvent);
        emitEvent("{\"type\":\"cancelled\",\"reason\":\"stopped-before-start\"}");
        return;
      }
    } else if (control.closed()) {
      CloseHandle(audioEvent);
      throw std::runtime_error("Capture controller disconnected before starting the recording.");
    }
    if (GetTickCount64() - handshakeStart > kStartHandshakeTimeoutMs) {
      CloseHandle(audioEvent);
      throw std::runtime_error("Capture controller did not confirm the recording within 30 seconds.");
    }
    Sleep(20);
  }

  PcmOutputQueue pcmOutput;
  requireHr(audioClient->Start(), "Start system audio loopback");
  emitEvent("{\"type\":\"started\"}");
  bool shouldStop = false;
  std::uint64_t totalFrames = 0;

  while (!shouldStop) {
    std::string command;
    if (control.pollLine(command) && command == "stop") shouldStop = true;
    if (control.closed()) shouldStop = true;
    if (pcmOutput.failed()) throw std::runtime_error("The capture output pipe closed unexpectedly.");
    if (pcmOutput.overflowed()) {
      throw std::runtime_error("The recording could not keep up with disk writing; capture stopped to prevent unbounded memory use.");
    }
    if (shouldStop) break;

    const DWORD wait = WaitForSingleObject(audioEvent, kAudioWaitMs);
    if (wait == WAIT_FAILED) throw std::runtime_error("Waiting for Windows audio frames failed.");
    if (wait == WAIT_TIMEOUT) continue;
    if (wait != WAIT_OBJECT_0) throw std::runtime_error("Unexpected WASAPI capture event result.");

    UINT32 nextPacketFrames = 0;
    requireHr(captureClient->GetNextPacketSize(&nextPacketFrames), "Read WASAPI packet size");
    while (nextPacketFrames > 0) {
      BYTE* data = nullptr;
      UINT32 frameCount = 0;
      DWORD flags = 0;
      UINT64 devicePosition = 0;
      UINT64 qpcPosition = 0;
      requireHr(captureClient->GetBuffer(&data, &frameCount, &flags, &devicePosition, &qpcPosition),
          "Read WASAPI audio frames");
      if (frameCount == 0) {
        requireHr(captureClient->ReleaseBuffer(0), "Release empty WASAPI packet");
        requireHr(captureClient->GetNextPacketSize(&nextPacketFrames), "Read next WASAPI packet size");
        continue;
      }
      const std::uint64_t packetBytesUnsigned =
          static_cast<std::uint64_t>(frameCount) * blockAlign;
      if (packetBytesUnsigned > std::numeric_limits<std::size_t>::max()) {
        captureClient->ReleaseBuffer(frameCount);
        throw std::runtime_error("WASAPI returned a packet too large for this process.");
      }
      const std::size_t packetBytes = static_cast<std::size_t>(packetBytesUnsigned);
      std::vector<BYTE> packet(packetBytes, 0);
      if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) == 0 && packetBytes > 0) {
        if (!data) {
          captureClient->ReleaseBuffer(frameCount);
          throw std::runtime_error("WASAPI returned a null pointer for non-silent audio.");
        }
        std::memcpy(packet.data(), data, packetBytes);
      }
      const HRESULT released = captureClient->ReleaseBuffer(frameCount);
      requireHr(released, "Release WASAPI audio frames");

      if ((flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0 ||
          (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) != 0) {
        std::ostringstream event;
        event << "{\"type\":\"discontinuity\",\"devicePosition\":" << devicePosition
              << ",\"qpcPosition\":" << qpcPosition
              << ",\"timestampError\":"
              << ((flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) != 0 ? "true" : "false") << '}';
        emitEvent(event.str());
      }
      if (!pcmOutput.push(std::move(packet))) {
        if (pcmOutput.overflowed()) {
          throw std::runtime_error("The recording writer exceeded its bounded 16 MiB buffer.");
        }
        throw std::runtime_error("The recording output pipe is unavailable.");
      }
      totalFrames += frameCount;
      requireHr(captureClient->GetNextPacketSize(&nextPacketFrames), "Read next WASAPI packet size");
    }
  }

  const HRESULT stopped = audioClient->Stop();
  if (FAILED(stopped)) emitEvent("{\"type\":\"warning\",\"message\":\"WASAPI reported an error while stopping.\"}");
  pcmOutput.finish();
  CloseHandle(audioEvent);
  if (pcmOutput.failed()) throw std::runtime_error("The recording output pipe failed while flushing buffered audio.");
  std::ostringstream event;
  event << "{\"type\":\"stopped\",\"sampleFrames\":" << totalFrames << '}';
  emitEvent(event.str());
}

std::wstring optionValue(int argc, wchar_t* argv[], const std::wstring& option) {
  for (int index = 2; index + 1 < argc; ++index) {
    if (argv[index] == option) return argv[index + 1];
  }
  return {};
}

int run(int argc, wchar_t* argv[]) {
  if (argc < 2) {
    std::wcerr << L"Usage: waveyard-capture-host.exe version | devices | record [--device-id ID]\n";
    return 2;
  }
  const std::wstring command = argv[1];
  if (command == L"version") {
    writeLine(GetStdHandle(STD_OUTPUT_HANDLE),
        "{\"protocolVersion\":1,\"captureModes\":[\"system-loopback\"]}");
    return 0;
  }
  if (command != L"devices" && command != L"record") {
    std::wcerr << L"Unknown command. Use version, devices, or record.\n";
    return 2;
  }
  const HRESULT com = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  if (FAILED(com)) {
    emitEvent("{\"type\":\"error\",\"message\":\"Could not initialize Windows audio COM.\"}");
    return 3;
  }
  int exitCode = 0;
  try {
    if (command == L"devices") {
      listDevices();
    } else {
      recordLoopback(optionValue(argc, argv, L"--device-id"));
    }
  } catch (const std::exception& error) {
    emitEvent("{\"type\":\"error\",\"message\":\"" + jsonEscape(error.what()) + "\"}");
    exitCode = 4;
  }
  CoUninitialize();
  return exitCode;
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  return run(argc, argv);
}
