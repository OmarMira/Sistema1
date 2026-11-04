import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupDownloadBlob, downloadBackup } from '@/lib/backup-download';

const encode = (text: string) => Buffer.from(text, 'utf8').toString('base64');

describe('backup download transport', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([
    ['ASCII compatibility', '{"name":"Company","amount":123.45}\r\n'],
    ['Unicode fidelity', '{"name":"Compañía Ñ","note":"€ 中文 😀"}\r\n'],
  ])('preserves exact saved bytes: %s', async (_name, original) => {
    const blob = backupDownloadBlob(encode(original));
    expect(blob.type).toBe('application/json');
    expect(blob.size).toBe(Buffer.byteLength(original, 'utf8'));
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(Buffer.from(original, 'utf8'));
    expect(await blob.text()).toBe(original);
  });

  describe('browser download lifecycle (mock DOM)', () => {
    let anchor: { href: string; download: string; click: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
    let append: ReturnType<typeof vi.fn>;
    let create: ReturnType<typeof vi.spyOn>;
    let revoke: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.useFakeTimers();
      anchor = { href: '', download: '', click: vi.fn(), remove: vi.fn() };
      append = vi.fn();
      vi.stubGlobal('document', { createElement: vi.fn(() => anchor), body: { appendChild: append } });
      create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:backup-download');
      revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    });

    it('downloads identical bytes with the original filename and releases resources after the click', async () => {
      const original = '{"name":"Compañía Ñ"}';
      downloadBackup(encode(original), 'company_2026-10-30.json');
      expect(create).toHaveBeenCalledTimes(1);
      const blob = create.mock.calls[0][0] as Blob;
      expect(Buffer.from(await blob.arrayBuffer())).toEqual(Buffer.from(original, 'utf8'));
      expect(anchor.href).toBe('blob:backup-download');
      expect(anchor.download).toBe('company_2026-10-30.json');
      expect(append).toHaveBeenCalledExactlyOnceWith(anchor);
      expect(anchor.click).toHaveBeenCalledTimes(1);
      expect(anchor.remove).toHaveBeenCalledTimes(1);
      expect(revoke).not.toHaveBeenCalled();
      vi.runAllTimers();
      expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:backup-download');
    });

    it('propagates a click failure and still cleans up the anchor and object URL', () => {
      anchor.click.mockImplementation(() => { throw new Error('download unavailable'); });
      expect(() => downloadBackup(encode('{}'), 'backup.json')).toThrow('download unavailable');
      expect(anchor.remove).toHaveBeenCalledTimes(1);
      vi.runAllTimers();
      expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:backup-download');
    });

    it.each(['', '%%%'])('rejects unusable transport data without starting a download: %j', (encoded) => {
      expect(() => downloadBackup(encoded, 'backup.json')).toThrow();
      expect(create).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
      expect(anchor.click).not.toHaveBeenCalled();
      expect(revoke).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
