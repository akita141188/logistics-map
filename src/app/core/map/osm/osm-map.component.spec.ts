import { ApplicationRef } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import type * as LType from 'leaflet';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MapMarker, MapPath } from '../map.types';
import { OsmMapComponent } from './osm-map.component';

/**
 * ============ KIỂM CHỨNG KHUNG NHÌN CỦA BẢN ĐỒ LEAFLET ============
 *
 * Đây là chỗ chạy LEAFLET THẬT (không mock) trong jsdom, vì hai lỗi cần bắt đều
 * nằm ở phần ghép nối giữa signal của Angular và trạng thái nội bộ của Leaflet —
 * mock đi thì không còn gì để kiểm chứng.
 *
 * Hai hành vi được khoá lại ở đây, cả hai đều là bug người dùng báo:
 *
 *  1. **Đổi chuyến giao hàng thì bản đồ phải tự chuyển tới tuyến mới.** Trước đó
 *     không: `fitToken` đổi lúc dữ liệu còn RỖNG (resource đang tải), effect
 *     chạy, không có gì để fit, mà token thì đã coi như dùng xong — dữ liệu về
 *     sau không kích hoạt fit nữa nên khung nhìn nằm lại tỉnh cũ.
 *  2. **Dữ liệu nhích mỗi nhịp KHÔNG được kéo khung nhìn.** Màn tua lại và màn
 *     dẫn đường đổi `paths` mỗi 200–500 ms; fit theo dữ liệu là khung nhìn giật
 *     liên tục và người dùng không kéo bản đồ đi đâu được.
 *
 * jsdom không tính layout, mọi phần tử có `clientWidth = 0`. Leaflet lấy kích
 * thước khung để tính mức zoom, gặp 0 thì `getBoundsZoom` chia cho 0. Vì vậy
 * phải gán kích thước giả — không phải để "cho test chạy" mà để Leaflet đi đúng
 * nhánh code như trên trình duyệt.
 */
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    value: 900,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    value: 600,
  });
});

const HANOI = { lat: 21.0278, lng: 105.8342 };
const SAIGON = { lat: 10.7769, lng: 106.7009 };

function markersAround(center: { lat: number; lng: number }, prefix: string): MapMarker[] {
  return [
    { key: `${prefix}-1`, lat: center.lat, lng: center.lng },
    { key: `${prefix}-2`, lat: center.lat + 0.02, lng: center.lng + 0.02 },
  ];
}

function pathAround(center: { lat: number; lng: number }, color: string): MapPath[] {
  return [
    {
      key: 'route',
      points: [
        { lat: center.lat, lng: center.lng },
        { lat: center.lat + 0.01, lng: center.lng + 0.01 },
      ],
      color,
      weight: 6,
    },
  ];
}

/** Instance Leaflet nằm trong field private — spec đọc trực tiếp để đo khung nhìn. */
function leaflet(fixture: ComponentFixture<OsmMapComponent>): LType.Map {
  return (fixture.componentInstance as unknown as { map: LType.Map }).map;
}

function distanceDeg(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  return Math.hypot(a.lat - b.lat, a.lng - b.lng);
}

async function setup(): Promise<ComponentFixture<OsmMapComponent>> {
  TestBed.configureTestingModule({ imports: [OsmMapComponent] });

  const fixture = TestBed.createComponent(OsmMapComponent);
  fixture.componentRef.setInput('markers', markersAround(HANOI, 'hn'));
  fixture.componentRef.setInput('fitToken', 'TRIP-HN-01');

  fixture.detectChanges();
  await TestBed.inject(ApplicationRef).whenStable();

  return fixture;
}

async function flush(fixture: ComponentFixture<OsmMapComponent>): Promise<void> {
  fixture.detectChanges();
  await TestBed.inject(ApplicationRef).whenStable();
}

describe('OsmMapComponent — khung nhìn theo fitToken', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('fit ngay khi đã có dữ liệu', async () => {
    const fixture = await setup();

    expect(distanceDeg(leaflet(fixture).getCenter(), HANOI)).toBeLessThan(0.05);
  });

  it('ĐỔI CHUYẾN: token đổi lúc dữ liệu còn rỗng -> fit lại NGAY KHI dữ liệu về', async () => {
    const fixture = await setup();

    // Người dùng đổi chuyến: `resource` xoá dữ liệu trước, tải sau.
    fixture.componentRef.setInput('markers', []);
    fixture.componentRef.setInput('fitToken', 'TRIP-HCM-01');
    await flush(fixture);

    // Chưa có gì để fit -> khung nhìn vẫn ở chuyến cũ, ĐÚNG.
    expect(distanceDeg(leaflet(fixture).getCenter(), HANOI)).toBeLessThan(0.05);

    // Dữ liệu chuyến mới về. Token KHÔNG đổi thêm lần nào nữa — đây chính là
    // chỗ bản cũ bỏ lỡ, khiến người dùng phải tự kéo bản đồ đi tìm tuyến mới.
    fixture.componentRef.setInput('markers', markersAround(SAIGON, 'hcm'));
    await flush(fixture);

    expect(distanceDeg(leaflet(fixture).getCenter(), SAIGON)).toBeLessThan(0.05);
  });

  it('token đổi rồi tuyến về sau marker -> fit ôm cả tuyến, không bỏ lần fit nào', async () => {
    const fixture = await setup();

    fixture.componentRef.setInput('markers', []);
    fixture.componentRef.setInput('paths', []);
    fixture.componentRef.setInput('fitToken', 'TRIP-HCM-01');
    await flush(fixture);

    fixture.componentRef.setInput('markers', markersAround(SAIGON, 'hcm'));
    await flush(fixture);
    fixture.componentRef.setInput('fitToken', 'TRIP-HCM-01-routed');
    fixture.componentRef.setInput('paths', pathAround(SAIGON, '#1a73e8'));
    await flush(fixture);

    expect(distanceDeg(leaflet(fixture).getCenter(), SAIGON)).toBeLessThan(0.05);
  });

  it('DỮ LIỆU NHÍCH mà token không đổi -> KHÔNG được dời khung nhìn', async () => {
    const fixture = await setup();

    const before = leaflet(fixture).getCenter();

    // Đúng những gì màn tua lại/dẫn đường làm mỗi nhịp: đổi hình học, giữ token.
    for (let i = 1; i <= 5; i++) {
      fixture.componentRef.setInput('paths', pathAround({ lat: 21 + i, lng: 105 + i }, '#1a73e8'));
      await flush(fixture);
    }

    const after = leaflet(fixture).getCenter();
    expect(distanceDeg(after, before)).toBeLessThan(0.001);
  });

  it('token cũ quay lại (đổi chuyến rồi đổi về) vẫn fit, vì token thật sự đã đổi', async () => {
    const fixture = await setup();

    fixture.componentRef.setInput('markers', markersAround(SAIGON, 'hcm'));
    fixture.componentRef.setInput('fitToken', 'TRIP-HCM-01');
    await flush(fixture);
    expect(distanceDeg(leaflet(fixture).getCenter(), SAIGON)).toBeLessThan(0.05);

    fixture.componentRef.setInput('markers', markersAround(HANOI, 'hn'));
    fixture.componentRef.setInput('fitToken', 'TRIP-HN-01');
    await flush(fixture);

    expect(distanceDeg(leaflet(fixture).getCenter(), HANOI)).toBeLessThan(0.05);
  });
});

/**
 * ============ ĐƯỜNG VẼ PHẢI ĐỔI ĐƯỢC CẢ KIỂU VẼ, KHÔNG CHỈ HÌNH HỌC ============
 *
 * `renderPaths` cập nhật tại chỗ theo `key` để không dựng lại SVG mỗi nhịp. Bản
 * trước chỉ cập nhật toạ độ, nên một `key` đang tồn tại mà đổi màu thì màu cũ
 * ở lại: màn dẫn đường báo "đi lệch tuyến" bằng cách chuyển đường sang đỏ, và
 * cảnh báo đó không bao giờ hiện ra.
 */
describe('OsmMapComponent — cập nhật kiểu vẽ của đường', () => {
  beforeEach(() => TestBed.resetTestingModule());

  function layerOf(fixture: ComponentFixture<OsmMapComponent>, key: string): LType.Polyline {
    const layers = (
      fixture.componentInstance as unknown as {
        pathLayers: Map<string, { layer: LType.Polyline }>;
      }
    ).pathLayers;
    return layers.get(key)!.layer;
  }

  it('đổi màu/độ dày trên cùng một key thì layer phải đổi theo', async () => {
    const fixture = await setup();

    fixture.componentRef.setInput('paths', pathAround(HANOI, '#1a73e8'));
    await flush(fixture);
    expect(layerOf(fixture, 'route').options.color).toBe('#1a73e8');

    // Xe đi lệch tuyến -> cùng đoạn đường đó phải chuyển sang đỏ.
    const red: MapPath[] = [{ ...pathAround(HANOI, '#d93025')[0], weight: 9 }];
    fixture.componentRef.setInput('paths', red);
    await flush(fixture);

    expect(layerOf(fixture, 'route').options.color).toBe('#d93025');
    expect(layerOf(fixture, 'route').options.weight).toBe(9);
  });

  it('màu lạ (dữ liệu backend không tin được) bị thay bằng màu mặc định', async () => {
    const fixture = await setup();

    fixture.componentRef.setInput('paths', pathAround(HANOI, 'url(#x); background:red'));
    await flush(fixture);

    expect(layerOf(fixture, 'route').options.color).not.toContain('url(');
  });
});
