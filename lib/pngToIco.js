// Wraps a PNG buffer in a minimal single-image .ico container ("PNG-compressed
// icon" format, supported since Windows Vista for any size, including 256x256 -
// no image-processing library needed since the PNG bytes are embedded as-is).
// Used so the desktop shortcut can point its icon at the same upload the web
// pages use as their favicon/header logo - on upload (routes/branding.js) and
// when a backup's icon is restored (lib/backupRestore.js).
function pngToIco(pngBuffer) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(1, 2); // type: icon
    header.writeUInt16LE(1, 4); // image count

    const entry = Buffer.alloc(16);
    // width/height byte 0 means "256" per the ICO spec
    entry.writeUInt16LE(1, 4); // color planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(pngBuffer.length, 8); // image data size
    entry.writeUInt32LE(22, 12); // image data offset (6-byte header + 16-byte entry)

    return Buffer.concat([header, entry, pngBuffer]);
}

module.exports = { pngToIco };
