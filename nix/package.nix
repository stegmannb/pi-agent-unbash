{
  stdenv,
  lib,
  pnpm,
  pnpmConfigHook,
  fetchPnpmDeps,
  nodejs,
  typescript,
  fetchFromGitHub,
}:
let
  packageJson = builtins.fromJSON (builtins.readFile ../package.json);

  unbashDist = stdenv.mkDerivation {
    pname = "unbash-dist";
    version = "2.2.0-combined-fixes";

    src = fetchFromGitHub {
      owner = "jdiamond";
      repo = "unbash";
      rev = "fd5f6dae2de314d4029450c5269f2f04b673f40a";
      hash = "sha256-Q5cISclAYL/WURK8c/FftlciZRPb4QYMeSrTPMk5MOg=";
    };

    nativeBuildInputs = [
      nodejs
      typescript
    ];

    dontConfigure = true;

    buildPhase = ''
      tsc -p tsconfig.json
    '';

    installPhase = ''
      cp -r dist "$out"
    '';
  };
in
stdenv.mkDerivation (finalAttrs: {
  pname = packageJson.name;
  version = packageJson.version;

  src = lib.cleanSource ../.;

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    fetcherVersion = 2;
    hash = "sha256-00RQ416yXHG6cmmywgv1LSuzZmSyjRk6yl4GWrsrLTM=";
  };

  nativeBuildInputs = [
    pnpm
    pnpmConfigHook
    nodejs
  ];

  prePnpmInstall = ''
    pnpmInstallFlags+=(--prod)
  '';

  preInstall = ''
    UNBASH_DIR=$(find node_modules/.pnpm -maxdepth 3 -path "*/node_modules/unbash" -type d | head -1)
    if [ -z "$UNBASH_DIR" ]; then
      echo "ERROR: could not find unbash in node_modules/.pnpm" >&2
      exit 1
    fi

    mkdir -p "$UNBASH_DIR/dist"
    cp -r ${unbashDist}/. "$UNBASH_DIR/dist/"
  '';

  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/unbash"
    cp -r . "$out/unbash/"

    runHook postInstall
  '';

  meta = {
    description = packageJson.description;
    homepage = packageJson.homepage;
    license = lib.licenses.mit;
    maintainers = [ ];
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
})
