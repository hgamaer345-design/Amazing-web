import { isAppleMobile, isLowMemoryDevice } from './device';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Mobile/15E148 Safari/604.1';
const MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.1 Safari/605.1.15';
const ANDROID =
  'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

describe('device profile', () => {
  it('recognises iPhones and iPads (which report a Mac user agent but have touch)', () => {
    expect(isAppleMobile({ userAgent: IPHONE, maxTouchPoints: 5 })).toBe(true);
    expect(isAppleMobile({ userAgent: MAC, maxTouchPoints: 5 })).toBe(true); // iPad
    expect(isAppleMobile({ userAgent: MAC, maxTouchPoints: 0 })).toBe(false); // Mac
  });

  it('uses the low-memory configuration on phones and small-memory devices only', () => {
    expect(isLowMemoryDevice({ userAgent: IPHONE, maxTouchPoints: 5 })).toBe(true);
    expect(isLowMemoryDevice({ userAgent: ANDROID, maxTouchPoints: 5, deviceMemory: 8 })).toBe(true);
    expect(isLowMemoryDevice({ userAgent: WINDOWS, maxTouchPoints: 0, deviceMemory: 4 })).toBe(true);
    expect(isLowMemoryDevice({ userAgent: WINDOWS, maxTouchPoints: 0, deviceMemory: 8 })).toBe(false);
    expect(isLowMemoryDevice({ userAgent: MAC, maxTouchPoints: 0 })).toBe(false);
  });
});
