// What kind of device the in-browser demo runs on. Phones give a web page far less memory than a
// computer (iOS kills the whole tab, without any error, at roughly 1–1.5 GB), so they get a
// lighter configuration: one thread, a capped WebAssembly heap, smaller batches, Standard quality
// by default and shorter recordings.

/** iPhone, iPod, or iPad (iPadOS reports a Mac user agent, but has touch). */
export function isAppleMobile(nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> = navigator): boolean {
  return /iP(hone|ad|od)/.test(nav.userAgent) || (/Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1);
}

/** True on devices that should use the low-memory configuration. */
export function isLowMemoryDevice(
  nav: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> & { deviceMemory?: number } = navigator,
): boolean {
  if (isAppleMobile(nav)) return true;
  // Chromium reports approximate RAM in GB (Android phones, low-end laptops).
  if (nav.deviceMemory !== undefined && nav.deviceMemory <= 4) return true;
  return /Android.+Mobile/.test(nav.userAgent);
}

export const LITE_DEVICE = typeof navigator !== 'undefined' && isLowMemoryDevice();
