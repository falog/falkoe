#!/usr/bin/env bash
# Build a minimal static FFmpeg binary for each Android ABI.
# Usage: ./scripts/build-ffmpeg-android.sh
#
# Prerequisites: Android NDK (auto-detected from $ANDROID_HOME/ndk/*),
#                make, git, pkg-config.
#
# Output: src-tauri/gen/android/app/src/main/jniLibs/<abi>/libffmpeg.so
#         (Named .so so Android extracts it to the native library directory.)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
JNILIBS_DIR="$PROJECT_ROOT/src-tauri/gen/android/app/src/main/jniLibs"

# --- Detect NDK ---
if [[ -n "${NDK_HOME:-}" && -d "$NDK_HOME" ]]; then
    NDK="$NDK_HOME"
elif [[ -n "${ANDROID_NDK_HOME:-}" && -d "$ANDROID_NDK_HOME" ]]; then
    NDK="$ANDROID_NDK_HOME"
elif [[ -n "${ANDROID_HOME:-}" ]]; then
    # Pick the latest NDK version installed.
    NDK="$(ls -dv "$ANDROID_HOME/ndk/"*/ 2>/dev/null | tail -n1 | sed 's:/$::')"
fi

if [[ -z "${NDK:-}" || ! -d "$NDK" ]]; then
    echo "ERROR: Android NDK not found. Set NDK_HOME, ANDROID_NDK_HOME, or install via sdkmanager." >&2
    exit 1
fi
echo "Using NDK: $NDK"

TOOLCHAIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64"
if [[ ! -d "$TOOLCHAIN" ]]; then
    echo "ERROR: NDK toolchain not found at $TOOLCHAIN" >&2
    exit 1
fi

# --- FFmpeg source ---
FFMPEG_VERSION="${FFMPEG_VERSION:-7.1}"
BUILD_BASE="/tmp/ffmpeg-android-build"
FFMPEG_SRC="$BUILD_BASE/ffmpeg-$FFMPEG_VERSION"

mkdir -p "$BUILD_BASE"
if [[ ! -d "$FFMPEG_SRC" ]]; then
    TARBALL="$BUILD_BASE/ffmpeg-${FFMPEG_VERSION}.tar.xz"
    if [[ ! -f "$TARBALL" ]]; then
        echo "Downloading FFmpeg $FFMPEG_VERSION ..."
        curl -L "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" -o "$TARBALL"
    fi
    echo "Extracting ..."
    tar -xf "$TARBALL" -C "$BUILD_BASE"
fi

# --- x264 source (GPL, needed for H.264 encoding) ---
X264_SRC="$BUILD_BASE/x264"
if [[ ! -d "$X264_SRC" ]]; then
    echo "Cloning x264 ..."
    git clone --depth 1 https://code.videolan.org/videolan/x264.git "$X264_SRC"
fi

# --- freetype source (needed for drawtext filter) ---
FREETYPE_VERSION="${FREETYPE_VERSION:-2.13.3}"
FREETYPE_SRC="$BUILD_BASE/freetype-$FREETYPE_VERSION"
if [[ ! -d "$FREETYPE_SRC" ]]; then
    FREETYPE_TARBALL="$BUILD_BASE/freetype-${FREETYPE_VERSION}.tar.xz"
    if [[ ! -f "$FREETYPE_TARBALL" ]]; then
        echo "Downloading freetype $FREETYPE_VERSION ..."
        curl -L "https://download.savannah.gnu.org/releases/freetype/freetype-${FREETYPE_VERSION}.tar.xz" \
            -o "$FREETYPE_TARBALL"
    fi
    echo "Extracting freetype ..."
    tar -xf "$FREETYPE_TARBALL" -C "$BUILD_BASE"
fi

# --- API level (must match Tauri minSdkVersion) ---
API=26

# --- ABIs to build ---
# Map: ABI -> (arch, triple, cc-prefix)
declare -A ABI_ARCH=(
    [arm64-v8a]=aarch64
    [armeabi-v7a]=arm
    [x86]=i686
    [x86_64]=x86_64
)
declare -A ABI_TRIPLE=(
    [arm64-v8a]=aarch64-linux-android
    [armeabi-v7a]=armv7a-linux-androideabi
    [x86]=i686-linux-android
    [x86_64]=x86_64-linux-android
)
declare -A ABI_FFMPEG_ARCH=(
    [arm64-v8a]=aarch64
    [armeabi-v7a]=arm
    [x86]=x86
    [x86_64]=x86_64
)
# Extra configure flags per ABI.
declare -A ABI_EXTRA_FLAGS=(
    [arm64-v8a]=""
    [armeabi-v7a]="--enable-thumb"
    [x86]="--disable-asm"
    [x86_64]="--disable-x86asm"
)
# x264 uses a simplified host triple.
declare -A ABI_X264_HOST=(
    [arm64-v8a]=aarch64-linux
    [armeabi-v7a]=arm-linux
    [x86]=i686-linux
    [x86_64]=x86_64-linux
)
# Standard autotools host triple for freetype etc.
declare -A ABI_AUTOTOOLS_HOST=(
    [arm64-v8a]=aarch64-linux-android
    [armeabi-v7a]=arm-linux-androideabi
    [x86]=i686-linux-android
    [x86_64]=x86_64-linux-android
)

# Optionally limit ABIs via env: BUILD_ABIS="arm64-v8a x86_64"
ABIS="${BUILD_ABIS:-arm64-v8a armeabi-v7a x86 x86_64}"

# Patch PT_TLS segment alignment in an ELF binary to >= 64 bytes.
# Required for ARM64 Bionic on Android 15+ which enforces this minimum.
patch_tls_alignment() {
    local binary="$1"
    python3 -c "
import struct, sys
PT_TLS = 7
path = sys.argv[1]
with open(path, 'r+b') as f:
    ident = f.read(16)
    ei_class = ident[4]
    if ei_class == 2:  # 64-bit
        f.seek(32); e_phoff = struct.unpack('<Q', f.read(8))[0]
        f.seek(54); e_phentsize = struct.unpack('<H', f.read(2))[0]
        e_phnum = struct.unpack('<H', f.read(2))[0]
        for i in range(e_phnum):
            off = e_phoff + i * e_phentsize
            f.seek(off); p_type = struct.unpack('<I', f.read(4))[0]
            if p_type == PT_TLS:
                align_off = off + 48
                f.seek(align_off); p_align = struct.unpack('<Q', f.read(8))[0]
                if p_align < 64:
                    f.seek(align_off); f.write(struct.pack('<Q', 64))
                    print(f'Patched PT_TLS alignment: {p_align} -> 64')
                else:
                    print(f'PT_TLS alignment OK: {p_align}')
                break
        else:
            print('No PT_TLS segment found (OK)')
    elif ei_class == 1:  # 32-bit
        f.seek(28); e_phoff = struct.unpack('<I', f.read(4))[0]
        f.seek(42); e_phentsize = struct.unpack('<H', f.read(2))[0]
        e_phnum = struct.unpack('<H', f.read(2))[0]
        for i in range(e_phnum):
            off = e_phoff + i * e_phentsize
            f.seek(off); p_type = struct.unpack('<I', f.read(4))[0]
            if p_type == PT_TLS:
                align_off = off + 28
                f.seek(align_off); p_align = struct.unpack('<I', f.read(4))[0]
                if p_align < 64:
                    f.seek(align_off); f.write(struct.pack('<I', 64))
                    print(f'Patched PT_TLS alignment: {p_align} -> 64')
                else:
                    print(f'PT_TLS alignment OK: {p_align}')
                break
        else:
            print('No PT_TLS segment found (OK)')
" "$binary"
}

build_x264_for_abi() {
    local abi="$1"
    local triple="${ABI_TRIPLE[$abi]}"
    local CC="$TOOLCHAIN/bin/${triple}${API}-clang"
    local x264_host="${ABI_X264_HOST[$abi]}"
    local PREFIX="$BUILD_BASE/x264-install-$abi"
    local BUILD_DIR="$BUILD_BASE/x264-build-$abi"

    if [[ -f "$PREFIX/lib/libx264.a" ]]; then
        echo "x264 already built for $abi, skipping."
        return
    fi

    echo "Building x264 for $abi ..."
    rm -rf "$BUILD_DIR"
    mkdir -p "$BUILD_DIR"
    cd "$BUILD_DIR"

    CC="$CC" AS="$CC" "$X264_SRC/configure" \
        --prefix="$PREFIX" \
        --host="$x264_host" \
        --cross-prefix="$TOOLCHAIN/bin/llvm-" \
        --enable-static \
        --disable-shared \
        --disable-cli \
        --enable-pic \
        --disable-asm \
        --extra-cflags="-fPIC -Os"

    make -j"$(nproc)"
    make install
    echo "=> x264 installed to $PREFIX"
}

build_freetype_for_abi() {
    local abi="$1"
    local triple="${ABI_TRIPLE[$abi]}"
    local CC="$TOOLCHAIN/bin/${triple}${API}-clang"
    local at_host="${ABI_AUTOTOOLS_HOST[$abi]}"
    local PREFIX="$BUILD_BASE/freetype-install-$abi"
    local BUILD_DIR="$BUILD_BASE/freetype-build-$abi"

    if [[ -f "$PREFIX/lib/libfreetype.a" ]]; then
        echo "freetype already built for $abi, skipping."
        return
    fi

    echo "Building freetype for $abi ..."
    rm -rf "$BUILD_DIR"
    mkdir -p "$BUILD_DIR"
    cd "$BUILD_DIR"

    CC="$CC" CFLAGS="-fPIC -Os" \
    "$FREETYPE_SRC/configure" \
        --prefix="$PREFIX" \
        --host="$at_host" \
        --enable-static \
        --disable-shared \
        --without-harfbuzz \
        --without-bzip2 \
        --without-png \
        --without-brotli \
        --with-zlib=no

    make -j"$(nproc)"
    make install
    echo "=> freetype installed to $PREFIX"
}

build_for_abi() {
    local abi="$1"
    local arch="${ABI_ARCH[$abi]}"
    local triple="${ABI_TRIPLE[$abi]}"
    local ffarch="${ABI_FFMPEG_ARCH[$abi]}"
    local extra="${ABI_EXTRA_FLAGS[$abi]}"

    local CC="$TOOLCHAIN/bin/${triple}${API}-clang"
    local CXX="$TOOLCHAIN/bin/${triple}${API}-clang++"

    # armeabi-v7a uses armv7a-linux-androideabi but the strip tool uses arm-linux-androideabi
    local strip_triple="$triple"
    if [[ "$abi" == "armeabi-v7a" ]]; then
        strip_triple="arm-linux-androideabi"
    fi
    local STRIP="$TOOLCHAIN/bin/llvm-strip"

    local BUILD_DIR="$BUILD_BASE/build-$abi"
    local PREFIX="$BUILD_BASE/install-$abi"

    echo "========================================"
    echo "Building FFmpeg for $abi ($ffarch)"
    echo "========================================"

    rm -rf "$BUILD_DIR"
    mkdir -p "$BUILD_DIR"
    cd "$BUILD_DIR"

    # Build a small object file with a 64-byte-aligned native TLS variable.
    # This forces the linker to place PT_TLS at a 64-byte-aligned virtual address,
    # which is required by ARM64 Bionic on Android 15+.
    local TLS_ALIGN_OBJ="$BUILD_DIR/_force_tls_align.o"
    cat > "$BUILD_DIR/_force_tls_align.c" << 'TLSEOF'
__attribute__((aligned(64), used, section(".tdata")))
__thread char _force_tls_align_pad[64] = {0};
TLSEOF
    "$CC" -c -fno-emulated-tls -fPIC "$BUILD_DIR/_force_tls_align.c" -o "$TLS_ALIGN_OBJ"
    echo "Built TLS alignment helper: $TLS_ALIGN_OBJ"

    # --- Build x264 and freetype for this ABI ---
    build_x264_for_abi "$abi"
    build_freetype_for_abi "$abi"

    local X264_PREFIX="$BUILD_BASE/x264-install-$abi"
    local FT_PREFIX="$BUILD_BASE/freetype-install-$abi"
    export PKG_CONFIG_PATH="$X264_PREFIX/lib/pkgconfig:$FT_PREFIX/lib/pkgconfig"

    "$FFMPEG_SRC/configure" \
        --prefix="$PREFIX" \
        --target-os=android \
        --arch="$ffarch" \
        --cc="$CC" \
        --cxx="$CXX" \
        --strip="$STRIP" \
        --cross-prefix="$TOOLCHAIN/bin/llvm-" \
        --sysroot="$TOOLCHAIN/sysroot" \
        --enable-cross-compile \
        --enable-static \
        --disable-shared \
        --enable-small \
        --enable-gpl \
        --enable-libx264 \
        --enable-libfreetype \
        --disable-doc \
        --disable-htmlpages \
        --disable-manpages \
        --disable-podpages \
        --disable-txtpages \
        --disable-programs \
        --enable-ffmpeg \
        --disable-ffplay \
        --disable-ffprobe \
        --disable-network \
        --disable-postproc \
        --disable-avdevice \
        --disable-symver \
        --disable-debug \
        --disable-vulkan \
        --disable-vaapi \
        --disable-vdpau \
        --disable-videotoolbox \
        --disable-audiotoolbox \
        --enable-pic \
        --enable-jni \
        --enable-mediacodec \
        --extra-cflags="-Os -fPIC -I$X264_PREFIX/include -I$FT_PREFIX/include/freetype2" \
        --extra-ldflags="-static -Wl,-z,max-page-size=16384 -Wl,-z,common-page-size=16384 -L$X264_PREFIX/lib -L$FT_PREFIX/lib" \
        --pkg-config-flags="--static" \
        --extra-ldexeflags="$TLS_ALIGN_OBJ" \
        $extra

    make -j"$(nproc)" ffmpeg

    # The output is at $BUILD_DIR/ffmpeg (statically linked ELF).
    "$STRIP" ffmpeg

    # Verify TLS alignment (should be 64 with skew 0).
    echo "Verifying TLS segment:"
    readelf -l ffmpeg 2>/dev/null | grep -A1 "TLS" || echo "No PT_TLS (OK)"

    # Place it in jniLibs as libffmpeg.so (Android requires lib*.so naming).
    local OUT_DIR="$JNILIBS_DIR/$abi"
    mkdir -p "$OUT_DIR"
    cp ffmpeg "$OUT_DIR/libffmpeg.so"
    chmod 755 "$OUT_DIR/libffmpeg.so"

    local size
    size="$(du -h "$OUT_DIR/libffmpeg.so" | cut -f1)"
    echo "=> $OUT_DIR/libffmpeg.so ($size)"
}

for abi in $ABIS; do
    build_for_abi "$abi"
done

echo ""
echo "Done! FFmpeg binaries placed in jniLibs:"
find "$JNILIBS_DIR" -name "libffmpeg.so" -exec ls -lh {} \;
