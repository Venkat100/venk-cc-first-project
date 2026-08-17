// jsdom has no real layout engine: `getBoundingClientRect()` always reports
// 0x0 and there is no `ResizeObserver`, so Recharts' `ResponsiveContainer`
// either throws (no ResizeObserver at all) or silently renders zero SVG
// children (ResizeObserver present but never fires a callback, matching
// jsdom's own default "no observer" behavior) — the underlying reason the
// suite's original browser-verify-only coverage of chart rendering existed.
// Call this in a `beforeEach` to give any Recharts-based component a real
// (fake) container size, so it renders its actual SVG — axis ticks, tooltip
// content, `<Pie>` paths — the same as a real browser would.
export function mockRechartsContainer(width = 600, height = 300): void {
  class ResizeObserverStub implements ResizeObserver {
    #callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.#callback = callback;
    }
    observe(target: Element) {
      const rect = { width, height, top: 0, left: 0, bottom: height, right: width, x: 0, y: 0, toJSON: () => ({}) };
      this.#callback([{ target, contentRect: rect } as ResizeObserverEntry], this);
    }
    unobserve() {}
    disconnect() {}
  }
  globalThis.ResizeObserver = ResizeObserverStub;
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => ({ width, height, top: 0, left: 0, bottom: height, right: width, x: 0, y: 0, toJSON: () => ({}) }),
  });
}
