import { crc32, deflateSync } from "node:zlib";

/**
 * The ClamAV daemon the `test:clamav` suites speak to (ADR-0163): its port, from `CLAMAV_TEST_PORT`, always on
 * this machine. A run without it fails, so CI cannot pass a suite it did not run.
 */
export function clamAvTestPort(): number {
  const raw = process.env.CLAMAV_TEST_PORT;
  const port = Number(raw);
  if (raw === undefined || raw === "" || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Set CLAMAV_TEST_PORT to the port of a ClamAV daemon on this machine, e.g. 3310");
  }
  return port;
}

/** The EICAR test file: every antivirus detects it, and it harms nothing. */
export const EICAR = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");

/** A ZIP holding `content` as `name`, stored without compression. */
export function storedZip(name: string, content: Buffer): Buffer {
  const crc = crc32(content);
  const file = Buffer.from(name, "latin1");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(file.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(file.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + file.length, 12);
  end.writeUInt32LE(local.length + file.length + content.length, 16);
  return Buffer.concat([local, file, content, central, file, end]);
}

/** A PNG of one colour, 640 by 480: a photo the upload checks take, built with no image library. */
export function plainPng(colour: readonly [number, number, number] = [40, 120, 200]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, "latin1");
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const [width, height] = [640, 480];
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(2, 9);
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, Buffer.from(colour))]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
