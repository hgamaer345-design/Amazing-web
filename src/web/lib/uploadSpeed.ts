/**
 * Smooths upload progress samples into a speed and an ETA, so the estimate doesn't jump
 * around with every progress event.
 */
export class UploadSpeedMeter {
  private last: { loaded: number; at: number } | null = null;
  private speed: number | null = null;

  constructor(private readonly smoothing = 0.2) {}

  /** Feeds a progress sample; returns bytes per second and the remaining seconds (null until known). */
  sample(
    loaded: number,
    total: number,
    now: number,
  ): { bytesPerSec: number | null; etaSeconds: number | null } {
    if (this.last && now > this.last.at && loaded >= this.last.loaded) {
      const instant = ((loaded - this.last.loaded) / (now - this.last.at)) * 1000;
      this.speed = this.speed == null ? instant : this.speed + this.smoothing * (instant - this.speed);
    }
    if (!this.last || now - this.last.at >= 200) this.last = { loaded, at: now };
    const eta = this.speed && this.speed > 0 ? Math.max(0, (total - loaded) / this.speed) : null;
    return { bytesPerSec: this.speed, etaSeconds: loaded >= total ? 0 : eta };
  }
}
