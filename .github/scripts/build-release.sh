#!/usr/bin/env bash
# Builds a portable mtce release binary for one target, smoke-tests it when it can run here, and packages it with the
# README and LICENSE (GPL-3.0: binaries ship alongside the license, and the source is the repository they come from).
#
# usage: .github/scripts/build-release.sh <target> [version]
#   target: macos-arm64 | macos-x86_64 | linux-x86_64 | windows-x86_64
#   output: dist/mtce-<version>-<target>.tar.gz (.zip on Windows)
#
# Portability choices (see README "Prebuilt binaries"):
#   - x86_64 targets x86-64-v3 (AVX2, ~every x86 CPU since 2015); arm64 macOS targets apple-m1 (all Apple Silicon).
#   - macOS: minimum 13.3 (std::format needs it); Linux: fully static, so it runs regardless of the distro's glibc/libstdc++;
#     Windows: static C/C++ runtime, so no Visual C++ redistributable is needed.
set -euo pipefail

target=${1:?usage: build-release.sh <target> [version]}
version=${2:-dev}
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
builddir="$root/build-release-$target"
stage="$root/dist/mtce-$version-$target"
macos_min=13.3

setup_args=(--buildtype=release --wipe)
exe=mtce
runnable=true
runner=()

case "$target" in
macos-arm64)
    setup_args+=(-Dcpp_args="-mcpu=apple-m1 -mmacosx-version-min=$macos_min" -Dcpp_link_args="-mmacosx-version-min=$macos_min")
    ;;
macos-x86_64)
    # cross-compile from Apple Silicon; the result runs here under Rosetta 2 when it is installed
    crossfile="$root/build-release-$target.cross.ini"
    cat >"$crossfile" <<EOF
[binaries]
c = 'clang'
cpp = 'clang++'
strip = 'strip'
[built-in options]
c_args = ['-arch', 'x86_64', '-mmacosx-version-min=$macos_min']
c_link_args = ['-arch', 'x86_64', '-mmacosx-version-min=$macos_min']
cpp_args = ['-arch', 'x86_64', '-march=x86-64-v3', '-mmacosx-version-min=$macos_min']
cpp_link_args = ['-arch', 'x86_64', '-mmacosx-version-min=$macos_min']
[host_machine]
system = 'darwin'
cpu_family = 'x86_64'
cpu = 'x86_64'
endian = 'little'
EOF
    setup_args+=(--cross-file "$crossfile")
    if arch -x86_64 /usr/bin/true 2>/dev/null; then runner=(arch -x86_64); else runnable=false; fi
    ;;
linux-x86_64)
    setup_args+=(-Dcpp_args="-march=x86-64-v3" -Dcpp_link_args="-static")
    ;;
windows-x86_64)
    # clang's GNU-style driver targeting MSVC: link the C/C++ runtime statically. Through meson's b_vscrt, not raw
    # -fms-runtime-lib flags: meson adds its own runtime flags (-fms-runtime-lib=dll, /nodefaultlib:libcmt) that would
    # contradict them and leave the program without a CRT entry point
    setup_args+=(-Db_vscrt=mt -Dcpp_args="-march=x86-64-v3")
    exe=mtce.exe
    ;;
*)
    echo "unknown target: $target" >&2
    exit 1
    ;;
esac

export CC=${CC:-clang} CXX=${CXX:-clang++}
echo "::group::configure + build ($target, $($CXX --version | head -1))"
meson setup "$builddir" "$root" "${setup_args[@]}"
ninja -C "$builddir"
echo "::endgroup::"

bin="$builddir/$exe"

echo "::group::inspect $exe"
case "$target" in
macos-*)
    lipo -archs "$bin"
    otool -l "$bin" | grep -A3 LC_BUILD_VERSION | grep minos
    otool -L "$bin"
    ;;
linux-*)
    file "$bin"
    if ldd "$bin" >/dev/null 2>&1; then
        echo "error: binary is dynamically linked" >&2
        exit 1
    fi
    ;;
windows-*)
    deps=$(llvm-objdump -p "$bin" | grep -i "DLL Name" || true)
    echo "$deps"
    if grep -qiE "msvcp|vcruntime|ucrtbase|api-ms-win-crt" <<<"$deps"; then
        echo "error: binary depends on the Visual C++ runtime DLLs (static runtime expected)" >&2
        exit 1
    fi
    ;;
esac
echo "::endgroup::"

if $runnable; then
    echo "::group::smoke test"
    ${runner[@]+"${runner[@]}"} "$bin" --version
    # the bundled sample predates some effect renames; drop those lines (mtce rejects unknown effects)
    samples="$builddir/smoke_charms.txt"
    grep -vE 'crushing_earth|focused_combos_bleed' "$root/samples/sample_charm_dataset.txt" >"$samples"
    out=$(${runner[@]+"${runner[@]}"} "$bin" --bot-mode --config "$root/samples/flame.conf" --in "$samples")
    echo "$out" | head -1
    # utility of the optimal flame set on the sample data; any build/platform must reproduce it exactly
    expected=9817283964947
    if [[ "$(echo "$out" | head -1 | tr -d '\r')" != "$expected" ]]; then
        echo "error: expected optimal utility $expected" >&2
        exit 1
    fi
    echo "::endgroup::"
else
    echo "skipping smoke test: $target binary cannot run on this machine"
fi

rm -rf "$stage"
mkdir -p "$stage"
cp "$bin" "$root/README.md" "$root/LICENSE" "$stage/"
cp "$root/samples/flame.conf" "$stage/example.conf"

cd "$root/dist"
if [[ "$target" == windows-* ]]; then
    archive="mtce-$version-$target.zip"
    rm -f "$archive"
    7z a -tzip "$archive" "mtce-$version-$target" >/dev/null
else
    archive="mtce-$version-$target.tar.gz"
    tar -czf "$archive" "mtce-$version-$target"
fi
echo "packaged dist/$archive"
