// Windows-only trusted supervisor. Games never run on the host token. There is
// no plain-spawn/host-jail fallback when LPAC, ACL, WFP or Job setup fails.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define _WIN32_WINNT 0x0A00
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <userenv.h>
#include <aclapi.h>
#include <sddl.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <stdexcept>
#include <algorithm>
#pragma comment(lib, "userenv.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "user32.lib")
namespace fs = std::filesystem;
static std::mutex outputMutex;
static void require(bool ok, const char* operation) {
  if (!ok) throw std::runtime_error(std::string(operation) + " failed; Win32=" + std::to_string(GetLastError()));
}
static void event(const std::string& value) { std::lock_guard<std::mutex> lock(outputMutex); std::cout << value << std::endl; }
static std::string json(const std::string& value) {
  std::string result = "\"";
  for (unsigned char c : value) {
    if (c == '"' || c == '\\') { result += '\\'; result += static_cast<char>(c); }
    else if (c < 32 || c >= 127) { const char* h = "0123456789abcdef"; result += "\\u00"; result += h[c >> 4]; result += h[c & 15]; }
    else result += static_cast<char>(c);
  }
  return result + "\"";
}
struct Handle {
  HANDLE value = nullptr;
  Handle() = default;
  explicit Handle(HANDLE h) : value(h) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
};
static void regularPath(const fs::path& path) {
  require(path.is_absolute(), "absolute managed path");
  fs::path cursor = path.root_path();
  for (const auto& component : path.relative_path()) {
    if (component == L".." || component == L".") throw std::runtime_error("Relative path segment refused.");
    cursor /= component;
    DWORD attributes = GetFileAttributesW(cursor.c_str());
    require(attributes != INVALID_FILE_ATTRIBUTES && !(attributes & FILE_ATTRIBUTE_REPARSE_POINT), "no reparse/junction path");
  }
  wchar_t volume[MAX_PATH]{}, filesystem[MAX_PATH]{};
  require(GetVolumePathNameW(path.c_str(), volume, MAX_PATH) != 0, "volume path");
  require(GetVolumeInformationW(volume, nullptr, 0, nullptr, nullptr, nullptr, filesystem, MAX_PATH) != 0, "filesystem");
  require(_wcsicmp(filesystem, L"NTFS") == 0, "NTFS containment storage");
}
static void grant(const fs::path& path, PSID sid, DWORD rights, bool writable, ACCESS_MODE mode = GRANT_ACCESS) {
  regularPath(path);
  PACL oldAcl = nullptr, newAcl = nullptr;
  PSECURITY_DESCRIPTOR oldDescriptor = nullptr;
  DWORD code = GetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, &oldAcl, nullptr, &oldDescriptor);
  require(code == ERROR_SUCCESS && oldAcl != nullptr, "existing non-null DACL");
  EXPLICIT_ACCESSW access{};
  access.grfAccessPermissions = rights; access.grfAccessMode = mode;
  access.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
  access.Trustee.TrusteeForm = TRUSTEE_IS_SID; access.Trustee.TrusteeType = TRUSTEE_IS_GROUP;
  access.Trustee.ptstrName = static_cast<LPWSTR>(sid);
  code = SetEntriesInAclW(1, &access, oldAcl, &newAcl);
  if (code == ERROR_SUCCESS) code = SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, nullptr, nullptr, newAcl, nullptr);
  if (newAcl) LocalFree(newAcl); LocalFree(oldDescriptor);
  require(code == ERROR_SUCCESS, "per-container filesystem DACL");
  if (writable) {
    PSECURITY_DESCRIPTOR label = nullptr; PACL sacl = nullptr; BOOL present = FALSE, defaulted = FALSE;
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(L"S:(ML;OICI;NW;;;LW)", SDDL_REVISION_1, &label, nullptr) != 0, "low integrity label");
    require(GetSecurityDescriptorSacl(label, &present, &sacl, &defaulted) != 0 && present, "integrity SACL");
    code = SetNamedSecurityInfoW(const_cast<LPWSTR>(path.c_str()), SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, nullptr, nullptr, nullptr, sacl);
    LocalFree(label); require(code == ERROR_SUCCESS, "profile integrity label");
  }
}
static void noLoopbackExemption(PSID sid) {
  wchar_t system[MAX_PATH]{};
  require(GetSystemDirectoryW(system, MAX_PATH) != 0, "system directory");
  HMODULE library = LoadLibraryExW((fs::path(system) / "FirewallAPI.dll").c_str(), nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
  require(library != nullptr, "Windows network isolation API");
  using Query = DWORD(WINAPI*)(DWORD*, PSID_AND_ATTRIBUTES*);
  auto query = reinterpret_cast<Query>(GetProcAddress(library, "NetworkIsolationGetAppContainerConfig"));
  DWORD count = 0; PSID_AND_ATTRIBUTES sids = nullptr;
  DWORD code = query ? query(&count, &sids) : ERROR_PROC_NOT_FOUND;
  bool exempt = false;
  if (code == ERROR_SUCCESS) for (DWORD i = 0; i < count; ++i) if (EqualSid(sid, sids[i].Sid)) exempt = true;
  if (sids) { for (DWORD i = 0; i < count; ++i) HeapFree(GetProcessHeap(), 0, sids[i].Sid); HeapFree(GetProcessHeap(), 0, sids); }
  FreeLibrary(library);
  require(code == ERROR_SUCCESS && !exempt, "no AppContainer loopback exemption");
}
static void tokenProof(HANDLE process) {
  Handle token; require(OpenProcessToken(process, TOKEN_QUERY, &token.value) != 0, "query child token");
  DWORD count = 0, value = 0;
  require(GetTokenInformation(token.value, TokenIsAppContainer, &value, sizeof(value), &count) != 0 && value == 1, "AppContainer token");
  value = 0;
  require(GetTokenInformation(token.value, TokenIsLessPrivilegedAppContainer, &value, sizeof(value), &count) != 0 && value == 1, "LPAC token");
  GetTokenInformation(token.value, TokenCapabilities, nullptr, 0, &count);
  std::vector<BYTE> bytes(count);
  require(GetTokenInformation(token.value, TokenCapabilities, bytes.data(), count, &count) != 0, "capability query");
  require(reinterpret_cast<TOKEN_GROUPS*>(bytes.data())->GroupCount == 0, "no extra device/network capabilities");
}
static std::wstring quote(const std::wstring& value) {
  std::wstring result = L"\""; unsigned slashes = 0;
  for (wchar_t c : value) {
    if (c == L'\\') { ++slashes; continue; }
    result.append(c == L'"' ? slashes * 2 + 1 : slashes, L'\\');
    result += c; slashes = 0;
  }
  result.append(slashes * 2, L'\\'); return result + L"\"";
}
struct Session {
  Handle job, process;
  PSID sid = nullptr;
  std::vector<BYTE> attributes;
  bool attributesInitialized = false;
  std::thread stdoutReader, stderrReader;
  ~Session() {
    if (job.value) TerminateJobObject(job.value, 125);
    if (stdoutReader.joinable()) stdoutReader.join();
    if (stderrReader.joinable()) stderrReader.join();
    if (attributesInitialized) DeleteProcThreadAttributeList(reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data()));
    if (sid) FreeSid(sid);
  }
  void launch(const std::wstring& moniker, const fs::path& executable, const std::vector<fs::path>& readRoots,
    const fs::path& profile, const std::vector<std::wstring>& args, bool readonlyWorkingDirectory = false) {
    if (moniker.size() > 64 || moniker.find_first_not_of(L"abcdefghijklmnopqrstuvwxyz0123456789.-") != std::wstring::npos) throw std::runtime_error("Invalid container moniker.");
    regularPath(executable); regularPath(profile);
    HRESULT hr = CreateAppContainerProfile(moniker.c_str(), L"Arena game", L"Isolated Arena game; no network capabilities", nullptr, 0, &sid);
    if (hr == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) hr = DeriveAppContainerSidFromAppContainerName(moniker.c_str(), &sid);
    require(SUCCEEDED(hr), "AppContainer profile"); noLoopbackExemption(sid);
    grant(executable, sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, false);
    for (const auto& root : readRoots) grant(root, sid, FILE_GENERIC_READ | FILE_GENERIC_EXECUTE, false);
    grant(profile, sid, FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | FILE_DELETE_CHILD, true);
    job.value = CreateJobObjectW(nullptr, nullptr); require(job.value != nullptr, "Job object");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
    limits.BasicLimitInformation.ActiveProcessLimit = 16; limits.ProcessMemoryLimit = 512ULL * 1024 * 1024; limits.JobMemoryLimit = 1024ULL * 1024 * 1024;
    require(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != 0, "hard process/memory limits");
    JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu{}; cpu.ControlFlags = JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP; cpu.CpuRate = 2500;
    require(SetInformationJobObject(job.value, JobObjectCpuRateControlInformation, &cpu, sizeof(cpu)) != 0, "CPU cap");
    JOBOBJECT_BASIC_UI_RESTRICTIONS ui{}; ui.UIRestrictionsClass = JOB_OBJECT_UILIMIT_READCLIPBOARD | JOB_OBJECT_UILIMIT_WRITECLIPBOARD | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS | JOB_OBJECT_UILIMIT_EXITWINDOWS | JOB_OBJECT_UILIMIT_DESKTOP | JOB_OBJECT_UILIMIT_HANDLES | JOB_OBJECT_UILIMIT_GLOBALATOMS;
    require(SetInformationJobObject(job.value, JobObjectBasicUIRestrictions, &ui, sizeof(ui)) != 0, "desktop/clipboard restrictions");
    SECURITY_ATTRIBUTES inherit{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
    Handle outRead, outWrite, errRead, errWrite;
    require(CreatePipe(&outRead.value, &outWrite.value, &inherit, 0) != 0 && CreatePipe(&errRead.value, &errWrite.value, &inherit, 0) != 0, "log pipes");
    require(SetHandleInformation(outRead.value, HANDLE_FLAG_INHERIT, 0) != 0 && SetHandleInformation(errRead.value, HANDLE_FLAG_INHERIT, 0) != 0, "log handle isolation");
    Handle input(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &inherit, OPEN_EXISTING, 0, nullptr));
    require(input.value != INVALID_HANDLE_VALUE, "null game input");
    HANDLE handles[]{outWrite.value, errWrite.value, input.value};
    SIZE_T size = 0; InitializeProcThreadAttributeList(nullptr, 3, 0, &size); attributes.resize(size);
    auto list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attributes.data());
    require(InitializeProcThreadAttributeList(list, 3, 0, &size) != 0, "startup attributes"); attributesInitialized = true;
    SECURITY_CAPABILITIES capabilities{}; capabilities.AppContainerSid = sid;
    DWORD policy = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
    require(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities, sizeof(capabilities), nullptr, nullptr) != 0, "LPAC identity");
    require(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, &policy, sizeof(policy), nullptr, nullptr) != 0, "LPAC restrictions");
    require(UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof(handles), nullptr, nullptr) != 0, "explicit inherited handles");
    fs::create_directories(profile / "temp");
    wchar_t system[MAX_PATH]{}, windows[MAX_PATH]{};
    require(GetSystemDirectoryW(system, MAX_PATH) && GetWindowsDirectoryW(windows, MAX_PATH), "Windows directories");
    std::wstring dllSearch = system;
    for (const auto& root : readRoots) {
      require(root.wstring().find(L';') == std::wstring::npos, "Managed runtime path cannot contain a PATH separator");
      dllSearch += L";" + root.wstring() + L";" + (root / "bin").wstring();
    }
    std::vector<std::wstring> variables{ L"APPDATA=" + profile.wstring(), L"ARENA_ARCADE_PROFILE=" + profile.wstring(), L"LOCALAPPDATA=" + profile.wstring(),
      L"PATH=" + dllSearch, L"SystemRoot=" + std::wstring(windows), L"TEMP=" + (profile / "temp").wstring(), L"TMP=" + (profile / "temp").wstring(), L"USERPROFILE=" + profile.wstring(), L"WINDIR=" + std::wstring(windows) };
    std::vector<wchar_t> environment;
    for (const auto& variable : variables) { environment.insert(environment.end(), variable.begin(), variable.end()); environment.push_back(0); }
    environment.push_back(0);
    std::wstring command = quote(executable.wstring()); for (const auto& arg : args) command += L" " + quote(arg);
    STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = list;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES; startup.StartupInfo.hStdOutput = outWrite.value; startup.StartupInfo.hStdError = errWrite.value; startup.StartupInfo.hStdInput = input.value;
    PROCESS_INFORMATION child{};
    const fs::path workingDirectory = readonlyWorkingDirectory ? executable.parent_path() : profile;
    require(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE, CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, environment.data(), workingDirectory.c_str(), &startup.StartupInfo, &child) != 0, "LPAC process creation");
    process.value = child.hProcess; Handle thread(child.hThread);
    // Only the child owns writers after creation. Close our copies before
    // starting readers, including paths where Job/token/resume checks fail.
    CloseHandle(outWrite.value); outWrite.value = nullptr;
    CloseHandle(errWrite.value); errWrite.value = nullptr;
    try { require(AssignProcessToJobObject(job.value, process.value) != 0, "assign suspended child to Job"); tokenProof(process.value); }
    catch (...) { TerminateProcess(process.value, 125); throw; }
    auto pump = [](HANDLE pipe, const char* channel) {
      Handle owned(pipe); char bytes[4096]; DWORD count = 0; size_t total = 0; bool truncated = false;
      while (ReadFile(owned.value, bytes, sizeof(bytes), &count, nullptr) && count) {
        if (total + count <= 128 * 1024) event("{\"event\":\"log\",\"channel\":\"" + std::string(channel) + "\",\"text\":" + json(std::string(bytes, count)) + "}");
        else if (!truncated) { event("{\"event\":\"log-truncated\"}"); truncated = true; }
        total += count;
      }
    };
    stdoutReader = std::thread(pump, outRead.value, "stdout"); outRead.value = nullptr;
    stderrReader = std::thread(pump, errRead.value, "stderr"); errRead.value = nullptr;
    require(ResumeThread(thread.value) != static_cast<DWORD>(-1), "resume isolated child");
    event("{\"event\":\"isolated\",\"pid\":" + std::to_string(child.dwProcessId) + ",\"backend\":\"windows-lpac-job-v1\"}");
  }
};
static bool denied(const fs::path& filename, DWORD rights) {
  Handle handle(CreateFileW(filename.c_str(), rights, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, 0, nullptr));
  return handle.value == INVALID_HANDLE_VALUE && GetLastError() == ERROR_ACCESS_DENIED;
}
static int childProbe(int argc, wchar_t** argv) {
  if (argc != 5) return 60;
  try {
    tokenProof(GetCurrentProcess());
    if (!denied(argv[3], GENERIC_READ) || !denied(argv[3], GENERIC_WRITE) || !denied(argv[3], WRITE_DAC)) return 61;
    Handle writable(CreateFileW((fs::path(argv[2]) / "probe-save").c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, 0, nullptr));
    if (writable.value == INVALID_HANDLE_VALUE) return 62;
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info{};
    if (!QueryInformationJobObject(nullptr, JobObjectExtendedLimitInformation, &info, sizeof(info), nullptr) ||
      !(info.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) || info.BasicLimitInformation.ActiveProcessLimit != 16) return 63;
    if (info.ProcessMemoryLimit != 512ULL * 1024 * 1024 || info.JobMemoryLimit != 1024ULL * 1024 * 1024) return 67;
    void* excessive = VirtualAlloc(nullptr, 768ULL * 1024 * 1024, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE);
    if (excessive) { VirtualFree(excessive, 0, MEM_RELEASE); return 68; }
    JOBOBJECT_CPU_RATE_CONTROL_INFORMATION cpu{};
    if (!QueryInformationJobObject(nullptr, JobObjectCpuRateControlInformation, &cpu, sizeof(cpu), nullptr) ||
      cpu.CpuRate != 2500 || !(cpu.ControlFlags & JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP)) return 69;
    WSADATA data{}; if (WSAStartup(MAKEWORD(2, 2), &data)) return 64;
    SOCKET client = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    sockaddr_in address{}; address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK); address.sin_port = htons(static_cast<u_short>(_wtoi(argv[4])));
    int result = connect(client, reinterpret_cast<sockaddr*>(&address), sizeof(address)); int code = WSAGetLastError();
    closesocket(client); WSACleanup();
    if (result != SOCKET_ERROR || code != WSAEACCES) return 65;
    wchar_t self[32768]{}; if (!GetModuleFileNameW(nullptr, self, 32768)) return 70;
    std::wstring command = quote(self) + L" probe-descendant";
    STARTUPINFOW startup{}; startup.cb = sizeof(startup); PROCESS_INFORMATION child{};
    if (!CreateProcessW(self, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, argv[2], &startup, &child)) return 71;
    Handle process(child.hProcess), thread(child.hThread);
    tokenProof(process.value);
    BOOL inJob = FALSE; if (!IsProcessInJob(process.value, nullptr, &inJob) || !inJob) return 72;
    std::ofstream pid(fs::path(argv[2]) / "descendant-pid"); pid << child.dwProcessId; if (!pid) return 73;
    return 0;
  } catch (...) { return 66; }
}
struct ProbeCleanup {
  std::wstring moniker;
  fs::path executable, writable, canary;
  bool done = false;
  void clear() {
    PSID sid = nullptr;
    require(SUCCEEDED(DeriveAppContainerSidFromAppContainerName(moniker.c_str(), &sid)), "probe cleanup SID");
    try { grant(executable, sid, 0, false, REVOKE_ACCESS); } catch (...) { FreeSid(sid); throw; }
    FreeSid(sid);
    HRESULT result = DeleteAppContainerProfile(moniker.c_str());
    require(SUCCEEDED(result) || result == HRESULT_FROM_WIN32(ERROR_NOT_FOUND) || result == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND), "probe profile cleanup");
    fs::remove_all(writable); fs::remove(canary); done = true;
  }
  ~ProbeCleanup() {
    if (!done) try { clear(); } catch (...) { event("{\"event\":\"warning\",\"message\":\"Probe metadata cleanup needs review; no successful containment proof was recorded.\"}"); }
  }
};
int wmain(int argc, wchar_t** argv) {
  if (argc > 1 && std::wstring(argv[1]) == L"probe-child") return childProbe(argc, argv);
  if (argc == 2 && std::wstring(argv[1]) == L"probe-descendant") {
    try { tokenProof(GetCurrentProcess()); Sleep(INFINITE); return 0; } catch (...) { return 74; }
  }
  try {
    if (argc == 3 && std::wstring(argv[1]) == L"probe") {
      fs::path root(argv[2]); regularPath(root);
      fs::path writable = root / "probe-writable"; fs::create_directories(writable);
      fs::path canary = root / "probe-host-private";
      { Handle file(CreateFileW(canary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, 0, nullptr)); require(file.value != INVALID_HANDLE_VALUE, "probe canary"); }
      WSADATA data{}; require(WSAStartup(MAKEWORD(2, 2), &data) == 0, "network probe initialization");
      SOCKET listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
      sockaddr_in address{}; address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
      require(bind(listener, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != SOCKET_ERROR && listen(listener, 1) != SOCKET_ERROR, "live loopback probe");
      int size = sizeof(address); require(getsockname(listener, reinterpret_cast<sockaddr*>(&address), &size) == 0, "probe endpoint");
      wchar_t self[32768]{}; require(GetModuleFileNameW(nullptr, self, 32768) != 0, "probe executable");
      std::wstring moniker = L"arena.arcade.probe." + std::to_wstring(GetCurrentProcessId()) + L"." + std::to_wstring(GetTickCount64());
      ProbeCleanup cleanup{moniker, self, writable, canary};
      DWORD code = 1; Handle descendant;
      { Session session; session.launch(moniker, self, {}, writable, {L"probe-child", writable.wstring(), canary.wstring(), std::to_wstring(ntohs(address.sin_port))});
        require(WaitForSingleObject(session.process.value, 15000) == WAIT_OBJECT_0, "probe timeout");
        require(GetExitCodeProcess(session.process.value, &code) != 0, "probe exit status");
        if (code == 0) {
          DWORD pid = 0; std::ifstream input(writable / "descendant-pid"); input >> pid;
          require(pid != 0, "descendant evidence");
          descendant.value = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
          BOOL member = FALSE;
          require(descendant.value && IsProcessInJob(descendant.value, session.job.value, &member) && member &&
            WaitForSingleObject(descendant.value, 0) == WAIT_TIMEOUT, "live owned descendant");
        }
      }
      if (code == 0) require(WaitForSingleObject(descendant.value, 5000) == WAIT_OBJECT_0, "actual descendant cleanup");
      if (descendant.value) { CloseHandle(descendant.value); descendant.value = nullptr; }
      closesocket(listener); WSACleanup(); cleanup.clear();
      if (code != 0) throw std::runtime_error("Live LPAC containment probe failed; child=" + std::to_string(code));
      event("{\"event\":\"probe\",\"passed\":true,\"backend\":\"windows-lpac-job-v1\",\"filesystem\":true,\"loopbackDenied\":true,\"restrictedToken\":true,\"jobLimits\":true,\"descendantCleanup\":true,\"overLimitMemoryDenied\":true}");
      return 0;
    }
    if (argc >= 8 && (std::wstring(argv[1]) == L"run" || std::wstring(argv[1]) == L"play")) {
      std::vector<fs::path> roots{argv[4], argv[5]};
      int separator = 7;
      while (separator + 1 < argc && std::wstring(argv[separator]) == L"--read-root") {
        require(roots.size() < 6, "too many pinned runtime roots");
        roots.emplace_back(argv[separator + 1]); separator += 2;
      }
      require(separator < argc && std::wstring(argv[separator]) == L"--", "structured runtime argument separator");
      std::vector<std::wstring> args; for (int i = separator + 1; i < argc; i++) args.emplace_back(argv[i]);
      Session session; session.launch(argv[2], argv[3], roots, argv[6], args, std::wstring(argv[1]) == L"play");
      // Poll only the private parent pipe. No detached reader can outlive this
      // session, and EOF stops the Job rather than orphaning a game.
      std::string command;
      while (true) {
        DWORD result = WaitForSingleObject(session.process.value, 100);
        if (result == WAIT_OBJECT_0) break;
        require(result == WAIT_TIMEOUT, "process supervision");
        DWORD available = 0;
        bool stop = !PeekNamedPipe(GetStdHandle(STD_INPUT_HANDLE), nullptr, 0, nullptr, &available, nullptr);
        if (!stop && available) {
          char buffer[64]; DWORD read = 0;
          require(ReadFile(GetStdHandle(STD_INPUT_HANDLE), buffer, std::min(available, static_cast<DWORD>(sizeof(buffer))), &read, nullptr) != 0, "parent control pipe");
          command.append(buffer, read);
          if (command.size() > 64 || command.find('\n') != std::string::npos) stop = true;
        }
        if (stop) {
          // Close only this Job's windows, allowing games to save before the
          // bounded forced-stop fallback. Never post to an arbitrary host PID.
          EnumWindows([](HWND window, LPARAM data) -> BOOL {
            DWORD pid = 0; GetWindowThreadProcessId(window, &pid);
            Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
            BOOL member = FALSE;
            if (process.value && IsProcessInJob(process.value, reinterpret_cast<HANDLE>(data), &member) && member) PostMessageW(window, WM_CLOSE, 0, 0);
            return TRUE;
          }, reinterpret_cast<LPARAM>(session.job.value));
          const bool forced = WaitForSingleObject(session.process.value, 5000) != WAIT_OBJECT_0;
          if (forced) require(TerminateJobObject(session.job.value, 0) != 0, "stop job");
          event(std::string("{\"event\":\"stop\",\"forced\":") + (forced ? "true}" : "false}"));
          break;
        }
      }
      require(WaitForSingleObject(session.process.value, 8000) == WAIT_OBJECT_0, "confirm game exit");
      DWORD code = 1; require(GetExitCodeProcess(session.process.value, &code) != 0, "game exit code");
      // The primary process exiting is not proof that all descendants stopped.
      // In particular, owner-side build postprocessing must not race a child
      // still changing the writable tree. Fail closed unless the Job drains.
      require(TerminateJobObject(session.job.value, code) != 0, "stop owned descendants");
      const ULONGLONG drainDeadline = GetTickCount64() + 5000;
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
      do {
        require(QueryInformationJobObject(session.job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr) != 0, "query owned descendants");
        if (accounting.ActiveProcesses == 0) break;
        Sleep(10);
      } while (GetTickCount64() < drainDeadline);
      require(accounting.ActiveProcesses == 0, "confirm all owned descendants stopped");
      event("{\"event\":\"exited\",\"code\":" + std::to_string(code) + "}");
      return code == 0 ? 0 : 1;
    }
    throw std::runtime_error("Expected probe <private-root> or run <moniker> <exe> <install> <runtime> <profile> -- <args>.");
  } catch (const std::exception& error) { event("{\"event\":\"error\",\"message\":" + json(error.what()) + "}"); return 1; }
}
