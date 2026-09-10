import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MAP_ROUTING_CONFIG,
  MAP_ROUTING_CONFIG,
  MapRoutingConfig,
} from './map-routing.config';
import { MapProviderService } from './map-provider.service';
import { MapProvider } from './map.types';

/**
 * ============ KHÔI PHỤC PROVIDER PHẢI KÈM KIỂM TRA KEY ============
 *
 * Kịch bản thật: hôm trước chọn Google trên máy có `map-keys.json`; hôm sau mở
 * cùng dự án trên máy khác không có file key. Bản cũ chỉ kiểm tra chuỗi lưu
 * trong localStorage có nằm trong enum hay không, nên vẫn khôi phục Google rồi
 * mới báo "thiếu API key" — app mắc kẹt ở một provider chết, trái hẳn lời hứa
 * "không có key thì chạy bằng OpenStreetMap".
 */
function setup(config: Partial<MapRoutingConfig> = {}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: MAP_ROUTING_CONFIG, useValue: { ...DEFAULT_MAP_ROUTING_CONFIG, ...config } },
      MapProviderService,
    ],
  });
  return TestBed.inject(MapProviderService);
}

describe('MapProviderService — khôi phục lựa chọn cũ', () => {
  beforeEach(() => localStorage.clear());

  it('lưu Google nhưng runtime KHÔNG còn key -> không khôi phục Google', () => {
    localStorage.setItem('MAP_PROVIDER', MapProvider.Google);

    const service = setup({ googleMapsKey: '' });

    expect(service.provider()).not.toBe(MapProvider.Google);
    expect(service.missingKey()).toBe(false);
  });

  it('lưu Viettel nhưng không có token -> không khôi phục Viettel', () => {
    localStorage.setItem('MAP_PROVIDER', MapProvider.Viettel);

    const service = setup({ vtmapKey: '' });

    expect(service.provider()).not.toBe(MapProvider.Viettel);
    expect(service.missingKey()).toBe(false);
  });

  it('lưu Google và runtime CÓ key -> khôi phục đúng lựa chọn', () => {
    localStorage.setItem('MAP_PROVIDER', MapProvider.Google);

    const service = setup({ googleMapsKey: 'AIza-test' });

    expect(service.provider()).toBe(MapProvider.Google);
  });

  it('OSM luôn khôi phục được vì không cần key', () => {
    localStorage.setItem('MAP_PROVIDER', MapProvider.OpenStreet);

    expect(setup({ googleMapsKey: '', vtmapKey: '' }).provider()).toBe(MapProvider.OpenStreet);
  });

  it('defaultProvider cũng thiếu key -> rơi về OSM chứ không kẹt', () => {
    localStorage.setItem('MAP_PROVIDER', 'RAC_VO_NGHIA');

    const service = setup({ defaultProvider: MapProvider.Viettel, vtmapKey: '' });

    expect(service.provider()).toBe(MapProvider.OpenStreet);
  });

  it('người dùng vẫn chủ động chọn được provider thiếu key (để thấy hướng dẫn cấu hình)', () => {
    const service = setup({ googleMapsKey: '' });

    service.setProvider(MapProvider.Google);

    expect(service.provider()).toBe(MapProvider.Google);
    expect(service.missingKey()).toBe(true);
  });
});
