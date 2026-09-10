import { LatLng, LatLngTuple } from './map.types';

/**
 * Thuật toán Google Encoded Polyline Algorithm Format.
 * Port nguyên văn `src/utils/map/polyline.ts` (copy của @googlemaps/polyline-codec, Apache-2.0).
 *
 * CẢNH BÁO LỊCH SỬ: thân vòng lặp `decode()` từng bị comment hết ở bản Vue, khiến
 * "Quãng đường đã đi" luôn = 0 và "Lộ trình thực tế" không vẽ được đường.
 * ĐỪNG "tối ưu" lại vòng lặp này.
 *
 * Nếu project Angular được phép thêm dependency thì dùng thẳng
 * `@googlemaps/polyline-codec` thay cho file này.
 */

const round = (v: number): number =>
  Math.floor(Math.abs(v) + 0.5) * (v >= 0 ? 1 : -1);

/**
 * Giải mã chuỗi polyline thành mảng `[lat, lng]`.
 *
 * ```ts
 * decode('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
 * // [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]
 * ```
 */
export function decode(encodedPath: string, precision = 5): LatLngTuple[] {
  const factor = Math.pow(10, precision);
  const len = encodedPath.length;
  const path = new Array<LatLngTuple>(Math.floor(len / 2));

  let index = 0;
  let lat = 0;
  let lng = 0;
  let pointIndex = 0;

  for (; index < len; ++pointIndex) {
    let result = 1;
    let shift = 0;
    let b: number;

    do {
      b = encodedPath.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 1;
    shift = 0;
    do {
      b = encodedPath.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    path[pointIndex] = [lat / factor, lng / factor];
  }

  path.length = pointIndex;
  return path;
}

/** Mã hoá mảng điểm thành chuỗi polyline. */
export function encode(
  path: (number[] | LatLng | LatLngTuple)[],
  precision = 5,
): string {
  const factor = Math.pow(10, precision);

  const transform = (latLng: number[] | LatLng | LatLngTuple): [number, number] => {
    const tuple = Array.isArray(latLng) ? latLng : [latLng.lat, latLng.lng];
    return [round(tuple[0] * factor), round(tuple[1] * factor)];
  };

  const v: string[] = [];
  let start: [number, number] = [0, 0];

  for (const point of path) {
    const end = transform(point);
    encodeSigned(round(end[0]) - round(start[0]), v);
    encodeSigned(round(end[1]) - round(start[1]), v);
    start = end;
  }

  return v.join('');
}

function encodeSigned(value: number, array: string[]): string[] {
  return encodeUnsigned(value < 0 ? ~(value << 1) : value << 1, array);
}

function encodeUnsigned(value: number, array: string[]): string[] {
  let v = value;
  while (v >= 0x20) {
    array.push(String.fromCharCode((0x20 | (v & 0x1f)) + 63));
    v >>= 5;
  }
  array.push(String.fromCharCode(v + 63));
  return array;
}

/**
 * Tiện ích hay dùng nhất: polyline encoded -> mảng `[lng, lat]` cho Viettel Map.
 * Bản Vue viết inline ở `DetailInfo.vue` / `ComparingRoute.vue`:
 * `PolylineUtil.decode(x, 5).map((s) => [s[1], s[0]])`.
 */
export function decodeToLngLat(
  encodedPath: string,
  precision = 5,
): [number, number][] {
  return decode(encodedPath, precision).map(([lat, lng]) => [lng, lat]);
}

export const PolylineUtil = { encode, decode, decodeToLngLat };
