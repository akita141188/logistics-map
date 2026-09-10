import { describe, expect, it } from 'vitest';
import { escapeHtml, safeColor, safeGeoLink } from './html-safe.util';

/**
 * Chốt lỗ hổng XSS ở lớp bản đồ.
 *
 * Leaflet/Viettel đều nhận HTML string cho marker + popup. Trước bản vá này,
 * `m.title`, `m.description`, `m.label`, `m.color` được ghép thẳng vào chuỗi
 * HTML — nghĩa là một tên khách hàng lưu trong CSDL đủ sức chạy script khi
 * người điều vận mở popup.
 *
 * Các test dưới đây kiểm tra bằng cách THẬT SỰ parse chuỗi kết quả bằng DOM
 * parser, chứ không chỉ so khớp chuỗi: chỉ có DOM mới trả lời đúng câu hỏi
 * "chuỗi này có sinh ra phần tử thực thi được không".
 */

/** Các payload kinh điển; nếu escape sai thì ít nhất một cái sẽ lọt. */
const PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '<script>alert(1)</script>',
  '"><svg onload=alert(1)>',
  `' onmouseover='alert(1)`,
  '<iframe src="javascript:alert(1)"></iframe>',
];

function parse(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host;
}

describe('escapeHtml', () => {
  it('không tạo ra phần tử thực thi được từ payload XSS', () => {
    for (const payload of PAYLOADS) {
      const host = parse(`<div class="dms-popup__title">${escapeHtml(payload)}</div>`);

      expect(host.querySelector('img')).toBeNull();
      expect(host.querySelector('script')).toBeNull();
      expect(host.querySelector('svg')).toBeNull();
      expect(host.querySelector('iframe')).toBeNull();
      // Toàn bộ payload phải nằm lại dưới dạng CHỮ, đúng một phần tử duy nhất.
      expect(host.children.length).toBe(1);
      expect(host.textContent).toBe(payload);
    }
  });

  it('không cho thoát ra khỏi giá trị thuộc tính', () => {
    const payload = `x" onerror="alert(1)`;
    const host = parse(`<div title="${escapeHtml(payload)}"></div>`);
    const div = host.querySelector('div')!;

    expect(div.getAttribute('onerror')).toBeNull();
    expect(div.getAttribute('title')).toBe(payload);
  });

  it('giữ nguyên text hợp lệ có ký tự đặc biệt (không "lọc bỏ hết")', () => {
    const text = 'Cửa hàng A&B — giao trước 8h, < 10 thùng';
    expect(parse(escapeHtml(text)).textContent).toBe(text);
  });

  it('coi null/undefined là chuỗi rỗng', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });
});

describe('safeColor', () => {
  it('chấp nhận các dạng màu CSS hợp lệ', () => {
    for (const color of [
      '#fff',
      '#0ea5e9',
      '#0ea5e9ff',
      'rgb(14, 165, 233)',
      'rgba(0,0,0,.5)',
      'hsl(200 50% 40%)',
      'red',
    ]) {
      expect(safeColor(color, '#000')).toBe(color);
    }
  });

  it('loại chuỗi màu mang theo payload chèn thuộc tính', () => {
    const attacks = [
      'red" onmouseover="alert(1)',
      'red;background-image:url(javascript:alert(1))',
      '#fff"><script>alert(1)</script>',
      'expression(alert(1))',
    ];

    for (const attack of attacks) {
      expect(safeColor(attack, '#94a3b8')).toBe('#94a3b8');
    }
  });

  it('màu bẩn không sinh thêm phần tử khi nhét vào style', () => {
    const color = safeColor('#fff"><img src=x onerror=alert(1)>', '#94a3b8');
    const host = parse(`<span style="background:${color}"></span>`);

    expect(host.querySelector('img')).toBeNull();
    expect(host.children.length).toBe(1);
  });

  it('rơi về màu mặc định khi rỗng', () => {
    expect(safeColor(undefined, '#111')).toBe('#111');
    expect(safeColor('', '#111')).toBe('#111');
    expect(safeColor('   ', '#111')).toBe('#111');
  });
});

describe('safeGeoLink', () => {
  it('dựng link từ toạ độ số hợp lệ', () => {
    expect(safeGeoLink(21.0278, 105.8342)).toBe('https://maps.google.com/?q=21.027800,105.834200');
  });

  it('trả null khi toạ độ không dùng được', () => {
    expect(safeGeoLink(Number.NaN, 105)).toBeNull();
    expect(safeGeoLink(91, 105)).toBeNull();
    expect(safeGeoLink(21, 181)).toBeNull();
    expect(safeGeoLink(Number.POSITIVE_INFINITY, 105)).toBeNull();
  });

  it('href sinh ra luôn là http(s), không thể thành javascript:', () => {
    const href = safeGeoLink(21.0278, 105.8342)!;
    const host = parse(`<a href="${href}">x</a>`);

    expect(host.querySelector('a')!.getAttribute('href')).toMatch(/^https:\/\/maps\.google\.com\//);
  });
});
