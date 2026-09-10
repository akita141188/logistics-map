import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { MAP_ROUTING_CONFIG } from '../map-routing.config';
import { LatLng } from '../map.types';

export interface GeocodeResult extends LatLng {
  /** Địa chỉ đầy đủ do Nominatim trả về. */
  displayName: string;
  /** Phần tên ngắn (số nhà + đường) để hiển thị trên chip. */
  shortName: string;
  type: string;
}

interface NominatimItem {
  lat: string;
  lon: string;
  display_name: string;
  name?: string;
  type?: string;
}

/**
 * Geocode / reverse-geocode qua **Nominatim** (OpenStreetMap) — miễn phí, không key.
 *
 * ĐIỀU KHOẢN SỬ DỤNG bắt buộc phải biết trước khi lên production:
 *  - Tối đa **1 request/giây**, không được bulk geocode.
 *  - Phải gửi `User-Agent`/`Referer` định danh ứng dụng. Trình duyệt KHÔNG cho
 *    JS đặt `User-Agent`, nên nếu cần định danh thì phải proxy qua backend.
 *  - Cấm dùng để autocomplete gõ-tới-đâu-gọi-tới-đó nếu không debounce.
 *    -> Ở màn Chỉ đường, ô tìm kiếm đã debounce 400ms + chỉ gọi khi >= 3 ký tự.
 */
@Injectable({ providedIn: 'root' })
export class NominatimGeocodeService {
  private readonly http = inject(HttpClient);
  private readonly config = inject(MAP_ROUTING_CONFIG);

  /** Forward geocode: chuỗi địa chỉ -> danh sách toạ độ ứng viên. */
  search(query: string, limit = 6): Observable<GeocodeResult[]> {
    const term = query.trim();
    if (term.length < 3) return of([]);

    return this.http
      .get<NominatimItem[]>(`${this.config.nominatimBaseUrl}/search`, {
        params: {
          q: term,
          format: 'json',
          addressdetails: '0',
          limit,
          // Giới hạn trong lãnh thổ Việt Nam cho kết quả sát nhu cầu hơn.
          countrycodes: 'vn',
          'accept-language': 'vi',
        },
      })
      .pipe(
        map((items) => items.map((i) => this.toResult(i))),
        catchError(() => of([])),
      );
  }

  /** Reverse geocode: toạ độ -> địa chỉ (dùng khi người dùng click lên bản đồ). */
  reverse(point: LatLng): Observable<string> {
    return this.http
      .get<NominatimItem>(`${this.config.nominatimBaseUrl}/reverse`, {
        params: {
          lat: point.lat,
          lon: point.lng,
          format: 'json',
          'accept-language': 'vi',
        },
      })
      .pipe(
        map((item) => item.display_name),
        catchError(() => of(`${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`)),
      );
  }

  private toResult(item: NominatimItem): GeocodeResult {
    return {
      lat: Number(item.lat),
      lng: Number(item.lon),
      displayName: item.display_name,
      shortName: item.name || item.display_name.split(',').slice(0, 2).join(', '),
      type: item.type ?? '',
    };
  }
}
