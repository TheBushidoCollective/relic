/**
 * Fixed-window per-IP limiting.
 *
 * The app server never emits 401 or 403 on any public endpoint
 * (`spec/service.md` 1.1). Claude Code marks a remote server as needing
 * authentication when it sees either, which would push publishers at an
 * authorization server that does not exist. Rate limiting therefore refuses
 * with 429 and nothing else.
 */

import type { RateLimitConfig } from './config.ts';

interface Window {
  count: number;
  resetAt: number;
}

export interface LimitVerdict {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  peek(key: string, config: RateLimitConfig, now: number): LimitVerdict {
    const window = this.windows.get(key);
    if (window === undefined || now >= window.resetAt) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    if (window.count >= config.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((window.resetAt - now) / 1000)
        ),
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  check(key: string, config: RateLimitConfig, now: number): LimitVerdict {
    const window = this.windows.get(key);

    if (window === undefined || now >= window.resetAt) {
      this.windows.set(key, {
        count: 1,
        resetAt: now + config.windowSeconds * 1000,
      });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    if (window.count >= config.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((window.resetAt - now) / 1000)
        ),
      };
    }

    window.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
