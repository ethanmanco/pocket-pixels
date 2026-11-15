// Where the table server lives.
//   - Published game: wss://pocket-pixels.mancolabs.dev
//   - `npm run dev`: the local server from `npm run server` on port 8787
//   - VITE_SERVER_URL=same-origin: the page and server share one address (local test build)

const PRODUCTION = "wss://pocket-pixels.mancolabs.dev";

export function serverUrl(): string {
  const set = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (set === "same-origin") return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  if (set) return set;
  return import.meta.env.DEV ? `ws://${location.hostname}:8787` : PRODUCTION;
}
