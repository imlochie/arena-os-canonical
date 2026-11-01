# CI-only trusted admission tools. Wine and game payloads are intentionally not
# downloaded until the real host passes admission. No full workspace install.
let
  pkgs = import (builtins.fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/ac62194c3917d5f474c1a844b6fd6da2db95077d.tar.gz";
  }) { system = "x86_64-linux"; };
in pkgs.mkShell {
  packages = [ pkgs.nodejs_22 pkgs.gcc pkgs.coreutils pkgs.bubblewrap ];
}
