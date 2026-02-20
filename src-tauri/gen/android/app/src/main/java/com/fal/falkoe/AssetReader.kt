package com.fal.falkoe

import android.content.Context

/**
 * JNI-callable helper that reads raw bytes from the APK's assets directory.
 *
 * This exists to work around a bug in Tauri's `plugin-fs` Android backend
 * (`FsPlugin.kt`): for *uncompressed* assets the plugin calls
 * `openFd(path).parcelFileDescriptor.detachFd()`, which discards the
 * start-offset / length and causes Rust's `read_to_end()` to consume the
 * entire remainder of the APK file — easily triggering an OOM.
 *
 * By going through `InputStream.readBytes()` here, we always get the exact
 * asset content regardless of compression.
 */
object AssetReader {
    /**
     * Read an asset from the APK as a byte array.
     *
     * @param context  Android application context.
     * @param path     Asset path relative to the assets root (e.g. "ipa/audio/vowels/p.mp3").
     * @return  The asset bytes, or `null` if the asset does not exist.
     */
    @JvmStatic
    fun readAsset(context: Context, path: String): ByteArray? {
        return try {
            context.assets.open(path).use { it.readBytes() }
        } catch (_: Exception) {
            null
        }
    }
}
