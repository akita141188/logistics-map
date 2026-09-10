import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { MAP_ROUTING_CONFIG } from './map-routing.config';
import { MapProvider } from './map.types';

/**
 * Chọn nhà cung cấp bản đồ đang dùng.
 *
 * Luật gốc (bản DMS thật):
 *  1. Cờ `isShowOtherMap` lấy từ Firebase Remote Config, lưu localStorage lúc login.
 *  2. `isShowOtherMap = false`  -> LUÔN dùng Viettel Map.
 *  3. `isShowOtherMap = true`   -> lấy giá trị đầu tiên của app setting `USE_TYPE_MAP`.
 *  4. App setting rỗng          -> fallback Viettel Map.
 *
 * Trong demo này bổ sung `setProvider()` để người dùng đổi provider ngay trên UI,
 * lựa chọn được nhớ trong localStorage giữa các lần mở app.
 */
@Injectable({ providedIn: 'root' })
export class MapProviderService {
  private static readonly STORAGE_KEY = 'MAP_CONFIG';
  private static readonly SELECTED_KEY = 'MAP_PROVIDER';
  private static readonly APP_SETTING_ID = 'USE_TYPE_MAP';

  private readonly config = inject(MAP_ROUTING_CONFIG);
  private readonly _provider = signal<MapProvider>(this.restore());

  /** Provider đang dùng — đọc ở template hoặc trong `effect`. */
  readonly provider = this._provider.asReadonly();

  readonly isViettel = computed(() => this._provider() === MapProvider.Viettel);
  readonly isGoogle = computed(() => this._provider() === MapProvider.Google);
  readonly isOpenStreet = computed(() => this._provider() === MapProvider.OpenStreet);

  /** Provider đó đã đủ cấu hình để chạy chưa (OSM không cần key). */
  readonly missingKey = computed(() => {
    switch (this._provider()) {
      case MapProvider.Viettel:
        return !this.config.vtmapKey;
      case MapProvider.Google:
        return !this.config.googleMapsKey;
      default:
        return false;
    }
  });

  constructor() {
    effect(() => {
      localStorage.setItem(MapProviderService.SELECTED_KEY, this._provider());
    });
  }

  setProvider(provider: MapProvider): void {
    this._provider.set(provider);
  }

  /** Gọi sau khi login xong — tương đương `useMap()` trong store user của bản Vue. */
  resolveProvider(appSettings: readonly { id: string; values?: string[] }[] = []): MapProvider {
    const values =
      appSettings.find((s) => s.id === MapProviderService.APP_SETTING_ID)?.values ?? [];

    const next =
      this.isShowOtherMap() && values.length ? (values[0] as MapProvider) : MapProvider.Viettel;

    this._provider.set(next);
    return next;
  }

  /** Ghi cờ Remote Config vào localStorage — gọi ở màn Login. */
  setShowOtherMap(isShowOtherMap: boolean): void {
    localStorage.setItem(MapProviderService.STORAGE_KEY, JSON.stringify({ isShowOtherMap }));
  }

  private isShowOtherMap(): boolean {
    try {
      const raw = localStorage.getItem(MapProviderService.STORAGE_KEY);
      return !!(raw ? JSON.parse(raw)?.isShowOtherMap : false);
    } catch {
      // localStorage có rác/JSON hỏng -> coi như không bật, an toàn về Viettel Map.
      return false;
    }
  }

  /** Provider này đã đủ key để chạy chưa. OSM không cần key nên luôn hợp lệ. */
  private hasKeyFor(provider: MapProvider): boolean {
    switch (provider) {
      case MapProvider.Viettel:
        return !!this.config.vtmapKey;
      case MapProvider.Google:
        return !!this.config.googleMapsKey;
      default:
        return true;
    }
  }

  /**
   * Khôi phục lựa chọn cũ từ localStorage — nhưng phải KIỂM TRA KEY, không chỉ
   * kiểm tra chuỗi có nằm trong enum.
   *
   * Tình huống thật: hôm trước chọn Google (máy có `map-keys.json`), hôm sau kéo
   * repo về máy khác không có file key. Bản cũ vẫn khôi phục Google rồi mới báo
   * "thiếu API key" — app mắc kẹt ở một provider chết, trái hẳn với lời hứa
   * "không có key thì chạy bằng OpenStreetMap".
   *
   * Rơi về `defaultProvider`, và nếu chính nó cũng thiếu key thì về OSM — nguồn
   * duy nhất chắc chắn chạy được.
   */
  private restore(): MapProvider {
    const saved = localStorage.getItem(MapProviderService.SELECTED_KEY);
    const valid = Object.values(MapProvider) as string[];

    if (saved && valid.includes(saved) && this.hasKeyFor(saved as MapProvider)) {
      return saved as MapProvider;
    }

    return this.hasKeyFor(this.config.defaultProvider)
      ? this.config.defaultProvider
      : MapProvider.OpenStreet;
  }
}
