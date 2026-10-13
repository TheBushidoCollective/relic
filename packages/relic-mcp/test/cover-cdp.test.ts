import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import {
  CdpClosedError,
  CdpError,
  type CdpEvent,
  connectPipe,
} from '../src/cover/cdp.ts';

describe('cover cdp client', () => {
  test('correlates request and response over pipe', async () => {
    const toChrome = new PassThrough();
    const fromChrome = new PassThrough();
    const cdp = connectPipe(toChrome, fromChrome);

    let written = '';
    toChrome.on('data', (chunk: Buffer) => {
      written += chunk.toString('utf8');
    });

    const pending = cdp.send('Browser.getVersion');
    expect(written).toBe('{"id":1,"method":"Browser.getVersion"}\0');

    fromChrome.write(
      '{"id":1,"result":{"protocolVersion":"1.3","product":"TestChrome/1.0"}}\0'
    );

    const result = await pending;
    expect(result['product']).toBe('TestChrome/1.0');
    expect(result['protocolVersion']).toBe('1.3');

    cdp.dispose();
  });

  test('rejects with CdpError on error response', async () => {
    const toChrome = new PassThrough();
    const fromChrome = new PassThrough();
    const cdp = connectPipe(toChrome, fromChrome);

    const pending = cdp.send('Page.navigate', { url: 'about:blank' });

    fromChrome.write(
      '{"id":1,"error":{"code":-32602,"message":"Invalid parameters"}}\0'
    );

    let caught: unknown;
    try {
      await pending;
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CdpError);
    const cdpErr = caught as CdpError;
    expect(cdpErr.code).toBe(-32602);
    expect(cdpErr.method).toBe('Page.navigate');
    expect(cdpErr.message).toBe('Invalid parameters');

    cdp.dispose();
  });

  test('handles frames split across chunks', async () => {
    const toChrome = new PassThrough();
    const fromChrome = new PassThrough();
    const cdp = connectPipe(toChrome, fromChrome);

    const pending = cdp.send('Target.getTargets');

    fromChrome.write('{"id":1,"res');
    fromChrome.write('ult":{"target');
    fromChrome.write('Infos":[{"targetId":"t1"}]}}\0');

    const result = await pending;
    expect(result).toEqual({
      targetInfos: [{ targetId: 't1' }],
    });

    cdp.dispose();
  });

  test('handles several frames in a single chunk', async () => {
    const toChrome = new PassThrough();
    const fromChrome = new PassThrough();
    const cdp = connectPipe(toChrome, fromChrome);

    const events: CdpEvent[] = [];
    cdp.onEvent((e) => events.push(e));

    const p1 = cdp.send('Call.one');
    const p2 = cdp.send('Call.two');

    const multiFrameChunk = Buffer.from(
      '{"id":1,"result":{"n":1}}\0{"method":"Test.event1","params":{"a":1}}\0{"id":2,"result":{"n":2}}\0{"method":"Test.event2","params":{"b":2}}\0',
      'utf8'
    );
    fromChrome.write(multiFrameChunk);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual({ n: 1 });
    expect(r2).toEqual({ n: 2 });

    expect(events.length).toBe(2);
    expect(events[0]?.method).toBe('Test.event1');
    expect(events[0]?.params).toEqual({ a: 1 });
    expect(events[1]?.method).toBe('Test.event2');
    expect(events[1]?.params).toEqual({ b: 2 });

    cdp.dispose();
  });

  test('preserves multibyte UTF-8 split across chunk boundaries', async () => {
    const toChrome = new PassThrough();
    const fromChrome = new PassThrough();
    const cdp = connectPipe(toChrome, fromChrome);

    const events: CdpEvent[] = [];
    cdp.onEvent((e) => events.push(e));

    // Euro sign (€) is 3 bytes: 0xE2 0x82 0xAC
    // Party popper (🎉) is 4 bytes: 0xF0 0x9F 0x8E 0x89
    // Japanese kanji (日) is 3 bytes: 0xE6 0x97 0xA5
    const message = JSON.stringify({
      method: 'Test.utf8',
      params: { euro: '€', party: '🎉', kanji: '日' },
    });
    const fullBuffer = Buffer.from(`${message}\0`, 'utf8');

    // Find the position of the euro symbol in the UTF-8 bytes
    const euroByteIndex = fullBuffer.indexOf(Buffer.from('€', 'utf8'));
    expect(euroByteIndex).toBeGreaterThan(0);

    // Split right inside the 3-byte euro symbol (after first byte: 0xE2)
    const splitPoint = euroByteIndex + 1;
    const chunk1 = fullBuffer.subarray(0, splitPoint);
    const chunk2 = fullBuffer.subarray(splitPoint);

    fromChrome.write(chunk1);
    fromChrome.write(chunk2);

    expect(events.length).toBe(1);
    const ev = events[0];
    expect(ev?.method).toBe('Test.utf8');
    expect(ev?.params).toEqual({ euro: '€', party: '🎉', kanji: '日' });

    cdp.dispose();
  });

  test('pending sends reject on close', async () => {
    const toChrome = new PassThrough();
    const fromChrome = new PassThrough();
    const cdp = connectPipe(toChrome, fromChrome);

    const pending1 = cdp.send('Test.hang1');
    const pending2 = cdp.send('Test.hang2');

    cdp.dispose();

    await expect(pending1).rejects.toBeInstanceOf(CdpClosedError);
    await expect(pending2).rejects.toBeInstanceOf(CdpClosedError);

    await expect(cdp.closed).resolves.toBeUndefined();

    // Sends after close reject immediately
    await expect(cdp.send('Test.afterClose')).rejects.toBeInstanceOf(
      CdpClosedError
    );
  });

  test('EPIPE on toChrome stream does not throw and closes connection', async () => {
    const toChrome = new PassThrough();
    const fromChrome = new PassThrough();
    const cdp = connectPipe(toChrome, fromChrome);

    const pending = cdp.send('Test.epipeCall');

    // Simulate EPIPE error on writable stream
    const epipeErr = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    toChrome.emit('error', epipeErr);

    await expect(pending).rejects.toBeInstanceOf(CdpClosedError);
    await expect(cdp.closed).resolves.toBeUndefined();
  });

  test('waitForEvent with predicate and timeout', async () => {
    const toChrome = new PassThrough();
    const fromChrome = new PassThrough();
    const cdp = connectPipe(toChrome, fromChrome);

    const waitPromise = cdp.waitForEvent('Page.loadEventFired', {
      timeoutMs: 1000,
      predicate: (e) => e.params['ready'] === true,
    });

    // Send non-matching event
    fromChrome.write(
      '{"method":"Page.loadEventFired","params":{"ready":false}}\0'
    );

    // Send matching event
    fromChrome.write(
      '{"method":"Page.loadEventFired","params":{"ready":true,"ts":123}}\0'
    );

    const matched = await waitPromise;
    expect(matched.method).toBe('Page.loadEventFired');
    expect(matched.params['ts']).toBe(123);

    // Timeout test
    const timeoutPromise = cdp.waitForEvent('Never.fires', {
      timeoutMs: 25,
    });
    await expect(timeoutPromise).rejects.toThrow('Timed out waiting for event');

    cdp.dispose();
  });

  test('waitForEvent filters by sessionId', async () => {
    const toChrome = new PassThrough();
    const fromChrome = new PassThrough();
    const cdp = connectPipe(toChrome, fromChrome);

    const waitPromise = cdp.waitForEvent('Target.receivedMessage', {
      sessionId: 'sess-target',
      timeoutMs: 1000,
    });

    // Event with different session ID should be ignored
    fromChrome.write(
      '{"method":"Target.receivedMessage","params":{"msg":"other"},"sessionId":"sess-other"}\0'
    );

    // Event with target session ID matches
    fromChrome.write(
      '{"method":"Target.receivedMessage","params":{"msg":"target"},"sessionId":"sess-target"}\0'
    );

    const matched = await waitPromise;
    expect(matched.sessionId).toBe('sess-target');
    expect(matched.params['msg']).toBe('target');

    cdp.dispose();
  });

  test('onEvent unsubscribe stops firing callbacks', () => {
    const toChrome = new PassThrough();
    const fromChrome = new PassThrough();
    const cdp = connectPipe(toChrome, fromChrome);

    let count = 0;
    const unsub = cdp.onEvent(() => {
      count++;
    });

    fromChrome.write('{"method":"Test.event","params":{}}\0');
    expect(count).toBe(1);

    unsub();

    fromChrome.write('{"method":"Test.event","params":{}}\0');
    expect(count).toBe(1);

    cdp.dispose();
  });
});
