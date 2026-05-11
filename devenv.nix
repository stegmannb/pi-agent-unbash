{ pkgs, ... }:
{
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_22;
    corepack.enable = true;
    pnpm.enable = true;
  };

  packages = with pkgs; [
    git
    typescript
  ];

  enterShell = ''
    echo "pi-unbash devenv ready"
    echo "Use: pnpm install && pnpm test"
  '';

  enterTest = ''
    pnpm install --frozen-lockfile
    pnpm test
  '';
}
