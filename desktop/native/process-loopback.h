// Documented Windows process loopback (build 20348+). No virtual driver or
// protected-media workaround. Kept separate from endpoint capture.
#pragma once

class OwnedHandle {
 public:
  explicit OwnedHandle(HANDLE value = nullptr) : value_(value) {}
  ~OwnedHandle() { if (value_ && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_); }
  OwnedHandle(const OwnedHandle&) = delete;
  OwnedHandle& operator=(const OwnedHandle&) = delete;
  HANDLE get() const { return value_; }
 private:
  HANDLE value_;
};

bool processLoopbackSupported() {
  using RtlGetVersionFn = LONG(WINAPI*)(OSVERSIONINFOW*);
  auto fn = reinterpret_cast<RtlGetVersionFn>(
      GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion"));
  OSVERSIONINFOW version{};
  version.dwOSVersionInfoSize = sizeof(version);
  return fn && fn(&version) == 0 && version.dwMajorVersion >= 10 &&
      version.dwBuildNumber >= 20348;
}

std::string processStartTime(HANDLE process) {
  FILETIME created{}, exited{}, kernel{}, user{};
  if (!GetProcessTimes(process, &created, &exited, &kernel, &user)) return {};
  ULARGE_INTEGER ticks{};
  ticks.LowPart = created.dwLowDateTime;
  ticks.HighPart = created.dwHighDateTime;
  return std::to_string(ticks.QuadPart);
}

// Enumerate accessible processes in this interactive session, not a product
// whitelist. No executable paths or command lines leave the native host.
std::string applicationOptionsJson() {
  const bool supported = processLoopbackSupported();
  std::ostringstream out;
  out << "\"processLoopbackSupported\":" << (supported ? "true" : "false")
      << ",\"processLoopbackReason\":\""
      << (supported ? "" : "Application capture requires Windows build 20348 or later; choose whole output instead.")
      << "\",\"applications\":[";
  OwnedHandle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  DWORD ourSession = 0;
  if (!ProcessIdToSessionId(GetCurrentProcessId(), &ourSession) ||
      snapshot.get() == INVALID_HANDLE_VALUE) {
    return "\"processLoopbackSupported\":false,\"processLoopbackReason\":\"Could not enumerate applications in this Windows session; whole-output recording remains available.\",\"applications\":[]";
  }
  PROCESSENTRY32W entry{};
  entry.dwSize = sizeof(entry);
  bool first = true;
  if (supported && Process32FirstW(snapshot.get(), &entry)) {
    do {
      DWORD session = 0;
      if (entry.th32ProcessID == GetCurrentProcessId() ||
          !ProcessIdToSessionId(entry.th32ProcessID, &session) || session != ourSession) continue;
      OwnedHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE,
          FALSE, entry.th32ProcessID));
      if (!process.get() || WaitForSingleObject(process.get(), 0) != WAIT_TIMEOUT) continue;
      const auto identity = processStartTime(process.get());
      if (identity.empty()) continue;
      if (!first) out << ',';
      first = false;
      out << "{\"processId\":" << entry.th32ProcessID
          << ",\"processStartTime\":\"" << identity << "\",\"name\":\""
          << jsonEscape(utf8(entry.szExeFile)) << "\"}";
    } while (Process32NextW(snapshot.get(), &entry));
  }
  out << ']';
  return out.str();
}

class ProcessActivation final : public Microsoft::WRL::RuntimeClass<
    Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
    IActivateAudioInterfaceCompletionHandler, Microsoft::WRL::FtmBase> {
 public:
  ProcessActivation() : completed_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}

  HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT activation = E_UNEXPECTED;
    ComPtr<IUnknown> unknown;
    result_ = operation->GetActivateResult(&activation, &unknown);
    if (SUCCEEDED(result_)) result_ = activation;
    if (SUCCEEDED(result_)) result_ = unknown.As(&client_);
    SetEvent(completed_.get());
    return S_OK;
  }

  ComPtr<IAudioClient> activate(DWORD pid) {
    if (!completed_.get()) throw std::runtime_error("Could not create process activation event.");
    params_.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params_.ProcessLoopbackParams.TargetProcessId = pid;
    params_.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT prop{};
    prop.vt = VT_BLOB;
    prop.blob.cbSize = sizeof(params_);
    prop.blob.pBlobData = reinterpret_cast<BYTE*>(&params_);
    ComPtr<IActivateAudioInterfaceAsyncOperation> operation;
    requireHr(ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient), &prop, this, &operation), "Activate application loopback");
    if (WaitForSingleObject(completed_.get(), 10'000) != WAIT_OBJECT_0)
      throw std::runtime_error("Windows application capture activation timed out.");
    requireHr(result_, "Windows application loopback activation (no automatic whole-output fallback)");
    return client_;
  }

 private:
  OwnedHandle completed_;
  AUDIOCLIENT_ACTIVATION_PARAMS params_{};
  HRESULT result_ = E_PENDING;
  ComPtr<IAudioClient> client_;
};
