import { TravelMode } from './map.types';

export type RoutingErrorCode =
  /** Provider trả lời bình thường nhưng không có tuyến nào. */
  | 'NO_ROUTE'
  /** Provider/hồ sơ không phục vụ phương tiện này. */
  | 'MODE_UNSUPPORTED'
  /** Lỗi mạng/HTTP/quota/API key. */
  | 'PROVIDER_ERROR';

/**
 * Lỗi định tuyến có nghĩa, để UI hiện đúng câu chuyện thay vì vẽ một đường giả.
 *
 * BỐI CẢNH: trước đây khi Google trả `routes: []` (rất hay gặp với xe đạp ở
 * Việt Nam — Google không phủ dữ liệu BICYCLE ở đây), code dựng một
 * `RouteResult` giả gồm chính các waypoint đầu vào, `distance = 0`,
 * `duration = 0`. Kết quả: màn hình hiện `0 m / 0 phút` nhưng bản đồ vẫn có một
 * đường nối các điểm — người dùng đọc thành "tuyến ngắn bất thường" chứ không
 * đọc thành "không có tuyến". Ném lỗi là cách duy nhất để hai trạng thái đó
 * không lẫn vào nhau.
 */
export class RoutingError extends Error {
  constructor(
    readonly code: RoutingErrorCode,
    message: string,
    readonly travelMode?: TravelMode,
    readonly source?: string,
  ) {
    super(message);
    this.name = 'RoutingError';
  }
}

/** Nhãn tiếng Việt của phương tiện — dùng trong câu lỗi và nhãn nguồn. */
export const TRAVEL_MODE_LABEL: Readonly<Record<TravelMode, string>> = {
  driving: 'Ô tô',
  motorbike: 'Xe máy',
  cycling: 'Xe đạp',
  walking: 'Đi bộ',
};
