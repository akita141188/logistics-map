import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { MAP_ROUTING_CONFIG } from '../map-routing.config';
import { LatLng } from '../map.types';
import { GeocodeResult } from './nominatim-geocode.service';

interface PhotonProperties {
  name?: string;
  street?: string;
  housenumber?: string;
  district?: string;
  city?: string;
  county?: string;
  state?: string;
  country?: string;
  postcode?: string;
  osm_key?: string;
  osm_value?: string;
}

interface PhotonFeature {
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: PhotonProperties;
}

interface PhotonResponse {
  features?: PhotonFeature[];
}

/**
 * ============ GEOCODER DỰ PHÒNG: PHOTON (Komoot) ============
 *
 * Cũng chạy trên dữ liệu OpenStreetMap như Nominatim, cũng miễn phí và không cần
 * key, nhưng tồn tại ở đây vì hai lý do rất thực tế:
 *
 * 1. **`nominatim.openstreetmap.org` bị chặn ở nhiều mạng Việt Nam.**
 *    Kiểm chứng tại chỗ: tên miền phân giải ra IP Fastly bình thường, nhưng TCP
 *    443 không bắt tay được (bị ép về 127.0.0.1), trong khi `openstreetmap.org`
 *    gốc và `routing.openstreetmap.de` vẫn vào tốt. Tức là chặn theo tên miền
 *    con, không phải hỏng mạng. Không có dự phòng thì ô tìm địa chỉ im lặng trả
 *    về rỗng và người dùng tưởng "gõ sai địa chỉ".
 *
 * 2. **Photon sinh ra để làm autocomplete.** Nominatim cấm gõ-tới-đâu-gọi-tới-đó
 *    và siết 1 request/giây; Photon thì chạy trên Elasticsearch, chấp nhận truy
 *    vấn dở dang ("tran duy h") và trả kết quả xếp hạng theo mức khớp tiền tố.
 *
 * ĐIỂM KHÁC BIỆT KHI XỬ LÝ KẾT QUẢ:
 * Nominatim trả sẵn `display_name` là một chuỗi địa chỉ hoàn chỉnh. Photon trả
 * về các MẢNH rời (`name`, `street`, `housenumber`, `district`, `city`...) — phải
 * tự ghép. Ghép sai thứ tự sẽ ra địa chỉ kiểu Tây ("12 Trần Duy Hưng, Hà Nội,
 * Cầu Giấy"), nên hàm `compose()` dưới đây ghép theo lối Việt Nam:
 * số nhà -> đường -> phường/quận -> tỉnh/thành.
 */
@Injectable({ providedIn: 'root' })
export class PhotonGeocodeService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(MAP_ROUTING_CONFIG);

  /** Ưu tiên kết quả quanh Hà Nội — Photon xếp hạng theo khoảng cách tới điểm này. */
  private static readonly BIAS: LatLng = { lat: 21.0278, lng: 105.8342 };

  search(query: string, limit = 6): Observable<GeocodeResult[]> {
    const term = query.trim();
    if (term.length < 3) return of([]);

    return this.http
      .get<PhotonResponse>(`${this.config.photonBaseUrl}/api/`, {
        params: {
          q: term,
          limit,
          lang: 'default',
          lat: PhotonGeocodeService.BIAS.lat,
          lon: PhotonGeocodeService.BIAS.lng,
        },
      })
      .pipe(
        map((res) =>
          (res.features ?? [])
            .map((f) => this.toResult(f))
            // Photon không có tham số lọc theo quốc gia, phải tự lọc sau.
            .filter((r) => r.displayName.includes('Việt Nam') || r.displayName.includes('Vietnam')),
        ),
        catchError(() => of([])),
      );
  }

  reverse(point: LatLng): Observable<string> {
    return this.http
      .get<PhotonResponse>(`${this.config.photonBaseUrl}/reverse`, {
        params: { lat: point.lat, lon: point.lng },
      })
      .pipe(
        map((res) => {
          const f = res.features?.[0];
          return f ? this.compose(f.properties) : this.coordText(point);
        }),
        catchError(() => of(this.coordText(point))),
      );
  }

  private toResult(feature: PhotonFeature): GeocodeResult {
    const [lng, lat] = feature.geometry.coordinates;
    const p = feature.properties;

    return {
      lat,
      lng,
      displayName: this.compose(p),
      shortName: [p.housenumber, p.name ?? p.street].filter(Boolean).join(' ') || this.compose(p),
      type: p.osm_value ?? p.osm_key ?? '',
    };
  }

  /** Ghép các mảnh địa chỉ theo trật tự Việt Nam, bỏ phần trùng lặp. */
  private compose(p: PhotonProperties): string {
    const head = [p.housenumber, p.street ?? p.name].filter(Boolean).join(' ');

    const parts = [
      head,
      // `name` đã nằm trong `head` khi không có `street` -> tránh lặp hai lần.
      p.street && p.name && p.name !== p.street ? p.name : '',
      p.district,
      p.city ?? p.county,
      p.state,
      p.country,
    ].filter((v): v is string => !!v && v.trim().length > 0);

    return [...new Set(parts)].join(', ');
  }

  private coordText(point: LatLng): string {
    return `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
  }
}
