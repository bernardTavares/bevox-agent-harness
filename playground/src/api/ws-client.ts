import { useEffect } from "react";
import useWebSocket, { ReadyState } from "react-use-websocket";

import { useStore } from "../state/store";
import type { DevEvent, DevWireMessage } from "../state/types";

const DEFAULT_WS_URL = "ws://127.0.0.1:4400";

export function useDevWebSocket(url: string = DEFAULT_WS_URL) {
  const ingest = useStore((s) => s.ingest);
  const setConnected = useStore((s) => s.setWsConnected);

  const ws = useWebSocket(url, {
    shouldReconnect: () => true,
    reconnectInterval: 1500,
    reconnectAttempts: Number.POSITIVE_INFINITY,
    share: true,
    onMessage: (msg) => {
      try {
        const parsed = JSON.parse(msg.data) as DevWireMessage;
        if (parsed.kind === "hello") return;
        ingest(parsed as DevEvent);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("ws parse error", err);
      }
    },
  });

  useEffect(() => {
    setConnected(ws.readyState === ReadyState.OPEN);
  }, [ws.readyState, setConnected]);

  return ws;
}
