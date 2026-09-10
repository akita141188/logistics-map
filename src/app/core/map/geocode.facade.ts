import { Injectable, inject, signal } from '@angular/core';
import { Observable, from, of } from 'rxjs';
import { catchError, map, switchMap, tap } from 'rxjs/operators';
import { GoogleGeocodeService } from './google/google-geocode.service';
import { MapProviderService } from './map-provider.service';
import { MAP_ROUTING_CONFIG } from './map-routing.config';
import { LatLng, MapProvider } from './map.types';
import { GeocodeResult, NominatimGeocodeService } from './osm/nominatim-geocode.service';
import { PhotonGeocodeService } from './osm/photon-geocode.service';

/** Dịch vụ geocode thực sự đã trả về kết quả. */
export type GeocodeSource = 'google' | 'nominatim' | 'photon' | 'none';

const SOURCE_LABEL: Record<GeocodeSource, string> = {
  google: 'Google Geocoding',
  nominatim: 'Nominatim (OpenStreetMap)',
  photon: 'Photon (OpenStreetMap)',
  none: 'chưa tra cứu',
};

/**
 * Cửa duy nhất để tra cứu địa chỉ, song song với `RoutingFacade`.
 *
 * | Provider | Thứ tự thử                        | Chất lượng địa chỉ VN             |
 * |----------|-----------------------------------|-----------------------------------|
 * | GMAP     | Google -> Nominatim -> Photon     | Tốt nhất — có số nhà, tên toà nhà |
 * | VTMAP    | Nominatim -> Photon               | Trung bình                        |
 * | OSMAP    | Nominatim -> Photon               | Trung bình                        |
 *
 * VÌ SAO PHẢI CÓ CHUỖI DỰ PHÒNG (chứ không chỉ một dịch vụ):
 *
 *  - `nominatim.openstreetmap.org` bị chặn ở nhiều mạng doanh nghiệp/nhà mạng VN
 *    (đo được tại chỗ). Chỉ dùng Nominatim thì ô tìm kiếm trả rỗng và **không
 *    báo lỗi gì cả** — người dùng tưởng mình gõ sai địa chỉ.
 *  - Google có thể hết quota, key bị chặn referrer, hoặc bị vô hiệu hoá bất chợt.
 *
 * Rơi tầng phải ÂM THẦM về mặt chức năng nhưng MINH BẠCH về mặt hiển thị: ô tìm
 * kiếm luôn hiện tên dịch vụ vừa trả kết quả (`activeSource`), để khi có nghi vấn
 * chất lượng địa chỉ thì biết ngay nó đến từ đâu.
 *
 * VÌ SAO KHÔNG GỌI Google Places Autocomplete:
 * Places tính tiền theo từng phím gõ (đắt hơn Geocoding nhiều lần) và bắt buộc
 * hiển thị logo "Powered by Google". Với demo thì Geocoding đủ.
 */
@Injectable({ providedIn: 'root' })
export class GeocodeFacade {
  private readonly nominatim = inject(NominatimGeocodeService);
  private readonly photon = inject(PhotonGeocodeService);
  private readonly google = inject(GoogleGeocodeService);
  private readonly mapProvider = inject(MapProviderService);
  private readonly config = inject(MAP_ROUTING_CONFIG);

  private readonly _activeSource = signal<GeocodeSource>('none');

  /** Dịch vụ đã trả kết quả cho lần tra cứu gần nhất. */
  readonly activeSource = this._activeSource.asReadonly();

  /** Tên dịch vụ đang dùng — để hiển thị dưới ô tìm kiếm cho minh bạch. */
  providerLabel(): string {
    const active = this._activeSource();
    if (active !== 'none') return SOURCE_LABEL[active];
    return this.useGoogle() ? SOURCE_LABEL.google : SOURCE_LABEL.nominatim;
  }

  /**
   * Forward geocode: chuỗi địa chỉ -> danh sách ứng viên.
   *
   * LƯU Ý: `NominatimGeocodeService.search` tự nuốt lỗi và trả `[]`, nên KHÔNG
   * thể dùng `catchError` để bắt trường hợp nó chết. Phải kiểm tra "mảng rỗng"
   * rồi mới rơi sang Photon — đó là lý do có `switchMap` thay vì `catchError`.
   */
  search(query: string, limit = 6): Observable<GeocodeResult[]> {
    const term = query.trim();
    if (term.length < 3) return of([]);

    const osmChain = this.nominatim.search(term, limit).pipe(
      switchMap((items) =>
        items.length
          ? of(items).pipe(tap(() => this._activeSource.set('nominatim')))
          : this.photon.search(term, limit).pipe(
              tap((photonItems) =>
                this._activeSource.set(photonItems.length ? 'photon' : 'none'),
              ),
            ),
      ),
    );

    if (!this.useGoogle()) return osmChain;

    return from(this.google.searchMany(term, limit)).pipe(
      switchMap((items) =>
        items.length ? of(items).pipe(tap(() => this._activeSource.set('google'))) : osmChain,
      ),
      catchError(() => osmChain),
    );
  }

  /** Reverse geocode: toạ độ -> địa chỉ. */
  reverse(point: LatLng): Observable<string> {
    const fallbackText = `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;

    const osmChain = this.nominatim.reverse(point).pipe(
      switchMap((address) =>
        address && address !== fallbackText ? of(address) : this.photon.reverse(point),
      ),
    );

    if (!this.useGoogle()) return osmChain;

    return from(this.google.getAddress(point)).pipe(
      switchMap((address) => (address ? of(address) : osmChain)),
      map((address) => address || fallbackText),
      catchError(() => osmChain),
    );
  }

  private useGoogle(): boolean {
    return this.mapProvider.provider() === MapProvider.Google && !!this.config.googleMapsKey;
  }
}
