/**
 * Nạp API key lúc RUNTIME thay vì nhúng vào code lúc build.
 *
 * VÌ SAO KHÔNG DÙNG `environment.ts` + `fileReplacements`:
 * cách đó bắt người chạy phải nhớ thêm cờ `--configuration local`. Quên cờ là
 * app im lặng chạy với key rỗng và hiện "Chưa cấu hình API key" — trông y hệt
 * lỗi thật, rất khó đoán. Ngoài ra đổi key phải build lại toàn bộ.
 *
 * Cách hiện tại: key nằm trong `public/map-keys.json` (đã gitignore). File này
 * được serve tĩnh nên `npm start` đọc được ngay, không cần cờ gì. Sửa key chỉ
 * cần F5. Lên production thì mount/ghi đè đúng file JSON đó, không phải build lại.
 *
 * KHÔNG có file -> HTTP 404 -> key rỗng -> app chạy bằng OpenStreetMap. Đây là
 * trạng thái hợp lệ, không phải lỗi, nên tuyệt đối không throw ở đây.
 */

/** Đúng phần cấu hình cần giữ bí mật / thay đổi theo môi trường. */
export interface MapRuntimeKeys {
  googleMapsKey: string;
  googleMapId: string;
  vtmapKey: string;
}

export const EMPTY_MAP_RUNTIME_KEYS: MapRuntimeKeys = {
  googleMapsKey: '',
  googleMapId: '',
  vtmapKey: '',
};

/** Đường dẫn tương đối so với `baseHref`, để deploy vào thư mục con vẫn đúng. */
const KEYS_URL = 'map-keys.json';

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Đọc `public/map-keys.json`. Luôn resolve — mọi lỗi (404, JSON hỏng, mất mạng)
 * đều quy về "không có key" kèm cảnh báo ở console, để app không chết lúc bootstrap.
 */
export async function loadMapRuntimeKeys(): Promise<MapRuntimeKeys> {
  try {
    // `cache: no-store`: tránh trình duyệt giữ lại bản 404 cũ sau khi vừa tạo file.
    const response = await fetch(KEYS_URL, { cache: 'no-store' });

    if (!response.ok) {
      if (response.status !== 404) {
        console.warn(`[map] Không đọc được ${KEYS_URL} (HTTP ${response.status}).`);
      }
      return EMPTY_MAP_RUNTIME_KEYS;
    }

    const raw = (await response.json()) as Partial<Record<keyof MapRuntimeKeys, unknown>>;

    return {
      googleMapsKey: asString(raw.googleMapsKey),
      googleMapId: asString(raw.googleMapId),
      vtmapKey: asString(raw.vtmapKey),
    };
  } catch (error) {
    console.warn(`[map] Bỏ qua ${KEYS_URL}, chạy bằng nguồn mở.`, error);
    return EMPTY_MAP_RUNTIME_KEYS;
  }
}
