package com.fal.falkoe

import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.util.Base64
import android.app.Activity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.File

/**
 * Helper object for communicating with AnkiDroid via its ContentProvider API.
 *
 * Requires permission: `com.ichi2.anki.permission.READ_WRITE_DATABASE`
 *
 * ContentProvider authority: `com.ichi2.anki.flashcards`
 */
object AnkiDroidHelper {

    private const val AUTHORITY = "com.ichi2.anki.flashcards"
    private val BASE_URI: Uri = Uri.parse("content://$AUTHORITY")
    private val NOTES_URI: Uri = Uri.withAppendedPath(BASE_URI, "notes")
    private val DECKS_URI: Uri = Uri.withAppendedPath(BASE_URI, "decks")
    private val MODELS_URI: Uri = Uri.withAppendedPath(BASE_URI, "models")
    private val MEDIA_URI: Uri = Uri.withAppendedPath(BASE_URI, "media")

    private fun mediaPreferredName(filename: String): String {
        val base = filename.substringBeforeLast('.', filename)
        return base.replace(" ", "_").take(80)
    }

    /** AnkiDroid uses Unicode Unit Separator (U+001F) to delimit note fields. */
    private const val FIELD_SEPARATOR = "\u001f"

    // -- introspection -------------------------------------------------------

    /** Known AnkiDroid package names (paid + free). */
    private val ANKIDROID_PACKAGES = listOf("com.ichi2.anki", "com.ichi2.anki.A")

    /**
     * Returns `true` if AnkiDroid (paid **or** free build) is installed.
     */
    @JvmStatic
    fun isInstalled(context: Context): Boolean {
        val pm = context.packageManager
        return ANKIDROID_PACKAGES.any { pkg ->
            try {
                pm.getPackageInfo(pkg, 0)
                true
            } catch (_: PackageManager.NameNotFoundException) {
                false
            }
        }
    }

    /**
     * Return the package name of the installed AnkiDroid, or null.
     */
    private fun installedAnkiPackage(context: Context): String? {
        val pm = context.packageManager
        return ANKIDROID_PACKAGES.firstOrNull { pkg ->
            try { pm.getPackageInfo(pkg, 0); true }
            catch (_: PackageManager.NameNotFoundException) { false }
        }
    }

    private fun ankiGrantTargets(context: Context): List<String> {
        val pm = context.packageManager
        val targets = linkedSetOf<String>()
        val providerPkg = pm.resolveContentProvider(AUTHORITY, 0)?.packageName
        if (!providerPkg.isNullOrBlank()) targets.add(providerPkg)
        installedAnkiPackage(context)?.let { targets.add(it) }
        for (pkg in ANKIDROID_PACKAGES) {
            try {
                pm.getPackageInfo(pkg, 0)
                targets.add(pkg)
            } catch (_: PackageManager.NameNotFoundException) {
            }
        }
        return targets.toList()
    }

    /**
     * Returns `true` if the app already holds the AnkiDroid database
     * read/write permission at runtime.
     */
    @JvmStatic
    fun hasPermission(context: Context): Boolean {
        return ContextCompat.checkSelfPermission(
            context,
            "com.ichi2.anki.permission.READ_WRITE_DATABASE"
        ) == PackageManager.PERMISSION_GRANTED
    }

    private const val ANKIDROID_PERMISSION_REQUEST_CODE = 20001

    /**
     * Request the AnkiDroid database permission via the Activity.
     * Returns `true` if permission was already granted, `false` if a request
     * dialog was shown (result will arrive via onRequestPermissionsResult).
     */
    @JvmStatic
    fun requestPermission(activity: Activity): Boolean {
        if (hasPermission(activity)) return true
        ActivityCompat.requestPermissions(
            activity,
            arrayOf("com.ichi2.anki.permission.READ_WRITE_DATABASE"),
            ANKIDROID_PERMISSION_REQUEST_CODE
        )
        return false
    }

    // -- decks ---------------------------------------------------------------

    /** Find a deck by exact name and return its ID, or −1 if not found. */
    @JvmStatic
    fun findDeckId(context: Context, deckName: String): Long {
        context.contentResolver.query(
            DECKS_URI,
            arrayOf("deck_id", "deck_name"),
            null, null, null
        )?.use { c ->
            while (c.moveToNext()) {
                if (c.getString(1) == deckName) return c.getLong(0)
            }
        }
        return -1
    }

    /** Create a new deck and return its ID, or −1 on failure. */
    @JvmStatic
    fun createDeck(context: Context, deckName: String): Long {
        val cv = ContentValues().apply { put("deck_name", deckName) }
        val uri = context.contentResolver.insert(DECKS_URI, cv)
        return uri?.lastPathSegment?.toLongOrNull() ?: -1
    }

    // -- models (note types) -------------------------------------------------

    /** Find a note-type by name and return its ID, or −1 if not found. */
    @JvmStatic
    fun findModelId(context: Context, modelName: String): Long {
        context.contentResolver.query(
            MODELS_URI,
            arrayOf("_id", "name"),
            null, null, null
        )?.use { c ->
            while (c.moveToNext()) {
                if (c.getString(1) == modelName) return c.getLong(0)
            }
        }
        return -1
    }

    // -- media ---------------------------------------------------------------

    /**
     * Store a media file in AnkiDroid's collection.media directory
     * via the ContentProvider insert API.
     *
     * Uses the same approach as the official AnkiDroid API library:
     * 1. Write file to internal cache (covered by FileProvider).
     * 2. Obtain a content:// URI via FileProvider.
     * 3. Grant AnkiDroid read permission on that URI.
     * 4. Insert via ContentProvider.
     * 5. Revoke permission and clean up.
     *
     * @param filename  Desired filename (e.g. `model_abc123.mp3`).
     * @param data      Raw bytes of the media file.
     * @return The filename as stored.
     */
    @JvmStatic
    fun storeMedia(context: Context, filename: String, data: ByteArray): String {
        val stagingDir = File(context.cacheDir, "anki_media_staging")
        if (!stagingDir.exists()) stagingDir.mkdirs()

        val tmpFile = File(stagingDir, filename)
        tmpFile.writeBytes(data)

        // Determine package targets that should receive URI permission
        val ankiTargets = ankiGrantTargets(context)
        if (ankiTargets.isEmpty()) throw Exception("AnkiDroid is not installed")

        // Get a content:// URI through our FileProvider
        val fileProviderAuthority = context.packageName + ".fileprovider"
        val contentUri = FileProvider.getUriForFile(context, fileProviderAuthority, tmpFile)

        try {
            // Grant AnkiDroid read access to this specific URI
            for (target in ankiTargets) {
                context.grantUriPermission(
                    target,
                    contentUri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION
                )
            }

            val cv = ContentValues().apply {
                put("file_uri", contentUri.toString())
                put("preferred_name", mediaPreferredName(filename))
            }
            val resultUri = context.contentResolver.insert(MEDIA_URI, cv)

            if (resultUri != null) {
                return resultUri.lastPathSegment ?: filename
            }

            throw Exception("AnkiDroid: insert(media) returned null for $filename")
        } finally {
            // Revoke permission and clean up temp file
            for (target in ankiTargets) {
                context.revokeUriPermission(target, contentUri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            tmpFile.delete()
        }
    }

    // -- notes ---------------------------------------------------------------

    /**
     * High-level "add note" that mirrors the desktop AnkiConnect workflow:
     *
     * 1. Find or create the target deck.
     * 2. Find the requested model (note type).
     * 3. Store any attached media files.
     * 4. Insert the note.
     * 5. Move the note's cards to the target deck.
     *
     * @param deckName   Hierarchical deck name (e.g. `Falkoe::English::Pronunciation`).
     * @param modelName  Note-type name (e.g. `Basic`).
     * @param fields     Field values in order.  For "Basic" → `[Front, Back]`.
     * @param tags       Space-separated tag string.
     * @param mediaNames Filenames for media attachments.
     * @param mediaDatas Corresponding raw byte arrays.
     * @return The new note ID (or −1 if insertion failed but didn't throw).
     */
    @JvmStatic
    fun addNote(
        context: Context,
        deckName: String,
        modelName: String,
        fields: Array<String>,
        tags: String,
        mediaNames: Array<String>,
        mediaDatas: Array<ByteArray>,
    ): Long {
        val cr = context.contentResolver

        // 1. Deck
        var deckId = findDeckId(context, deckName)
        if (deckId < 0) {
            deckId = createDeck(context, deckName)
            if (deckId < 0) throw Exception("AnkiDroid: failed to create deck '$deckName'")
        }

        // 2. Model
        val modelId = findModelId(context, modelName)
        if (modelId < 0) throw Exception(
            "AnkiDroid: model '$modelName' not found. Please open AnkiDroid and ensure it exists."
        )

        // 3. Media
        val resolvedFields = fields.copyOf()
        for (i in mediaNames.indices) {
            val originalName = mediaNames[i]
            val storedName = storeMedia(context, originalName, mediaDatas[i])
            if (storedName != originalName) {
                for (j in resolvedFields.indices) {
                    resolvedFields[j] = resolvedFields[j]
                        .replace("[sound:$originalName]", "[sound:$storedName]")
                        .replace("src=\"$originalName\"", "src=\"$storedName\"")
                        .replace("src='$originalName'", "src='$storedName'")
                }
            }
        }

        // 4. Insert note
        val cv = ContentValues().apply {
            put("mid", modelId)
            put("flds", resolvedFields.joinToString(FIELD_SEPARATOR))
            put("tags", tags)
        }
        val noteUri = cr.insert(NOTES_URI, cv)
            ?: throw Exception("AnkiDroid: failed to insert note")
        val noteId = noteUri.lastPathSegment?.toLongOrNull() ?: -1

        // 5. Move card(s) to correct deck
        if (noteId > 0) {
            val cardsUri = Uri.withAppendedPath(
                Uri.withAppendedPath(NOTES_URI, noteId.toString()),
                "cards"
            )
            cr.query(cardsUri, null, null, null, null)?.use { cursor ->
                val ordIdx = cursor.getColumnIndex("card_ord")
                while (cursor.moveToNext()) {
                    val ord = if (ordIdx >= 0) cursor.getLong(ordIdx) else 0L
                    val cardUri = Uri.withAppendedPath(cardsUri, ord.toString())
                    val cardCv = ContentValues().apply { put("deck_id", deckId) }
                    cr.update(cardUri, cardCv, null, null)
                }
            }
        }

        return noteId
    }

    // -- convenience for JNI (accepts base64 strings) ------------------------

    /**
     * Wrapper called from Rust via JNI.
     *
     * Media data is passed as Base64 strings to avoid dealing with JNI
     * `byte[][]` (2D arrays) which are cumbersome in jni-rs.
     *
     * @return note ID as a string, or throws on error.
     */
    @JvmStatic
    fun addNoteFromJni(
        context: Context,
        deckName: String,
        modelName: String,
        fieldsJson: String,
        tags: String,
        mediaNamesJson: String,
        mediaDatasBase64Json: String,
    ): String {
        // Parse simple JSON arrays → String arrays (avoids pulling in Gson/Moshi).
        val fields = parseJsonStringArray(fieldsJson)
        val mediaNames = parseJsonStringArray(mediaNamesJson)
        val mediaDatasB64 = parseJsonStringArray(mediaDatasBase64Json)

        val mediaDatas = mediaDatasB64.map { b64 ->
            Base64.decode(b64, Base64.NO_WRAP)
        }.toTypedArray()

        val noteId = addNote(context, deckName, modelName, fields, tags, mediaNames, mediaDatas)
        return noteId.toString()
    }

    /**
     * Minimal JSON string-array parser (no external deps).
     * Handles: `["a","b","c"]` – supports `\"` escaping inside strings.
     */
    private fun parseJsonStringArray(json: String): Array<String> {
        val trimmed = json.trim()
        if (trimmed == "[]" || trimmed.isEmpty()) return emptyArray()

        val inner = trimmed.removePrefix("[").removeSuffix("]")
        val result = mutableListOf<String>()
        val sb = StringBuilder()
        var inString = false
        var escaped = false

        for (ch in inner) {
            when {
                escaped -> { sb.append(ch); escaped = false }
                ch == '\\' -> escaped = true
                ch == '"' -> inString = !inString
                ch == ',' && !inString -> { result.add(sb.toString()); sb.clear() }
                inString -> sb.append(ch)
            }
        }
        if (sb.isNotEmpty()) result.add(sb.toString())
        return result.toTypedArray()
    }
}
