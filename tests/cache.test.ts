import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LRUCache } from '../src/lib/cache';

describe('LRU Cache', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('debe almacenar y recuperar valores respetando el TTL', async () => {
    const cache = new LRUCache<string, string>(10, 50); // 50ms TTL
    cache.set('key1', 'value1');

    expect(cache.get('key1')).toBe('value1');

    // Esperar a que expire
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(cache.get('key1')).toBeNull();
  });

  it('debe desalojar elementos según LRU al exceder la capacidad máxima', () => {
    const cache = new LRUCache<string, number>(3, 60000);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    // Acceder a 'a' para que sea más reciente
    cache.get('a');

    // Insertar un cuarto elemento, debe desalojar 'b' (el menos recientemente usado)
    cache.set('d', 4);

    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')).toBe(1);
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('debe invalidar elementos de manera local y enviar mensaje por BroadcastChannel', () => {
    const postMessageSpy = vi.fn();
    const mockChannel = {
      postMessage: postMessageSpy,
      close: vi.fn(),
    };

    // Usar clase constructora tradicional para evitar error de constructor
    const MockBroadcastChannel = vi.fn().mockImplementation(function (this: any) {
      this.postMessage = mockChannel.postMessage;
      this.close = mockChannel.close;
      return this;
    });

    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);

    const cache = new LRUCache<string, string>(10, 60000, 'test-channel');
    cache.set('x', 'y');
    expect(cache.get('x')).toBe('y');

    cache.invalidate('x');

    expect(cache.get('x')).toBeNull();
    expect(postMessageSpy).toHaveBeenCalledWith({ type: 'invalidate', key: 'x' });
  });

  it('debe limpiar todo el cache y enviar mensaje de clear por BroadcastChannel', () => {
    const postMessageSpy = vi.fn();
    const mockChannel = {
      postMessage: postMessageSpy,
      close: vi.fn(),
    };

    const MockBroadcastChannel = vi.fn().mockImplementation(function (this: any) {
      this.postMessage = mockChannel.postMessage;
      this.close = mockChannel.close;
      return this;
    });

    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);

    const cache = new LRUCache<string, string>(10, 60000, 'test-channel');
    cache.set('k1', 'v1');
    cache.set('k2', 'v2');

    cache.clear();

    expect(cache.get('k1')).toBeNull();
    expect(cache.get('k2')).toBeNull();
    expect(postMessageSpy).toHaveBeenCalledWith({ type: 'clear' });
  });
});
