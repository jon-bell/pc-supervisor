// HotCRP access goes through this module (AGENTS.md).
export { HotcrpClient, clientFromConfig, parseRetryAfter } from "./client.js";
export type { HotcrpClientEvent, HotcrpClientOptions, Params, SearchScope } from "./client.js";
export { HotcrpError, ftext } from "./errors.js";
export type { HotcrpErrorKind } from "./errors.js";
export { pidChunks } from "./chunk.js";
export type { PidChunk } from "./chunk.js";
export { assertHarnessUrl, isHarnessUrl, NotHarnessError } from "./harness-guard.js";
export * from "./schemas.js";
export { AssignTagsResultSchema, tagAssignmentBody, tagDiffOf, WRITABLE_TAG_RE } from "./tag-assign.js";
export type { AssignTagsResult, TagChange, TagDiff, TagOp } from "./tag-assign.js";
