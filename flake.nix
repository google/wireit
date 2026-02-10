# Optional Nix (https://nixos.org) flake for development.
# Usage: `nix develop`, or just `cd` if direnv is set up.
{
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = {nixpkgs, ...}: let
    forAllSystems = nixpkgs.lib.genAttrs [
      "x86_64-linux"
      "aarch64-linux"
      "x86_64-darwin"
      "aarch64-darwin"
    ];
  in {
    devShells = forAllSystems (system: let
      pkgs = nixpkgs.legacyPackages.${system};

      # Needed by the VSCode extension test runner (Electron).
      electronLibs = pkgs.lib.makeLibraryPath [pkgs.gtk3];

      mkNodeShell = nodejs:
        pkgs.mkShell {
          packages = [nodejs];
          LD_LIBRARY_PATH = electronLibs;
        };
    in {
      default = mkNodeShell pkgs.nodejs_24;
      node20 = mkNodeShell pkgs.nodejs_20;
    });
  };
}
