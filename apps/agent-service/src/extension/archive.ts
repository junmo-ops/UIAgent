import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;

const crc32Table = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(content: Uint8Array): number {
  let crc = UINT32_MAX;
  for (const byte of content) crc = (crc >>> 8) ^ crc32Table[(crc ^ byte) & 0xff]!;
  return (crc ^ UINT32_MAX) >>> 0;
}

function zipPath(rootDirectory: string, filePath: string): string {
  return relative(rootDirectory, filePath).split(sep).join('/');
}

function listFiles(rootDirectory: string, directory = rootDirectory): string[] {
  return readdirSync(directory)
    .sort((left, right) => left.localeCompare(right))
    .flatMap(name => {
      const path = resolve(directory, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`插件发布目录不能包含符号链接：${zipPath(rootDirectory, path)}`);
      if (stat.isDirectory()) return listFiles(rootDirectory, path);
      if (stat.isFile()) return [path];
      throw new Error(`插件发布目录包含不支持的文件类型：${zipPath(rootDirectory, path)}`);
    });
}

function dosTimestamp(date: Date): { date: number; time: number } {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  };
}

function assertUint32(value: number, description: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new Error(`${description} 超出 ZIP32 支持范围`);
  }
}

/**
 * 将已构建的 Chrome 扩展目录打包为标准 ZIP。使用 store 模式，避免引入压缩依赖。
 */
export function createExtensionZip(rootDirectory: string): Uint8Array {
  const files = listFiles(rootDirectory);
  if (files.length > UINT16_MAX) throw new Error('插件发布目录文件数量超出 ZIP32 支持范围');

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const filePath of files) {
    const name = Buffer.from(zipPath(rootDirectory, filePath), 'utf8');
    if (name.length > UINT16_MAX) throw new Error(`插件文件路径过长：${name.toString('utf8')}`);

    const content = readFileSync(filePath);
    assertUint32(content.length, `插件文件 ${name.toString('utf8')} 的大小`);
    const checksum = crc32(content);
    const { date, time } = dosTimestamp(lstatSync(filePath).mtime);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(localOffset, 42);

    localParts.push(localHeader, name, content);
    centralParts.push(centralHeader, name);
    localOffset += localHeader.length + name.length + content.length;
    assertUint32(localOffset, '插件 ZIP 内容大小');
  }

  const centralDirectory = Buffer.concat(centralParts);
  assertUint32(centralDirectory.length, '插件 ZIP 中央目录大小');

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);

  return Buffer.concat([...localParts, centralDirectory, end]);
}
