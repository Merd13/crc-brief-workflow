// Chrome native messaging: each message is a 4-byte length in native byte order
// (little-endian on every platform this helper supports), then that many bytes of UTF-8 JSON.

/** Chrome refuses a message from a host that is larger than this. */
export const MAX_OUTGOING = 1024 * 1024;
/** Chrome never sends a larger message to a host. */
export const MAX_INCOMING = 64 * 1024 * 1024;

/** @returns {Buffer} the framed message */
export function encodeMessage(value) {
  const json = Buffer.from(JSON.stringify(value), "utf8");
  if (json.length > MAX_OUTGOING) throw new Error(`Message too large for Chrome: ${json.length} bytes.`);
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  return Buffer.concat([header, json]);
}

/**
 * Returns a function to feed with chunks from stdin. It calls `onMessage` for each
 * complete message, however the bytes were split across chunks.
 * @param {(message: unknown) => void} onMessage
 * @param {(error: Error) => void} onError
 * @returns {(chunk: Buffer) => void}
 */
export function createDecoder(onMessage, onError) {
  let buffer = Buffer.alloc(0);
  let failed = false;
  return (chunk) => {
    if (failed) return;
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > MAX_INCOMING) {
        // The stream cannot be trusted after a bad length: stop reading it.
        failed = true;
        buffer = Buffer.alloc(0);
        onError(new Error(`Message too large: ${length} bytes.`));
        return;
      }
      if (buffer.length < 4 + length) return;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      let message;
      try {
        message = JSON.parse(body.toString("utf8"));
      } catch {
        onError(new Error("Message is not valid JSON."));
        continue;
      }
      onMessage(message);
    }
  };
}
