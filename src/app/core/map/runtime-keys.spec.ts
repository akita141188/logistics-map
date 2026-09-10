import { describe, expect, it, vi, afterEach } from 'vitest';
import { loadMapRuntimeKeys } from './runtime-keys';

/**
 * Chốt hành vi của lớp nạp key runtime.
 *
 * Đây đúng chỗ đã từng gãy: trước kia key nạp lúc build qua `fileReplacements`,
 * quên cờ `--configuration local` là app chạy với key rỗng mà không báo gì.
 * Các test dưới đảm bảo: có file thì đọc đúng, không có file thì suy biến êm
 * về "không key" chứ không ném lỗi làm chết bootstrap.
 */
describe('loadMapRuntimeKeys', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(impl: () => Promise<Response> | Response) {
    vi.stubGlobal('fetch', vi.fn(impl));
  }

  it('đọc được key khi map-keys.json tồn tại', async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({ googleMapsKey: 'AIza-test', googleMapId: 'MAP_1', vtmapKey: 'vt-test' }),
        { status: 200 },
      ),
    );

    await expect(loadMapRuntimeKeys()).resolves.toEqual({
      googleMapsKey: 'AIza-test',
      googleMapId: 'MAP_1',
      vtmapKey: 'vt-test',
    });
  });

  it('cắt khoảng trắng thừa và bỏ qua field lạ', async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({ googleMapsKey: '  AIza-test  ', _canh_bao: 'x', thua: 1 }),
        { status: 200 },
      ),
    );

    const keys = await loadMapRuntimeKeys();
    expect(keys.googleMapsKey).toBe('AIza-test');
    expect(keys.vtmapKey).toBe('');
    expect(Object.keys(keys).sort()).toEqual(['googleMapId', 'googleMapsKey', 'vtmapKey']);
  });

  it('trả key rỗng khi 404 (chạy bằng nguồn mở) chứ không ném lỗi', async () => {
    stubFetch(() => new Response('Not Found', { status: 404 }));

    await expect(loadMapRuntimeKeys()).resolves.toEqual({
      googleMapsKey: '',
      googleMapId: '',
      vtmapKey: '',
    });
  });

  it('không ném lỗi khi JSON hỏng hoặc mất mạng', async () => {
    stubFetch(() => new Response('{ hong', { status: 200 }));
    await expect(loadMapRuntimeKeys()).resolves.toMatchObject({ googleMapsKey: '' });

    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(loadMapRuntimeKeys()).resolves.toMatchObject({ googleMapsKey: '' });
  });

  it('bỏ qua giá trị sai kiểu thay vì để lọt số/null vào config', async () => {
    stubFetch(() =>
      new Response(JSON.stringify({ googleMapsKey: 12345, vtmapKey: null }), { status: 200 }),
    );

    await expect(loadMapRuntimeKeys()).resolves.toEqual({
      googleMapsKey: '',
      googleMapId: '',
      vtmapKey: '',
    });
  });
});
