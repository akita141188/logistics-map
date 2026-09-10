import { Injectable, inject } from '@angular/core';
import { LatLng } from '../map.types';
import { GeocodeResult } from '../osm/nominatim-geocode.service';
import { GoogleMapsLoaderService } from './google-maps-loader.service';

/**
 * Geocode qua Google Maps JS SDK.
 *
 * Không dùng cho chỉ đường, nhưng luôn đi kèm màn chọn vị trí khách hàng/NPP.
 *
 * Bản gốc dùng `@googlemaps/js-api-loader`; ở đây tái sử dụng
 * `GoogleMapsLoaderService` để cả app chỉ có MỘT chỗ nạp SDK Google — tránh
 * cảnh báo "You have included the Google Maps JavaScript API multiple times".
 */
@Injectable({ providedIn: 'root' })
export class GoogleGeocodeService {
  private readonly loader = inject(GoogleMapsLoaderService);

  private geocoder?: google.maps.Geocoder;

  /** Reverse geocode: toạ độ -> địa chỉ đầy đủ. */
  async getAddress(point: LatLng): Promise<string | undefined> {
    const geocoder = await this.getGeocoder();
    const { results } = await geocoder.geocode({ location: point });
    return results[0]?.formatted_address;
  }

  /** Forward geocode: địa chỉ -> toạ độ. */
  async getCoordinate(address: string): Promise<LatLng | undefined> {
    const geocoder = await this.getGeocoder();
    const { results } = await geocoder.geocode({ address });

    const location = results[0]?.geometry.location;
    return location ? { lat: location.lat(), lng: location.lng() } : undefined;
  }

  /**
   * Forward geocode trả về NHIỀU ứng viên cho ô tìm kiếm.
   *
   * Kết quả được chuẩn hoá về đúng `GeocodeResult` của Nominatim để tầng UI
   * không phải biết mình đang nói chuyện với dịch vụ nào.
   *
   * `componentRestrictions.country` giới hạn trong VN — không có nó thì gõ
   * "Hai Bà Trưng" sẽ ra kết quả ở tận nước ngoài.
   */
  async searchMany(address: string, limit = 6): Promise<GeocodeResult[]> {
    const geocoder = await this.getGeocoder();

    // Geocoder REJECT (không phải trả mảng rỗng) khi status = ZERO_RESULTS,
    // nên phải bắt lỗi tại đây, nếu không ô tìm kiếm sẽ văng exception.
    const response = await geocoder
      .geocode({ address, componentRestrictions: { country: 'VN' }, region: 'VN' })
      .catch(() => null);

    if (!response) return [];

    return response.results.slice(0, limit).map((r) => this.toResult(r));
  }

  private toResult(result: google.maps.GeocoderResult): GeocodeResult {
    const loc = result.geometry.location;
    const formatted = result.formatted_address;

    return {
      lat: loc.lat(),
      lng: loc.lng(),
      displayName: formatted,
      // Lấy 2 thành phần đầu (số nhà + đường) cho gọn chip hiển thị.
      shortName: formatted.split(',').slice(0, 2).join(', ').trim() || formatted,
      type: result.types?.[0] ?? '',
    };
  }

  private async getGeocoder(): Promise<google.maps.Geocoder> {
    await this.loader.load();

    // `importLibrary` là API khuyến nghị hiện nay; truy cập thẳng
    // `new google.maps.Geocoder()` vẫn chạy nhưng sẽ cảnh báo deprecated.
    const { Geocoder } = (await google.maps.importLibrary(
      'geocoding',
    )) as google.maps.GeocodingLibrary;

    this.geocoder ??= new Geocoder();
    return this.geocoder;
  }
}

/**
 * Chuẩn hoá `coordinates` của GeoJSON (Polygon / MultiPolygon / ring đơn) về
 * mảng ring `{ lat, lng }[][]` để đổ vào `google.maps.Polygon`.
 * Port `normalizeCoords()`.
 */
export function normalizeGeoJsonCoords(coords: unknown): LatLng[][] {
  if (!Array.isArray(coords)) return [];

  // Trường hợp 1: một cặp toạ độ đơn lẻ [lng, lat].
  if (coords.length === 2 && typeof coords[0] === 'number') {
    return [[{ lat: Number(coords[1]), lng: Number(coords[0]) }]];
  }

  // Trường hợp 2: một ring — mảng các cặp [lng, lat].
  if (
    Array.isArray(coords[0]) &&
    coords[0].length === 2 &&
    typeof coords[0][0] === 'number'
  ) {
    return [
      (coords as number[][]).map((c) => ({ lat: Number(c[1]), lng: Number(c[0]) })),
    ];
  }

  // Trường hợp 3: Polygon — mảng các ring.
  if (
    Array.isArray(coords[0]) &&
    Array.isArray(coords[0][0]) &&
    coords[0][0].length === 2
  ) {
    return (coords as number[][][]).map((ring) =>
      ring.map((c) => ({ lat: Number(c[1]), lng: Number(c[0]) })),
    );
  }

  // Trường hợp 4: MultiPolygon — đệ quy.
  return (coords as unknown[]).flatMap((poly) => normalizeGeoJsonCoords(poly));
}
