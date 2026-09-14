/**
 * Protocol validation errors (V2 Transfer Engine, RB-P0-06).
 *
 * Thrown by parseEnvelope() / validateMessage() when an incoming WS message
 * fails structural or semantic validation. Consumers should treat these as
 * "malformed client input" — log at warn level, optionally reply with an
 * ERROR frame, and never crash the socket.
 */

export class ProtocolError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.details = details;
  }
}

/** Message envelope missing required top-level fields. */
export class InvalidEnvelopeError extends ProtocolError {
  constructor(message: string, details?: unknown) {
    super('INVALID_ENVELOPE', message, details);
    this.name = 'InvalidEnvelopeError';
  }
}

/** Payload failed schema validation for its declared type. */
export class InvalidPayloadError extends ProtocolError {
  readonly type: string;

  constructor(type: string, message: string, details?: unknown) {
    super('INVALID_PAYLOAD', message, details);
    this.name = 'InvalidPayloadError';
    this.type = type;
  }
}

/** Binary frame could not be decoded (wrong version, truncated, etc.). */
export class InvalidBinaryFrameError extends ProtocolError {
  constructor(message: string, details?: unknown) {
    super('INVALID_BINARY_FRAME', message, details);
    this.name = 'InvalidBinaryFrameError';
  }
}
