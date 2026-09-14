// Writes a Windows shortcut (.lnk) file directly, byte for byte, following
// the documented Shell Link format (MS-SHLLINK). Used by launcher.js to
// create the desktop shortcut on first-run setup.
//
// Why not just ask Windows to do it? The usual way (a WScript.Shell COM
// object from PowerShell or a .vbs script) is exactly what Smart App
// Control and PowerShell's Constrained Language Mode shut down on a locked-
// down Windows 11 PC - and the app must install on a brand-new club
// computer with no scripts of any kind. Node.js writing a small binary
// file needs no permission from anyone.
//
// Only what a launcher shortcut needs is written: target path, arguments,
// working directory, icon, description, and whether to start minimised. The
// target is stored twice, as the format expects: as an item ID list (the
// shell's own "My Computer > C:\ > folder > ... > file" chain, which is
// what Windows actually launches) and as a LinkInfo local base path (what
// it falls back on if the target moves).
const fs = require('fs');
const path = require('path');

const HEADER_SIZE = 0x4c;
// {00021401-0000-0000-C000-000000000046}, the ShellLink CLSID, as stored
const LINK_CLSID = Buffer.from([0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46]);

const FLAGS = {
    HasLinkTargetIDList: 0x01,
    HasLinkInfo: 0x02,
    HasName: 0x04,
    HasWorkingDir: 0x10,
    HasArguments: 0x20,
    HasIconLocation: 0x40,
    IsUnicode: 0x80,
};
const FILE_ATTRIBUTE_ARCHIVE = 0x20;
const SW_SHOWNORMAL = 1;
const SW_SHOWMINNOACTIVE = 7;
const DRIVE_FIXED = 3;

function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }

// StringData: a character count (UTF-16 code units) then the characters,
// no terminator.
function stringData(text) {
    return Buffer.concat([u16(text.length), Buffer.from(text, 'utf16le')]);
}

// --- Item ID list -----------------------------------------------------------
// One SHITEMID per step of the path, laid out the way Explorer writes them
// (checked against shortcuts Windows itself created): the My Computer root,
// the drive, then a file-entry item per folder and one for the file, each
// with the name in ANSI followed by a 0xBEEF0004 extension block carrying it
// again in UTF-16. Sizes and dates are left zero - the shell reads them
// from the real file when the link is used.
const MY_COMPUTER_ITEM = Buffer.from('14001f50e04fd020ea3a6910a2d808002b30309d', 'hex');

function driveItem(drive) { // "C:\\"
    const item = Buffer.alloc(25);
    item.writeUInt16LE(25, 0);
    item[2] = 0x2f;
    Buffer.from(drive, 'latin1').copy(item, 3);
    return item;
}

function fileEntryItem(name, isDir) {
    const head = Buffer.alloc(14);
    head[2] = isDir ? 0x31 : 0x32;
    head.writeUInt16LE(isDir ? 0x10 : 0x20, 12); // FILE_ATTRIBUTE_DIRECTORY / _ARCHIVE
    let primary = Buffer.concat([Buffer.from(name, 'latin1'), Buffer.from([0])]);
    if ((head.length + primary.length) % 2) primary = Buffer.concat([primary, Buffer.from([0])]);
    const extOffset = head.length + primary.length;
    const longName = Buffer.concat([Buffer.from(name, 'utf16le'), Buffer.from([0, 0])]);
    const ext = Buffer.alloc(46 + longName.length + 2);
    ext.writeUInt16LE(ext.length, 0);
    ext.writeUInt16LE(9, 2);            // block version (Windows 8.1+)
    ext.writeUInt32LE(0xbeef0004, 4);   // file-entry extension signature
    ext.writeUInt16LE(0x2e, 16);
    longName.copy(ext, 46);
    ext.writeUInt16LE(extOffset, ext.length - 2);
    const item = Buffer.concat([head, primary, ext]);
    item.writeUInt16LE(item.length, 0);
    return item;
}

function idList(target) {
    const parsed = path.win32.parse(target);
    if (!/^[a-z]:\\$/i.test(parsed.root)) throw new Error('shellLink: target must be a full local path like C:\\folder\\file.exe');
    const parts = target.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean);
    const items = [MY_COMPUTER_ITEM, driveItem(parsed.root.toUpperCase())];
    parts.forEach((part, i) => items.push(fileEntryItem(part, i < parts.length - 1)));
    const list = Buffer.concat([...items, Buffer.from([0, 0])]);
    return Buffer.concat([u16(list.length), list]);
}

// LinkInfo with VolumeIDAndLocalBasePath: a minimal VolumeID (fixed drive,
// no label) and the target as a null-terminated ANSI local base path.
function linkInfo(target) {
    const basePath = Buffer.from(target, 'latin1');
    const volumeId = Buffer.concat([u32(0x11), u32(DRIVE_FIXED), u32(0), u32(0x10), Buffer.from([0])]);
    const headerSize = 0x1c;
    const volumeIdOffset = headerSize;
    const localBasePathOffset = volumeIdOffset + volumeId.length;
    const commonPathSuffixOffset = localBasePathOffset + basePath.length + 1;
    const size = commonPathSuffixOffset + 1;
    return Buffer.concat([
        u32(size), u32(headerSize), u32(1 /* VolumeIDAndLocalBasePath */),
        u32(volumeIdOffset), u32(localBasePathOffset), u32(0 /* no network link */), u32(commonPathSuffixOffset),
        volumeId, basePath, Buffer.from([0]), Buffer.from([0]),
    ]);
}

function buildShellLink({ target, args = '', workingDir = '', icon = '', iconIndex = 0, description = '', showMinimized = false }) {
    if (!target || typeof target !== 'string') throw new Error('shellLink: target is required');
    if (/[^\x00-\xff]/.test(target)) throw new Error('shellLink: target path must be ASCII/Latin-1 (LinkInfo stores an ANSI path)');
    let flags = FLAGS.HasLinkTargetIDList | FLAGS.HasLinkInfo | FLAGS.IsUnicode;
    const strings = [];
    // StringData order is fixed by the format: name, (relative path),
    // working dir, arguments, icon location.
    if (description) { flags |= FLAGS.HasName; strings.push(stringData(description)); }
    if (workingDir) { flags |= FLAGS.HasWorkingDir; strings.push(stringData(workingDir)); }
    if (args) { flags |= FLAGS.HasArguments; strings.push(stringData(args)); }
    if (icon) { flags |= FLAGS.HasIconLocation; strings.push(stringData(icon)); }

    const header = Buffer.alloc(HEADER_SIZE);
    header.writeUInt32LE(HEADER_SIZE, 0);
    LINK_CLSID.copy(header, 4);
    header.writeUInt32LE(flags, 20);
    header.writeUInt32LE(FILE_ATTRIBUTE_ARCHIVE, 24);
    // 28..51: creation/access/write FILETIMEs - zero means "unknown"
    header.writeUInt32LE(0, 52); // FileSize
    header.writeInt32LE(iconIndex, 56);
    header.writeUInt32LE(showMinimized ? SW_SHOWMINNOACTIVE : SW_SHOWNORMAL, 60);
    // 64: HotKey, 66/68/72: reserved - all zero

    return Buffer.concat([header, idList(target), linkInfo(target), ...strings, u32(0) /* terminal extra-data block */]);
}

function writeShellLink(file, options) {
    fs.writeFileSync(file, buildShellLink(options));
}

// Reads back the fields this module writes - used by the tests and by
// launcher.js to recognise a shortcut it created earlier.
function readShellLink(buffer) {
    if (buffer.readUInt32LE(0) !== HEADER_SIZE || !buffer.subarray(4, 20).equals(LINK_CLSID)) throw new Error('not a shell link');
    const flags = buffer.readUInt32LE(20);
    const result = { flags, showCommand: buffer.readUInt32LE(60), iconIndex: buffer.readInt32LE(56) };
    let pos = HEADER_SIZE;
    if (flags & FLAGS.HasLinkTargetIDList) {
        const size = buffer.readUInt16LE(pos);
        result.idListItems = [];
        let p = pos + 2;
        while (p < pos + 2 + size) {
            const cb = buffer.readUInt16LE(p);
            if (cb === 0) break;
            const type = buffer[p + 2];
            let name = null;
            if (type === 0x31 || type === 0x32) name = buffer.subarray(p + 14, buffer.indexOf(0, p + 14)).toString('latin1');
            else if (type === 0x2f) name = buffer.subarray(p + 3, buffer.indexOf(0, p + 3)).toString('latin1');
            result.idListItems.push({ type, name });
            p += cb;
        }
        pos += 2 + size;
    }
    if (flags & FLAGS.HasLinkInfo) {
        const size = buffer.readUInt32LE(pos);
        const basePathOffset = buffer.readUInt32LE(pos + 16);
        const end = buffer.indexOf(0, pos + basePathOffset);
        result.target = buffer.subarray(pos + basePathOffset, end).toString('latin1');
        pos += size;
    }
    const readString = () => {
        const count = buffer.readUInt16LE(pos);
        const text = buffer.subarray(pos + 2, pos + 2 + count * 2).toString('utf16le');
        pos += 2 + count * 2;
        return text;
    };
    if (flags & FLAGS.HasName) result.description = readString();
    if (flags & 0x08) result.relativePath = readString();
    if (flags & FLAGS.HasWorkingDir) result.workingDir = readString();
    if (flags & FLAGS.HasArguments) result.args = readString();
    if (flags & FLAGS.HasIconLocation) result.icon = readString();
    return result;
}

module.exports = { buildShellLink, writeShellLink, readShellLink, FLAGS, HEADER_SIZE };
