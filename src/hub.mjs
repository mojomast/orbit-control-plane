import { randomBytes } from 'node:crypto';

export function createHub() {
  let current = null;
  const pending = new Map();

  function failAll(error) {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  }

  return {
    get connected() { return current != null; },
    attach(conn) {
      if (current) {
        try { current.close(); } catch { /* replaced */ }
        failAll(Object.assign(new Error('connector replaced'), { status: 503 }));
      }
      current = conn;
      conn.onMessage(text => {
        let msg;
        try { msg = JSON.parse(text); } catch { return; }
        if (msg?.type !== 'rpc-result' || !msg.id) return;
        const item = pending.get(msg.id);
        if (!item) return;
        pending.delete(msg.id);
        clearTimeout(item.timer);
        if (msg.ok) item.resolve(msg.data);
        else item.reject(Object.assign(new Error(msg.error || 'connector call failed'), { status: msg.status || 502 }));
      });
    },
    detach(conn) {
      if (current !== conn) return;
      current = null;
      failAll(Object.assign(new Error('connector disconnected'), { status: 503 }));
    },
    rpc(body, timeoutMs = 20_000) {
      if (!current) return Promise.reject(Object.assign(new Error('connector offline'), { status: 503 }));
      const id = randomBytes(8).toString('hex');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Object.assign(new Error('connector timeout'), { status: 504 }));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try { current.send({ type: 'rpc', id, body }); }
        catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(error);
        }
      });
    },
  };
}
