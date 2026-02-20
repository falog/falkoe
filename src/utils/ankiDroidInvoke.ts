/**
 * TypeScript wrappers around the `ankidroid_status` / `ankidroid_add_note`
 * Tauri commands exposed by `src-tauri/src/commands/ankidroid.rs`.
 *
 * These are only functional on Android; on desktop they return errors.
 */
import { invoke } from "@tauri-apps/api/core";

export interface AnkiDroidStatus {
  installed: boolean;
  permissionGranted: boolean;
}

export interface AddNotePayload {
  deckName: string;
  modelName: string;
  /** Ordered field values, e.g. `["Front HTML", "Back HTML"]`. */
  fields: string[];
  /** Space-separated tag string. */
  tags: string;
  /** Filenames for media attachments. */
  mediaNames: string[];
  /** Base64-encoded media data, same order as `mediaNames`. */
  mediaDatasBase64: string[];
}

export interface AddNoteResult {
  noteId: string;
}

export async function ankidroidStatus(): Promise<AnkiDroidStatus> {
  return invoke<AnkiDroidStatus>("ankidroid_status");
}
/**
 * Request the AnkiDroid database permission at runtime.
 * Returns `true` if already granted, `false` if a dialog was shown to the user.
 */
export async function ankidroidRequestPermission(): Promise<boolean> {
  return invoke<boolean>("ankidroid_request_permission");
}
export async function ankidroidAddNote(
  payload: AddNotePayload,
): Promise<AddNoteResult> {
  return invoke<AddNoteResult>("ankidroid_add_note", { payload });
}
