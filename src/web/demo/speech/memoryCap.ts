// Caps the WebAssembly heap ONNX Runtime creates. Its build declares a 4 GiB maximum, which WebKit
// reserves up front (iOS often can't) and lets the heap grow until iOS kills the tab without an
// error. With a smaller maximum, running out of memory becomes an ordinary, reportable failure.
// Must be installed before ONNX Runtime creates its memory (the first session).

const PAGE = 64 * 1024;
let installed = false;

/** Limits every WebAssembly.Memory created from now on to `maxBytes` (stepping down if refused). */
export function capWasmMemory(maxBytes: number): void {
  if (installed || typeof WebAssembly === 'undefined') return;
  installed = true;
  const Native = WebAssembly.Memory;
  const caps = [maxBytes, (maxBytes * 3) / 4, maxBytes / 2].map((b) => Math.floor(b / PAGE));
  function CappedMemory(descriptor: WebAssembly.MemoryDescriptor): WebAssembly.Memory {
    if ((descriptor.maximum ?? Number.POSITIVE_INFINITY) <= caps[0]!) return new Native(descriptor);
    let lastError: unknown;
    for (const maximum of caps) {
      try {
        return new Native({ ...descriptor, maximum: Math.max(maximum, descriptor.initial) });
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }
  CappedMemory.prototype = Native.prototype;
  (WebAssembly as { Memory: unknown }).Memory = CappedMemory;
}
