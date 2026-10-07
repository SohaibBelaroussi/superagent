/** A tar (ustar, with a pax header for long paths) of a plugin's files, for the runner to unpack. */
export function writeTar(files: Array<{ path: string; mode: number; data: Buffer }>): Buffer {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, mode: number, type: string) => {
    const block = Buffer.alloc(512, 0);
    block.write(name, 0, 100, 'utf8');
    block.write(`${(mode & 0o777).toString(8).padStart(7, '0')}\0`, 100, 8, 'ascii');
    block.write('0000000\0', 108, 8, 'ascii'); // uid
    block.write('0000000\0', 116, 8, 'ascii'); // gid
    block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
    block.write('00000000000\0', 136, 12, 'ascii'); // mtime: fixed, so the same files give the same tar
    block.write('        ', 148, 8, 'ascii'); // checksum, counted as spaces
    block.write(type, 156, 1, 'ascii');
    block.write('ustar\0', 257, 6, 'ascii');
    block.write('00', 263, 2, 'ascii');
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
    return block;
  };
  const pad = (size: number) => Buffer.alloc((512 - (size % 512)) % 512, 0);
  for (const file of files) {
    if (Buffer.byteLength(file.path) > 99) {
      // A pax record holds the real path; the header's own name is cut.
      // A record's length counts its bytes, its own digits included.
      const record = (text: string) => {
        const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
        let length = bytes(text) + 3;
        while (bytes(`${length} ${text}\n`) !== length) length = bytes(`${length} ${text}\n`);
        return `${length} ${text}\n`;
      };
      const pax = Buffer.from(record(`path=${file.path}`), 'utf8');
      blocks.push(header('PaxHeader', pax.length, 0o644, 'x'), pax, pad(pax.length));
    }
    blocks.push(
      header(file.path.slice(0, 99), file.data.length, file.mode, '0'),
      file.data,
      pad(file.data.length),
    );
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}
