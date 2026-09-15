import { describe, expect, test } from 'bun:test';
import { HOSTED_SERVICE_ORIGIN, isHostedService } from '@relic/format';
import {
  DEFAULT_SERVICE_ORIGIN,
  requiredOrigin,
  resolveOrigin,
} from '../src/origin.ts';

describe('requiredOrigin', () => {
  test('accepts an https origin', () => {
    expect(requiredOrigin('X', 'https://relic.example')).toBe(
      'https://relic.example'
    );
  });

  test('keeps the port, which a self-hosted deployment needs', () => {
    expect(requiredOrigin('X', 'https://relic.example:8443')).toBe(
      'https://relic.example:8443'
    );
  });

  test('drops a path rather than concatenating it into every request', () => {
    expect(requiredOrigin('X', 'https://relic.example/api/')).toBe(
      'https://relic.example'
    );
  });

  test('tolerates whitespace, which env files reliably introduce', () => {
    expect(requiredOrigin('X', '  https://relic.example  ')).toBe(
      'https://relic.example'
    );
  });

  // `requiredOrigin` still refuses, for the callers that have no default to
  // fall back on. What changed is that resolving the service origin is no
  // longer one of them; see the `resolveOrigin` block below.
  test('refuses an unset value and names the variable', () => {
    expect(() => requiredOrigin('RELIC_SERVICE_ORIGIN', undefined)).toThrow(
      /RELIC_SERVICE_ORIGIN is not set/
    );
  });

  test('refuses an empty or whitespace-only value', () => {
    expect(() => requiredOrigin('X', '')).toThrow(/is not set/);
    expect(() => requiredOrigin('X', '   ')).toThrow(/is not set/);
  });

  test('refuses something that is not a URL', () => {
    expect(() => requiredOrigin('X', 'relic.example')).toThrow(/is not a URL/);
  });

  // The plaintext is already encrypted by the time anything is sent, but the
  // grant that authorizes the upload is a bearer credential in flight.
  test('refuses plaintext http to a real host', () => {
    expect(() => requiredOrigin('X', 'http://relic.example')).toThrow(
      /must be https/
    );
  });

  test.each([
    ['http://localhost:7333', 'http://localhost:7333'],
    ['http://127.0.0.1:7333', 'http://127.0.0.1:7333'],
    ['http://[::1]:7333', 'http://[::1]:7333'],
  ])('allows http on loopback for development: %s', (input, expected) => {
    expect(requiredOrigin('X', input)).toBe(expected);
  });
});

describe('resolveOrigin', () => {
  test('an unset value is the hosted service, not an error', () => {
    // The reversal, asserted rather than described. The hosted service was
    // printing its own address as a variable a reader had to set, which asks
    // somebody using a hosted product to configure which host they are on.
    expect(resolveOrigin('RELIC_SERVICE_ORIGIN', undefined)).toBe(
      HOSTED_SERVICE_ORIGIN
    );
    expect(resolveOrigin('RELIC_SERVICE_ORIGIN', '')).toBe(
      HOSTED_SERVICE_ORIGIN
    );
    expect(resolveOrigin('RELIC_SERVICE_ORIGIN', '   ')).toBe(
      HOSTED_SERVICE_ORIGIN
    );
  });

  test('a named origin still wins, and is still validated', () => {
    // The default must not become a way to smuggle a bad value past the
    // checks: anything named goes through exactly the rules it always did.
    expect(resolveOrigin('X', 'https://relic.example')).toBe(
      'https://relic.example'
    );
    expect(() => resolveOrigin('X', 'http://relic.example')).toThrow(
      /must be https/
    );
    expect(() => resolveOrigin('X', 'relic.example')).toThrow(/is not a URL/);
  });

  test('the default is a real address, which is why it is not a placeholder', () => {
    // The half of the old reasoning that survived: a placeholder default
    // would turn a configuration mistake into a DNS failure later.
    expect(() => new URL(HOSTED_SERVICE_ORIGIN)).not.toThrow();
    expect(new URL(HOSTED_SERVICE_ORIGIN).protocol).toBe('https:');
    expect(DEFAULT_SERVICE_ORIGIN).toBe(HOSTED_SERVICE_ORIGIN);
  });
});

describe('isHostedService', () => {
  test('recognises the hosted service, however the origin is written', () => {
    expect(isHostedService('https://relik.link')).toBe(true);
    expect(isHostedService('https://relik.link/')).toBe(true);
    expect(isHostedService('https://relik.link/install')).toBe(true);
  });

  test('anything else is somebody running their own', () => {
    expect(isHostedService('https://relic.example')).toBe(false);
    expect(isHostedService('http://localhost:8080')).toBe(false);
    // Unparseable is self-hosted by definition: the hosted address parses.
    expect(isHostedService('not a url')).toBe(false);
  });
});
