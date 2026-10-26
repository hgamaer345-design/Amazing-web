import { capWasmMemory } from './memoryCap';

describe('capWasmMemory', () => {
  it('lowers the maximum of new WebAssembly memories so growth past it fails instead of continuing', () => {
    capWasmMemory(8 * 1024 * 1024); // 128 pages
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 65536 });
    expect(memory).toBeInstanceOf(WebAssembly.Memory);
    expect(() => memory.grow(127)).not.toThrow();
    expect(() => memory.grow(1)).toThrow(RangeError);
    // Memories already within the cap are created as asked.
    const small = new WebAssembly.Memory({ initial: 1, maximum: 2 });
    expect(() => small.grow(2)).toThrow(RangeError);
  });
});
