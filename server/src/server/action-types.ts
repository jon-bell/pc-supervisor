// JSON shapes of the v1 action routes (PLAN M8, spec §6), shared with the web
// app by type-only import. Type-only imports, so the browser build can
// type-check it without Node types. Nothing here carries the HotCRP token.

import type { Person } from "./api-types.js";

/** GET /api/actions: what the action buttons need. */
export interface ActionsInfo {
  /** PCS_ATTENTION_TAG, without the #. */
  attentionTag: string;
  /** False when the server has no HotCRP writer (tests, read-only use). */
  taggingAvailable: boolean;
  /** Preview tokens expire after this many milliseconds. */
  previewTtlMs: number;
}

/** GET /api/papers/:pid/nudge: a comment draft to copy (the app never posts it). */
export interface NudgeResponse {
  pid: number;
  audience: string;
  mentions: Person[];
  text: string;
}

/** POST /api/tags/preview body. */
export interface TagPreviewRequest {
  add?: number[];
  remove?: number[];
}

export interface TagPaper {
  pid: number;
  /** From the local store; null if the paper isn't synced. */
  title: string | null;
}

/** POST /api/tags/preview: HotCRP's dry-run diff, plus a single-use token when it isn't empty. */
export interface TagPreviewResponse {
  tag: string;
  token: string | null;
  gain: TagPaper[];
  lose: TagPaper[];
  /** Requested papers HotCRP would leave as they are. */
  unchanged: number[];
  expiresInMs: number;
}

/** POST /api/tags/commit body: the token and the exact sets previewed, plus the tag name typed out. */
export interface TagCommitRequest {
  token: string;
  gain: number[];
  lose: number[];
  confirm: string;
}

export interface TagCommitResponse {
  tag: string;
  gain: number[];
  lose: number[];
  /** A re-sync was started so the change shows (false if one was already running). */
  syncStarted: boolean;
}
