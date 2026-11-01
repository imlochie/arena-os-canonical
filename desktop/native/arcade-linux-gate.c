// Trusted launcher only. Block before sandbox setup until the owner has attached
// this process to its unique cgroup. Never inherit elevated ambient capabilities.
#define _GNU_SOURCE
#include <linux/capability.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
  if (argc < 3 || argv[2][0] != '/' ||
      (strcmp(argv[1], "--gated") && strcmp(argv[1], "--reset"))) return 64;
  if (!strcmp(argv[1], "--gated")) {
    char grant = 0;
    if (read(STDIN_FILENO, &grant, 1) != 1 || grant != 'G') return 65;
  }
  struct __user_cap_header_struct header = { _LINUX_CAPABILITY_VERSION_3, 0 };
  struct __user_cap_data_struct capabilities[2] = {{0}};
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
      prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) ||
      syscall(SYS_capset, &header, capabilities)) {
    perror("Cannot clear launcher privileges"); return 66;
  }
  execv(argv[2], argv + 2);
  perror("Cannot enter isolated supervisor"); return 67;
}
