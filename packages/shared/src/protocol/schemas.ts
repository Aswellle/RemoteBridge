/**
 * Runtime WS-message schema validators (V2 Transfer Engine, RB-P0-06).
 *
 * Pure-TS validators (no Zod dependency) for the messages that touch the
 * transfer / filesystem / auth boundary. Every validator returns the
 * narrowed payload on success or throws InvalidPayloadError on failure.
 *
 * The goal is NOT to replace TypeScript types at compile time; it is to
 * enforce the same contracts at runtime against untrusted wire input.
 */

import type { WSMessage } from '../ws-types';
import type {
  CmdFetchFilePayload,
  CmdCancelTransferPayload,
  CmdListDirPayload,
  CmdRequestDownloadPayload,
  CmdRequestPreviewPayload,
  CmdUploadFileChunkPayload,
  MsgTextPayload,
  RespFileChunkPayload,
  RespFileErrorPayload,
} from '../ws-types';
import {
  WSMessageType,
  TransferState,
} from '../ws-types';
import { InvalidPayloadError, InvalidEnvelopeError } from './errors';

// ===== helpers =====

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown, field: string): string {
  if (typeof v !== 'string') {
    throw new InvalidPayloadError('', 'field ' + field + ' must be string');
  }
  return v;
}

function asOptionalString(v: unknown, field: string): string | undefined {
  if (v === undefined) return undefined;
  return asString(v, field);
}

function asNonNegativeInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new InvalidPayloadError('', 'field ' + field + ' must be non-negative integer');
  }
  return v;
}

function asOptionalNonNegativeInt(v: unknown, field: string): number | undefined {
  if (v === undefined) return undefined;
  return asNonNegativeInt(v, field);
}

function asBoolean(v: unknown, field: string): boolean {
  if (typeof v !== 'boolean') {
    throw new InvalidPayloadError('', 'field ' + field + ' must be boolean');
  }
  return v;
}

function asBase64(v: unknown, field: string): string {
  const s = asString(v, field);
  if (s.length > 0 && !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    throw new InvalidPayloadError('', 'field ' + field + ' must be base64 string');
  }
  return s;
}

// ===== per-message validators =====

function validateCmdFetchFilePayload(payload: unknown): CmdFetchFilePayload {
  if (!isObject(payload)) throw new InvalidPayloadError(WSMessageType.CMD_FETCH_FILE, 'payload must be object');
  return {
    ...payload,
    transferId: asString(payload.transferId, 'transferId'),
    token: asString(payload.token, 'token'),
    rangeStart: asOptionalNonNegativeInt(payload.rangeStart, 'rangeStart'),
    rangeEnd: asOptionalNonNegativeInt(payload.rangeEnd, 'rangeEnd'),
    clientId: asOptionalString(payload.clientId, 'clientId'),
  };
}

const CANCEL_REASONS: string[] = ['user_cancel', 'client_disconnect', 'session_revoked', 'proxy_closed', 'timeout'];

function validateCmdCancelTransferPayload(payload: unknown): CmdCancelTransferPayload {
  if (!isObject(payload)) throw new InvalidPayloadError(WSMessageType.CMD_CANCEL_TRANSFER, 'payload must be object');
  const reason = payload.reason as CmdCancelTransferPayload['reason'] | undefined;
  if (reason !== undefined && !CANCEL_REASONS.includes(reason)) {
    throw new InvalidPayloadError(WSMessageType.CMD_CANCEL_TRANSFER, 'invalid reason: ' + String(reason));
  }
  return {
    ...payload,
    transferId: asString(payload.transferId, 'transferId'),
    reason,
  };
}

function validateCmdListDirPayload(payload: unknown): CmdListDirPayload {
  if (!isObject(payload)) throw new InvalidPayloadError(WSMessageType.CMD_LIST_DIR, 'payload must be object');
  return {
    ...payload,
    path: asString(payload.path, 'path'),
    requestId: asString(payload.requestId, 'requestId'),
    clientId: asOptionalString(payload.clientId, 'clientId'),
    sessionId: asOptionalString(payload.sessionId, 'sessionId'),
  };
}

function validateCmdRequestDownloadPayload(payload: unknown): CmdRequestDownloadPayload {
  if (!isObject(payload)) throw new InvalidPayloadError(WSMessageType.CMD_REQUEST_DOWNLOAD, 'payload must be object');
  return {
    ...payload,
    filePath: asString(payload.filePath, 'filePath'),
    requestId: asString(payload.requestId, 'requestId'),
    clientId: asOptionalString(payload.clientId, 'clientId'),
    sessionId: asOptionalString(payload.sessionId, 'sessionId'),
  };
}

function validateCmdRequestPreviewPayload(payload: unknown): CmdRequestPreviewPayload {
  if (!isObject(payload)) throw new InvalidPayloadError(WSMessageType.CMD_REQUEST_PREVIEW, 'payload must be object');
  return {
    ...payload,
    filePath: asString(payload.filePath, 'filePath'),
    requestId: asString(payload.requestId, 'requestId'),
    clientId: asOptionalString(payload.clientId, 'clientId'),
    sessionId: asOptionalString(payload.sessionId, 'sessionId'),
  };
}

function validateCmdUploadFileChunkPayload(payload: unknown): CmdUploadFileChunkPayload {
  if (!isObject(payload)) throw new InvalidPayloadError(WSMessageType.CMD_UPLOAD_FILE_CHUNK, 'payload must be object');
  return {
    ...payload,
    uploadId: asString(payload.uploadId, 'uploadId'),
    fileName: asString(payload.fileName, 'fileName'),
    mimeType: asString(payload.mimeType, 'mimeType'),
    category: asString(payload.category, 'category') as CmdUploadFileChunkPayload['category'],
    chunkIndex: asNonNegativeInt(payload.chunkIndex, 'chunkIndex'),
    totalChunks: asNonNegativeInt(payload.totalChunks, 'totalChunks'),
    totalSize: asNonNegativeInt(payload.totalSize, 'totalSize'),
    data: asBase64(payload.data, 'data'),
    clientId: asOptionalString(payload.clientId, 'clientId'),
    sessionId: asOptionalString(payload.sessionId, 'sessionId'),
  };
}

function validateMsgTextPayload(payload: unknown): MsgTextPayload {
  if (!isObject(payload)) throw new InvalidPayloadError(WSMessageType.MSG_TEXT, 'payload must be object');
  return {
    ...payload,
    content: asString(payload.content, 'content'),
    senderId: asOptionalString(payload.senderId, 'senderId'),
    senderLabel: asOptionalString(payload.senderLabel, 'senderLabel'),
  };
}

function validateRespFileChunkPayload(payload: unknown): RespFileChunkPayload {
  if (!isObject(payload)) throw new InvalidPayloadError(WSMessageType.RESP_FILE_CHUNK, 'payload must be object');
  return {
    ...payload,
    transferId: asString(payload.transferId, 'transferId'),
    seq: asNonNegativeInt(payload.seq, 'seq'),
    data: asBase64(payload.data, 'data'),
    eof: asBoolean(payload.eof, 'eof'),
    totalSize: asOptionalNonNegativeInt(payload.totalSize, 'totalSize'),
    rangeStart: asOptionalNonNegativeInt(payload.rangeStart, 'rangeStart'),
    rangeEnd: asOptionalNonNegativeInt(payload.rangeEnd, 'rangeEnd'),
    contentType: asOptionalString(payload.contentType, 'contentType'),
    fileName: asOptionalString(payload.fileName, 'fileName'),
  };
}

function validateRespFileErrorPayload(payload: unknown): RespFileErrorPayload {
  if (!isObject(payload)) throw new InvalidPayloadError(WSMessageType.RESP_FILE_ERROR, 'payload must be object');
  return {
    ...payload,
    transferId: asString(payload.transferId, 'transferId'),
    code: asString(payload.code, 'code'),
    message: asString(payload.message, 'message'),
  };
}

// ===== registry =====

type ValidatorFn = (payload: unknown) => unknown;

const validators = new Map<WSMessageType, ValidatorFn>([
  [WSMessageType.CMD_FETCH_FILE, validateCmdFetchFilePayload],
  [WSMessageType.CMD_CANCEL_TRANSFER, validateCmdCancelTransferPayload],
  [WSMessageType.CMD_LIST_DIR, validateCmdListDirPayload],
  [WSMessageType.CMD_REQUEST_DOWNLOAD, validateCmdRequestDownloadPayload],
  [WSMessageType.CMD_REQUEST_PREVIEW, validateCmdRequestPreviewPayload],
  [WSMessageType.CMD_UPLOAD_FILE_CHUNK, validateCmdUploadFileChunkPayload],
  [WSMessageType.MSG_TEXT, validateMsgTextPayload],
  [WSMessageType.RESP_FILE_CHUNK, validateRespFileChunkPayload],
  [WSMessageType.RESP_FILE_ERROR, validateRespFileErrorPayload],
]);

/**
 * Validate a message payload against its declared type.
 * Returns the narrowed/validated payload on success.
 * Throws InvalidPayloadError on failure.
 *
 * For message types without a registered validator, returns the payload as-is.
 */
export function validatePayload(type: WSMessageType, payload: unknown): unknown {
  const validator = validators.get(type);
  if (!validator) return payload;
  return validator(payload);
}

/**
 * Validate a complete message envelope.
 * Returns the validated WSMessage on success.
 * Throws InvalidEnvelopeError on failure.
 */
export function validateMessage(message: unknown): WSMessage {
  if (!isObject(message)) {
    throw new InvalidEnvelopeError('message must be JSON object');
  }

  const type = message.type;
  if (typeof type !== 'string' || !Object.values<string>(WSMessageType).includes(type)) {
    throw new InvalidEnvelopeError('unknown or missing type: ' + String(type));
  }

  const timestamp = message.timestamp;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    throw new InvalidEnvelopeError('timestamp must be finite number');
  }

  const validatedPayload = validatePayload(type as WSMessageType, message.payload);

  return {
    id: typeof message.id === 'string' ? message.id : '',
    type: type as WSMessageType,
    payload: validatedPayload,
    timestamp,
    sessionId: typeof message.sessionId === 'string' ? message.sessionId : undefined,
    senderId: typeof message.senderId === 'string' ? message.senderId : undefined,
    senderType: typeof message.senderType === 'string' ? message.senderType : undefined,
  };
}


// ===== Range header validation (PR-04, shared by server proxy and desktop file-server) =====

/** Parse Range header syntax only (bytes=start-end?). Returns null if syntax is invalid. */
export function parseRangeHeader(rangeHeader: string | undefined): { start: number; end?: number } | null {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;
  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : undefined;
  if (end != null && end < start) return null;
  return { start, end };
}

/**
 * Validate Range satisfiability against known file size.
 * Returns null if satisfiable, otherwise returns a reason string.
 * Caller decides how to respond (416 vs silent clamp).
 */
export function validateRangeAgainstSize(
  range: { start: number; end?: number },
  fileSize: number,
): string | null {
  if (fileSize === 0) return 'empty file';
  if (range.start >= fileSize) return 'start >= fileSize';
  if (range.end != null && range.end >= fileSize) return 'end >= fileSize';
  return null;
}

export { TransferState };
