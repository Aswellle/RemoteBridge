import { describe, it, expect } from 'vitest';
import { validateMessage, validatePayload, TransferState } from '../src/protocol/schemas';
import { WSMessageType } from '../src/ws-types';
import { InvalidPayloadError, InvalidEnvelopeError } from '../src/protocol/errors';

describe('validateMessage — envelope', () => {
  it('accepts a well-formed message', () => {
    const msg = validateMessage({
      id: 'm1',
      type: 'CMD_LIST_DIR',
      payload: { path: '/docs', requestId: 'r1' },
      timestamp: Date.now(),
      sessionId: 's1',
    });
    expect(msg.type).toBe(WSMessageType.CMD_LIST_DIR);
    expect(msg.id).toBe('m1');
  });

  it('rejects non-object input', () => {
    expect(() => validateMessage(null)).toThrow(InvalidEnvelopeError);
    expect(() => validateMessage('string')).toThrow(InvalidEnvelopeError);
    expect(() => validateMessage(42)).toThrow(InvalidEnvelopeError);
  });

  it('rejects unknown type', () => {
    expect(() =>
      validateMessage({ type: 'FOOBAR', payload: {}, timestamp: Date.now() }),
    ).toThrow(InvalidEnvelopeError);
  });

  it('rejects missing / invalid timestamp', () => {
    expect(() =>
      validateMessage({ type: 'CMD_LIST_DIR', payload: {}, timestamp: 'now' as unknown as number }),
    ).toThrow(InvalidEnvelopeError);
    expect(() =>
      validateMessage({ type: 'CMD_LIST_DIR', payload: {} }),
    ).toThrow(InvalidEnvelopeError);
  });

  it('defaults missing id to empty string', () => {
    const msg = validateMessage({ type: 'PING', payload: {}, timestamp: 1 });
    expect(msg.id).toBe('');
  });
});

describe('validatePayload — CMD_FETCH_FILE', () => {
  it('accepts valid payload', () => {
    const p = validatePayload(WSMessageType.CMD_FETCH_FILE, {
      transferId: 't1',
      token: 'tok-abc',
      rangeStart: 0,
      rangeEnd: 1023,
      clientId: 'c1',
    });
    expect(p).toEqual({
      transferId: 't1',
      token: 'tok-abc',
      rangeStart: 0,
      rangeEnd: 1023,
      clientId: 'c1',
    });
  });

  it('rejects missing transferId', () => {
    expect(() =>
      validatePayload(WSMessageType.CMD_FETCH_FILE, { token: 't' }),
    ).toThrow(InvalidPayloadError);
  });

  it('rejects negative range', () => {
    expect(() =>
      validatePayload(WSMessageType.CMD_FETCH_FILE, { transferId: 't', token: 'k', rangeStart: -1 }),
    ).toThrow(InvalidPayloadError);
  });
});

describe('validatePayload — CMD_CANCEL_TRANSFER', () => {
  it('accepts valid payload', () => {
    const p = validatePayload(WSMessageType.CMD_CANCEL_TRANSFER, {
      transferId: 't1',
      reason: 'user_cancel',
    });
    expect(p).toEqual({ transferId: 't1', reason: 'user_cancel' });
  });

  it('accepts payload without optional reason', () => {
    const p = validatePayload(WSMessageType.CMD_CANCEL_TRANSFER, { transferId: 't1' });
    expect(p).toEqual({ transferId: 't1', reason: undefined });
  });

  it('rejects invalid reason', () => {
    expect(() =>
      validatePayload(WSMessageType.CMD_CANCEL_TRANSFER, { transferId: 't1', reason: 'bogus' }),
    ).toThrow(InvalidPayloadError);
  });
});

describe('validatePayload — MSG_TEXT', () => {
  it('accepts valid payload', () => {
    const p = validatePayload(WSMessageType.MSG_TEXT, {
      content: 'hello',
      senderId: 'c1',
      senderLabel: 'Web',
    });
    expect(p).toEqual({ content: 'hello', senderId: 'c1', senderLabel: 'Web' });
  });

  it('rejects missing content', () => {
    expect(() =>
      validatePayload(WSMessageType.MSG_TEXT, { senderId: 'c1', senderLabel: 'Web' }),
    ).toThrow(InvalidPayloadError);
  });
});

describe('validatePayload — RESP_FILE_CHUNK', () => {
  it('accepts valid payload with base64 data', () => {
    const p = validatePayload(WSMessageType.RESP_FILE_CHUNK, {
      transferId: 't1',
      seq: 0,
      data: 'aGVsbG8=',
      eof: false,
      totalSize: 1024,
    });
    expect(p).toMatchObject({ transferId: 't1', seq: 0, eof: false });
  });

  it('rejects negative seq', () => {
    expect(() =>
      validatePayload(WSMessageType.RESP_FILE_CHUNK, { transferId: 't1', seq: -1, data: '', eof: true }),
    ).toThrow(InvalidPayloadError);
  });
});

describe('validatePayload — passthrough for unregistered types', () => {
  it('returns payload as-is when no validator exists', () => {
    const payload = { anything: true, nested: { x: 1 } };
    const result = validatePayload(WSMessageType.ACK, payload);
    expect(result).toBe(payload);
  });
});

describe('TransferState enum', () => {
  it('has all required states', () => {
    expect(TransferState.PENDING).toBe('pending');
    expect(TransferState.ACCEPTED).toBe('accepted');
    expect(TransferState.STREAMING).toBe('streaming');
    expect(TransferState.PAUSED).toBe('paused');
    expect(TransferState.CANCELLED).toBe('cancelled');
    expect(TransferState.FAILED).toBe('failed');
    expect(TransferState.COMPLETED).toBe('completed');
  });
});
