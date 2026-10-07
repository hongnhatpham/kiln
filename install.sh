#!/bin/sh
# Install Kiln with the Linux package manager or in ~/Applications on macOS.
set -eu

release_url=https://github.com/hongnhatpham/kiln/releases/latest/download
dry_run=false
platform_override=
arch_override=
fail() { printf 'Kiln: %s\n' "$*" >&2; exit 1; }
usage() {
    printf '%s\n' 'Usage: sh install.sh [--dry-run [--platform macos|linux] [--arch x64|arm64]]'
}
while [ "$#" -gt 0 ]; do
    case "$1" in
        --dry-run) dry_run=true ;;
        --platform|--arch)
            [ "$#" -ge 2 ] || fail "Missing value for $1"
            case "$1" in --platform) platform_override=$2 ;; --arch) arch_override=$2 ;; esac
            shift ;;
        --help|-h) usage; exit 0 ;;
        *) usage >&2; fail "Unknown option: $1" ;;
    esac
    shift
done
if [ -n "$platform_override$arch_override" ] && [ "$dry_run" != true ]; then
    fail '--platform and --arch are only supported with --dry-run.'
fi
case "${platform_override:-$(uname -s)}" in
    Darwin|macos) platform=macos ;;
    Linux|linux) platform=linux ;;
    *) fail 'This installer supports macOS and Linux. Use install.ps1 on Windows.' ;;
esac
case "${arch_override:-$(uname -m)}" in
    x86_64|amd64|x64) arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) fail 'This processor architecture is not supported.' ;;
esac
case "$platform" in
    macos)
        [ -n "${HOME:-}" ] && [ "$HOME" != / ] || fail 'HOME must point to your user directory.'
        asset="Kiln-macOS-$arch.zip"
        install_dir="$HOME/Applications"
        target="$install_dir/Kiln.app"
        marker="$install_dir/.kiln-install"
        ;;
    linux)
        [ "$arch" = x64 ] || fail 'Linux releases currently support x64 only.'
        if command -v apt-get >/dev/null 2>&1; then
            package_manager=apt-get
            asset=Kiln-Linux-x64.deb
        elif command -v dnf >/dev/null 2>&1; then
            package_manager=dnf
            asset=Kiln-Linux-x64.rpm
        elif command -v zypper >/dev/null 2>&1; then
            package_manager=zypper
            asset=Kiln-Linux-x64.rpm
        else
            fail 'No supported package manager found. Use Debian/Ubuntu (apt-get), Fedora/RHEL (dnf), or openSUSE (zypper).'
        fi
        ;;
esac
# Preserve the macOS installation path validation.
case "${target:-}" in *"
"*|*"$(printf '\r')"*) fail 'Installation paths must not contain line breaks.' ;; esac
if [ "$dry_run" = true ]; then
    printf 'Would download and verify: %s/%s\n' "$release_url" "$asset"
    if [ "$platform" = linux ]; then
        printf 'Would install with: %s install <download-directory>/%s\n' "$package_manager" "$asset"
        printf '%s\n' 'The native package manages the applications menu entry, updates, and uninstall.'
    else
        printf 'Would install: %s\n' "$target"
    fi
    exit 0
fi
command -v curl >/dev/null 2>&1 || fail 'Please install curl and try again.'
if [ "$platform" = macos ]; then
    command -v ditto >/dev/null 2>&1 || fail 'The macOS ditto tool is required.'
    command -v shasum >/dev/null 2>&1 || fail 'The macOS shasum tool is required.'
else
    command -v sha256sum >/dev/null 2>&1 || fail 'Please install sha256sum and try again.'
fi
if [ "$platform" = macos ]; then
    [ ! -L "$install_dir" ] && [ ! -L "$target" ] && [ ! -L "$marker" ] || fail 'Installation destination must not be a symbolic link.'
    if [ -e "$marker" ]; then
        [ -f "$marker" ] && [ "$(cat "$marker")" = kiln-installer-v1 ] || fail "Unrecognized installation marker: $marker"
    fi
    if [ -e "$target" ]; then
        [ -f "$marker" ] && [ "$(cat "$marker")" = kiln-installer-v1 ] || fail "An existing unmanaged installation is present: $target"
    fi
fi
stage=$(mktemp -d "${TMPDIR:-/tmp}/kiln-install.XXXXXXXX")
# Package managers require an absolute path to the downloaded local package.
if [ "$platform" = linux ]; then stage=$(cd "$stage" && pwd); fi
pending=
backup=
cleanup() {
    [ -z "$pending" ] || rm -rf "$pending"
    # Restore the previous bundle if placing the new bundle failed.
    if [ -n "$backup" ] && [ -e "$backup" ] && [ ! -e "$target" ]; then mv "$backup" "$target"; fi
    rm -rf "$stage"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
printf '%s\n' 'Downloading Kiln...'
curl --fail --location --retry 3 --output "$stage/$asset" "$release_url/$asset"
curl --fail --location --retry 3 --output "$stage/SHA256SUMS.txt" "$release_url/SHA256SUMS.txt"
verify_download() {
    expected=$(awk -v asset="$1" '$2 == asset || $2 == "*" asset { if (length($1) == 64 && $1 !~ /[^0-9a-fA-F]/) { print tolower($1); count++ } } END { if (count != 1) exit 1 }' "$stage/SHA256SUMS.txt") || fail "The release checksum is missing or ambiguous: $1"
    if [ "$platform" = macos ]; then actual=$(shasum -a 256 "$stage/$1" | awk '{print $1}');
    else actual=$(sha256sum "$stage/$1" | awk '{print $1}'); fi
    [ "$actual" = "$expected" ] || fail "Release checksum verification failed: $1. Your existing installation has not been changed."
}
verify_download "$asset"
printf '%s\n' 'Release checksum verified.'
if [ "$platform" = macos ]; then
    mkdir -p "$install_dir"
    ditto -x -k "$stage/$asset" "$stage/unpacked"
    bundle="$stage/unpacked/Kiln.app"
    [ -d "$bundle/Contents/MacOS" ] && [ -f "$bundle/Contents/Info.plist" ] && [ ! -L "$bundle" ] || fail 'The release does not contain a valid Kiln.app bundle.'
    executable=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$bundle/Contents/Info.plist")
    case "$executable" in ''|*/*) fail 'The app bundle executable is invalid.' ;; esac
    [ -f "$bundle/Contents/MacOS/$executable" ] && [ -x "$bundle/Contents/MacOS/$executable" ] || fail 'The app bundle executable is missing.'
    pending=$(mktemp -d "$install_dir/.kiln-new.XXXXXXXX")
    ditto "$bundle" "$pending/Kiln.app"
    if [ -e "$target" ]; then
        backup=$(mktemp -d "$install_dir/.kiln-old.XXXXXXXX")
        rmdir "$backup"
        mv "$target" "$backup"
    fi
    mv "$pending/Kiln.app" "$target"
    rmdir "$pending"
    pending=
    printf '%s\n' kiln-installer-v1 > "$marker"
    if [ -n "$backup" ]; then rm -rf "$backup"; backup=; fi
    register=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
    if [ -x "$register" ]; then "$register" -f "$target" || true; fi
    printf '%s\n' 'Kiln is installed in ~/Applications. Open it from Applications or Spotlight.'
else
    if [ "$(id -u)" = 0 ]; then
        "$package_manager" install "$stage/$asset"
    else
        command -v sudo >/dev/null 2>&1 || fail 'Please install sudo or run this installer as root.'
        sudo "$package_manager" install "$stage/$asset"
    fi
    printf '%s\n' 'Kiln is installed. Open Kiln from your applications menu. Use your package manager to update or uninstall it.'
fi
