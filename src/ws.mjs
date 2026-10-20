import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptWebSocket(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n` +
    '\r\n',
  );
  let buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  const listeners = new Set();
  let closed = false;

  const conn = {
    onMessage(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    send(value) {
      if (closed) return;
      const payload = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
      socket.write(encodeFrame(payload));
    },
    close() {
      if (closed) return;
      closed = true;
      try { socket.end(); } catch { /* already gone */ }
    },
  };

  const consume = () => {
    while (buffer.length >= 2) {
      const b0 = buffer[0];
      const b1 = buffer[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(1_000_000)) {
          conn.close();
          return;
        }
        length = Number(big);
        offset = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buffer.length < offset + maskLen + length) return;
      let payload = buffer.subarray(offset + maskLen, offset + maskLen + length);
      if (masked) {
        const mask = buffer.subarray(offset, offset + 4);
        const out = Buffer.alloc(length);
        for (let i = 0; i < length; i++) out[i] = payload[i] ^ mask[i % 4];
        payload = out;
      }
      buffer = buffer.subarray(offset + maskLen + length);
      if (opcode === 0x8) { conn.close(); return; }
      if (opcode === 0x9) { socket.write(encodeFrame(payload, 0x8a)); continue; }
      if (opcode === 0x1) {
        const text = payload.toString('utf8');
        for (const fn of listeners) fn(text);
      }
    }
  };

  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 2_000_000) { conn.close(); return; }
    consume();
  });
  socket.on('close', () => { closed = true; });
  socket.on('error', () => { closed = true; });
  consume();
  return conn;
}

function encodeFrame(payload, first = 0x81) {
  const length = payload.length;
  let header;
  if (length < 126) header = Buffer.from([first, length]);
  else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}
