// Minimal JSDOM bootstrap for the web test runner.
//
// Why this exists: the BG4 Codex review flagged that the Navigation
// interaction tests simulated state instead of exercising the
// production component. Mounting the real `<Navigation />` (which
// uses `useState`, `useEffect`, `useCallback`, `window.addEventListener`,
// and React 18's concurrent renderer) requires a real DOM. The web
// test runner is Node's built-in `node:test`; without a DOM the React
// 18 `act()` helper refuses to commit and `react-dom/client`
// `createRoot` cannot mount.
//
// Scope: only the globals actually consumed by `<Navigation />`,
// `<SessionProvider />`, `react-dom/client`, and `react-dom/test-utils`.
// We deliberately do NOT polyfill `matchMedia`, `ResizeObserver`, or
// `IntersectionObserver` because the production Navigation does not
// call them. Adding unneeded polyfills is a smell that hides future
// runtime regressions.
//
// Order matters: this module is registered with `--import
// ./src/test-setup.mjs` so it runs BEFORE `--import tsx`. The setup
// is plain JS so it does not need a TypeScript loader; tests written
// in `.ts` / `.tsx` are still transformed by `tsx` on the next import
// hook.

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost:3000/",
  pretendToBeVisual: true,
});

const { window } = dom;

// Mirror the DOM globals that React 18 and the production
// `Navigation` actually touch onto `globalThis` so production code
// that reads `window.addEventListener`, `document.createElement`,
// `HTMLElement`, etc. works inside the test process.
//
// A few of these are read-only in newer Node versions (e.g.
// `navigator`), so guard the assignments.
function defineGlobal(name, value) {
  try {
    globalThis[name] = value;
  } catch {
    Object.defineProperty(globalThis, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
  }
}

defineGlobal("window", window);
defineGlobal("document", window.document);
defineGlobal("navigator", window.navigator);
defineGlobal("HTMLElement", window.HTMLElement);
defineGlobal("Node", window.Node);
defineGlobal("Element", window.Element);
defineGlobal("Event", window.Event);
defineGlobal("KeyboardEvent", window.KeyboardEvent);
defineGlobal("MouseEvent", window.MouseEvent);
defineGlobal("getComputedStyle", window.getComputedStyle.bind(window));

// Next.js's `<Link>` uses `self.requestIdleCallback` (a browser-only
// API that JSDOM does not expose). Without `self`, its fallback path
// throws `self is not defined` during commit. The Navigation renders
// Next.js Links, so the test bootstrap needs `self` too.
defineGlobal("self", window);

// React 18 refuses to commit inside `act()` unless this flag is set.
// Without it, every `act()` call logs "The current testing environment
// is not configured to support ReactDOM.act(...)" and exits as a
// no-op, which would silently mask real interaction regressions.
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Helper: clear the document body between tests so each case mounts
// into a fresh container.
globalThis.resetDom = function resetDom() {
  document.body.innerHTML = "";
};
