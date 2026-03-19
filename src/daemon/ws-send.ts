export interface JsonWritableSocket {
  send(data: string, cb?: (err?: Error) => void): void;
}

/**
 * Resolve only after the websocket library confirms the JSON payload was
 * written to the socket buffer. This is the daemon's transport commit point
 * for optimistic relay semantics.
 */
export function sendJsonOverSocket(
  ws: JsonWritableSocket,
  payload: Record<string, unknown>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.send(JSON.stringify(payload), (err?: Error) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}
