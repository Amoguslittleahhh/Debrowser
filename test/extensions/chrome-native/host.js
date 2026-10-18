// A native messaging host: length-prefixed JSON on stdin and stdout.
let buf = Buffer.alloc(0);
const send = (msg) => {
  const body = Buffer.from(JSON.stringify(msg));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
};
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
    const msg = JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString());
    buf = buf.subarray(4 + buf.readUInt32LE(0));
    if (msg.type === 'get_status') send({ type: 'status_response', computer_name: 'Test-PC', origin: process.argv[2] });
    else send({ type: 'echo', text: msg.text, origin: process.argv[2] });
  }
});
process.stdin.on('end', () => process.exit(0));
