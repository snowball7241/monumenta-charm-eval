#!/bin/bash
# Installs (or updates) the Charm Evaluator web app on macOS: the latest mtce release for this Mac, the web front end, and a
# private copy of Node.js, all in one folder. No admin rights, Homebrew or developer tools needed.
#
#   curl -fsSL https://github.com/snowball7241/monumenta-charm-eval/releases/latest/download/install-mac.sh | bash
#
# Run it again to update. To uninstall, delete the install folder and the "Charm Evaluator" launcher on the Desktop.
#
# Environment overrides (mostly for testing): MTCE_REPO (owner/name), MTCE_VERSION (release tag), MTCE_BASE_URL (where the
# release files are), MTCE_HOME (install folder), MTCE_NO_SHORTCUT=1, MTCE_NO_START=1.
set -euo pipefail

REPO="${MTCE_REPO:-snowball7241/monumenta-charm-eval}"
DEST="${MTCE_HOME:-$HOME/Applications/Charm Evaluator}"
NODE_VERSION="22.23.5"
MIN_MACOS="13.3" # the release binaries' minimum (see build-release.sh)

say() { printf '\033[1m==>\033[0m %s\n' "$*"; }
fail() {
    printf '\033[31merror:\033[0m %s\n' "$*" >&2
    exit 1
}

[[ "$(uname -s)" == "Darwin" ]] || fail "this installer is for macOS (use install-windows.bat on Windows)"

# --- what to download for this Mac
version_ge() { [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -1)" == "$2" ]]; }
macos=$(sw_vers -productVersion)
version_ge "$macos" "$MIN_MACOS" || fail "needs macOS $MIN_MACOS or newer (this Mac has $macos)"

arch=$(uname -m)
# a Terminal running under Rosetta reports x86_64 on Apple Silicon; prefer the native build
if [[ "$arch" == "x86_64" && "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" == "1" ]]; then
    arch=arm64
fi
case "$arch" in
arm64) node_platform=darwin-arm64 mtce_target=macos-arm64 ;;
x86_64) node_platform=darwin-x64 mtce_target=macos-x86_64 ;;
*) fail "unsupported CPU: $arch" ;;
esac

# --- which release
if [[ -n "${MTCE_VERSION:-}" ]]; then
    tag="$MTCE_VERSION"
else
    say "Looking up the latest release of $REPO"
    tag=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | sed -n 's/^ *"tag_name": *"\([^"]*\)".*/\1/p' | head -1) ||
        fail "could not find a release of $REPO on GitHub (none published yet, or no internet connection)"
    [[ -n "$tag" ]] || fail "could not find a release of $REPO on GitHub"
fi
base="${MTCE_BASE_URL:-https://github.com/$REPO/releases/download/$tag}"
node_dist="https://nodejs.org/dist/v$NODE_VERSION"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

fetch() { # url file
    curl -fL --retry 3 --progress-bar -o "$2" "$1" || fail "download failed: $1"
}
check_sha256() { # file sums-file name
    local want got
    want=$(awk -v n="$3" '$2 == n || $2 == "*"n {print $1}' "$2")
    [[ -n "$want" ]] || fail "no checksum for $3"
    got=$(shasum -a 256 "$1" | awk '{print $1}')
    [[ "$want" == "$got" ]] || fail "checksum mismatch for $3 (download corrupted or tampered with)"
}

mtce_archive="mtce-$tag-$mtce_target.tar.gz"
web_archive="mtce-web-$tag.zip"
node_archive="node-v$NODE_VERSION-$node_platform.tar.gz"

say "Downloading mtce $tag for $mtce_target"
fetch "$base/SHA256SUMS.txt" "$tmp/SHA256SUMS.txt"
fetch "$base/$mtce_archive" "$tmp/$mtce_archive"
check_sha256 "$tmp/$mtce_archive" "$tmp/SHA256SUMS.txt" "$mtce_archive"

say "Downloading the web front end"
fetch "$base/$web_archive" "$tmp/$web_archive"
check_sha256 "$tmp/$web_archive" "$tmp/SHA256SUMS.txt" "$web_archive"

if [[ -x "$DEST/node/bin/node" && "$("$DEST/node/bin/node" --version 2>/dev/null)" == "v$NODE_VERSION" ]]; then
    say "Node.js v$NODE_VERSION is already installed"
    node_ready=true
else
    say "Downloading Node.js v$NODE_VERSION"
    fetch "$node_dist/SHASUMS256.txt" "$tmp/node-SHASUMS256.txt"
    fetch "$node_dist/$node_archive" "$tmp/$node_archive"
    check_sha256 "$tmp/$node_archive" "$tmp/node-SHASUMS256.txt" "$node_archive"
    node_ready=false
fi

# --- unpack everything first, then swap it into place
say "Installing to $DEST"
mkdir -p "$tmp/mtce" "$tmp/webzip" "$DEST"
tar -xzf "$tmp/$mtce_archive" -C "$tmp/mtce" --strip-components 1
unzip -q "$tmp/$web_archive" -d "$tmp/webzip"
mv "$tmp/webzip/mtce-web-$tag" "$tmp/web" 2>/dev/null || fail "unexpected layout in $web_archive"
[[ -x "$tmp/mtce/mtce" && -f "$tmp/web/web.mjs" && -f "$tmp/web/web/index.html" ]] || fail "release files are not in the expected layout"

if ! $node_ready; then
    mkdir -p "$tmp/node"
    tar -xzf "$tmp/$node_archive" -C "$tmp/node" --strip-components 1
    rm -rf "$DEST/node"
    mv "$tmp/node" "$DEST/node"
fi

cp "$tmp/mtce/mtce" "$DEST/mtce"
cp "$tmp/mtce/LICENSE" "$DEST/LICENSE"
cp "$tmp/mtce/README.md" "$DEST/README.md"
cp "$tmp/mtce/example.conf" "$DEST/example.conf"
rm -rf "$DEST/web"
cp -R "$tmp/web/web" "$DEST/web"
cp "$tmp/web/web.mjs" "$DEST/web.mjs"
echo "$tag" >"$DEST/VERSION"

# remove a download quarantine flag if anything carried one (curl does not set it, but a copied folder might)
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

"$DEST/mtce" --version >/dev/null || fail "the installed mtce does not run on this Mac"

# --- launchers: double-click to start the server and open the page
launcher="$DEST/Charm Evaluator.command"
cat >"$launcher" <<'EOF'
#!/bin/bash
# Starts the Charm Evaluator and opens it in your browser. Close this window (or press Ctrl+C) to stop it.
cd "$(dirname "$0")" || exit 1
exec ./node/bin/node web.mjs --mtce ./mtce --open
EOF
chmod +x "$launcher"

if [[ -z "${MTCE_NO_SHORTCUT:-}" && -d "$HOME/Desktop" ]]; then
    desktop="$HOME/Desktop/Charm Evaluator.command"
    printf '#!/bin/bash\nexec "%s"\n' "$launcher" >"$desktop"
    chmod +x "$desktop"
    say "Added \"Charm Evaluator\" to your Desktop: double-click it to start"
fi

say "Installed mtce $tag"
if [[ -z "${MTCE_NO_START:-}" ]]; then
    say "Starting it now (close this window or press Ctrl+C to stop)"
    exec "$launcher"
fi
