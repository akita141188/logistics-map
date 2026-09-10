/**
 * =============== CHỐNG XSS CHO NỘI DUNG VẼ LÊN BẢN ĐỒ ===============
 *
 * SDK bản đồ nào cũng có một cửa nhận HTML thô:
 *  - Leaflet : `L.divIcon({ html })`, `marker.bindPopup(html)`
 *  - Viettel : `popup.setHTML()`, `marker.getElement().innerHTML`
 *  - Google  : `InfoWindow.setContent(html)`
 *
 * Ở demo dữ liệu là mock nên trông vô hại. Nối backend thật thì `customerName`,
 * `address`, `note`, nhãn marker... đều là dữ liệu người dùng nhập. Một địa chỉ
 * lưu chuỗi `<img src=x onerror=...>` sẽ CHẠY khi popup mở, vì các API trên
 * không escape gì cả.
 *
 * Ba hàm dưới đây là cửa duy nhất được phép ghép dữ liệu vào HTML string:
 *  1. `escapeHtml`  — text hiển thị (giữ nguyên chữ, chỉ vô hiệu hoá thẻ).
 *  2. `safeColor`   — màu nhét vào thuộc tính `style`.
 *  3. `safeGeoLink` — URL dựng từ toạ độ số.
 *
 * KHÔNG dùng cách "lọc bỏ hết ký tự lạ": tên khách "Cửa hàng A&B" hay ghi chú
 * "giao trước 8h < 10 thùng" là dữ liệu hợp lệ, phải hiện đúng nguyên văn.
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/**
 * Escape text để nhúng an toàn vào HTML string.
 *
 * Escape cả `"`/`'`/`` ` `` chứ không chỉ `<`/`>`: chuỗi này còn được ghép vào
 * giá trị thuộc tính (`title="..."`), nơi một dấu nháy đơn đủ để thoát ra ngoài
 * và gắn thêm `onerror=`.
 *
 * `null`/`undefined` -> chuỗi rỗng, để chỗ gọi không phải viết `?? ''` khắp nơi.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"'`]/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * Các dạng màu CSS được phép nhét vào `style="..."`.
 *
 * VÌ SAO PHẢI LỌC CẢ MÀU: `style="background:${color}"` với `color` là
 * `red;background-image:url(javascript:...)` — hoặc đơn giản là
 * `red" onmouseover="alert(1)` — biến một trường "màu" thành điểm chèn thuộc
 * tính. Chỉ nhận đúng cú pháp màu, còn lại rơi về màu mặc định.
 */
const COLOR_PATTERNS: readonly RegExp[] = [
  /^#[0-9a-f]{3,4}$/i,
  /^#[0-9a-f]{6}$/i,
  /^#[0-9a-f]{8}$/i,
  /^(?:rgb|hsl)a?\([0-9a-z.,%\s/+-]*\)$/i,
  /^[a-z]{3,20}$/i,
];

/**
 * Trả về `value` nếu đó là một màu CSS hợp lệ, ngược lại trả `fallback`.
 * `fallback` phải là hằng do chính app khai báo (bảng `MAP_COLORS`).
 */
export function safeColor(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const trimmed = value.trim();
  return COLOR_PATTERNS.some((re) => re.test(trimmed)) ? trimmed : fallback;
}

/**
 * Link "Xem trên Google Maps" dựng từ toạ độ SỐ đã kiểm tra miền giá trị.
 *
 * Không bao giờ ghép chuỗi do server trả về vào `href`: một `href` bắt đầu bằng
 * `javascript:` vẫn chạy khi bấm, dù nằm trong popup của bản đồ.
 *
 * Trả `null` khi toạ độ không dùng được (NaN, ngoài miền) — chỗ gọi bỏ hẳn link
 * thay vì render một link hỏng.
 */
export function safeGeoLink(lat: number, lng: number): string | null {
  const okLat = Number.isFinite(lat) && lat >= -90 && lat <= 90;
  const okLng = Number.isFinite(lng) && lng >= -180 && lng <= 180;
  if (!okLat || !okLng) return null;
  return `https://maps.google.com/?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
}
