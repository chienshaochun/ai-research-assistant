import type { BackgroundDiscoveryResult } from './background-discovery.js';
import type { MonitoringRule } from './background-monitor.js';

export interface BackgroundSchedulerDependencies {
  listDueRules(now: string): MonitoringRule[];
  runRule(rule: MonitoringRule, signal: AbortSignal): Promise<BackgroundDiscoveryResult>;
  canRun?(): boolean;
  onResult?(result: BackgroundDiscoveryResult): void;
  onError?(rule: MonitoringRule, error: unknown): void;
  onTick?(now: string): void;
  now?(): Date;
}

export class BackgroundMonitorScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private controller: AbortController | undefined;
  private running = false;

  constructor(
    private readonly dependencies: BackgroundSchedulerDependencies,
    private readonly intervalMs = 60_000,
  ) {
    if (!Number.isInteger(intervalMs) || intervalMs < 10_000 || intervalMs > 3_600_000) {
      throw new Error('背景排程檢查間隔必須是 10 秒到 1 小時的整數毫秒。');
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.intervalMs);
    void this.tick();
  }

  async tick(): Promise<boolean> {
    if (this.running || this.dependencies.canRun?.() === false) return false;
    this.running = true;
    const controller = new AbortController();
    this.controller = controller;
    try {
      const now = (this.dependencies.now ?? (() => new Date()))().toISOString();
      const rules = this.dependencies.listDueRules(now);
      for (const rule of rules) {
        controller.signal.throwIfAborted();
        try {
          const result = await this.dependencies.runRule(rule, controller.signal);
          this.dependencies.onResult?.(result);
        } catch (error) {
          if (controller.signal.aborted) throw error;
          this.dependencies.onError?.(rule, error);
        }
      }
      this.dependencies.onTick?.(now);
      return true;
    } finally {
      if (this.controller === controller) this.controller = undefined;
      this.running = false;
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort(new DOMException('背景監測已停止。', 'AbortError'));
  }

  get active(): boolean {
    return this.running;
  }
}
