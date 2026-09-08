import { crc32, deflateSync } from "node:zlib";

// 테스트 전용 단색 RGB PNG를 메모리에서 만들어 개인 이미지 없이 검증한다.
export function solidPng(rgb: [number, number, number] = [255, 0, 0]): Buffer {
  // PNG 청크 길이·종류·데이터·CRC를 순서대로 작성한다.
  function chunk(type: string, data: Buffer) {
    const name = Buffer.from(type);
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([size, name, data, checksum]);
  }
  const width = 128;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(width, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(width * (1 + width * 3));
  for (let y = 0; y < width; y++) {
    for (let x = 0; x < width; x++) {
      const offset = y * (1 + width * 3) + 1 + x * 3;
      rows.set(rgb, offset);
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
