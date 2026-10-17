"""Summary of a native backend executable for the static scan (contract 3.8).

Pure ``struct`` parsing of the three formats the Registry accepts (thin
64-bit Mach-O, 64-bit ELF, PE32+): linked libraries, imported symbols and a
fixed list of notable imports, packer and embedded-runtime detection, and a
string pass whose results are only ever reported as classified facts
(commands, hosts, capability addresses), never as raw strings.

Every read is bounds-checked; a malformed executable yields a summary with
what could be read and never raises.
"""

from __future__ import annotations

import bisect
import re
import struct
from dataclasses import dataclass, field

from .js_scan import CAPABILITY_ADDRESS_RE, command_like, hosts_in
from .limits import NO_DEADLINE, Deadline

#: Imports worth naming on the card: process creation, networking, dynamic loading.
NOTABLE_IMPORTS = frozenset({
    "execve", "execv", "execvp", "posix_spawn", "posix_spawnp", "system", "popen", "fork", "vfork",
    "socket", "connect", "getaddrinfo", "gethostbyname", "dlopen", "NSTask",
    "CreateProcessA", "CreateProcessW", "ShellExecuteA", "ShellExecuteW", "ShellExecuteExW", "WinExec",
    "URLDownloadToFileA", "URLDownloadToFileW", "InternetOpenA", "InternetOpenW", "WinHttpOpen",
    "WSAStartup", "LoadLibraryA", "LoadLibraryW", "LoadLibraryExW",
})
#: Byte markers of embedded runtimes whose bundled code this scanner does not unpack (DS6).
EMBEDDED_RUNTIME_MARKERS = (
    ("pyinstaller", (b"MEI\x0c\x0b\x0a\x0b\x0e", b"_MEIPASS", b"pyi-runtime-tmpdir")),
    ("node-sea", (b"NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2", b"NODE_SEA_BLOB")),
    ("bun", (b"---- Bun! ----",)),
    ("deno", (b"d3n0l4nd",)),
)
_ASCII_STRINGS = re.compile(rb"[\x20-\x7e]{4,}")
_UTF16_STRINGS = re.compile(rb"(?:[\x20-\x7e]\x00){4,}")
_MACHO_ARCH = {0x01000007: "x64", 0x0100000C: "arm64"}
_ELF_ARCH = {62: "x64", 183: "arm64"}
_PE_ARCH = {0x8664: "x64", 0xAA64: "arm64"}


@dataclass
class NativeFacts:
    path: str
    format: str
    arch: str
    libraries: set[str] = field(default_factory=set)
    imports: set[str] = field(default_factory=set)
    packer: str | None = None
    embedded_runtime: str | None = None
    commands: set[tuple[str, str | None, str]] = field(default_factory=set)
    """(executable, subcommand, category) of strings that read as commands."""
    hosts: dict[str, int] = field(default_factory=dict)
    capabilities: set[str] = field(default_factory=set)
    too_complex: bool = False
    """A structural ceiling was reached; the report marks the file tooComplex."""

    def summary(self, limit: int) -> dict:
        return {
            "path": self.path,
            "format": self.format,
            "arch": self.arch,
            "libraries": sorted(self.libraries)[:limit],
            "notableImports": sorted(name for name in self.imports if name in NOTABLE_IMPORTS)[:limit],
            "importCount": len(self.imports),
            "packer": self.packer,
            "embeddedRuntime": self.embedded_runtime,
        }


def _u(fmt: str, data: bytes, offset: int) -> tuple | None:
    size = struct.calcsize(fmt)
    if offset < 0 or offset + size > len(data):
        return None
    return struct.unpack_from(fmt, data, offset)


def _cstring(data: bytes, offset: int, maximum: int = 1024) -> str | None:
    if offset < 0 or offset >= len(data):
        return None
    end = data.find(b"\0", offset, offset + maximum)
    if end == -1:
        return None
    try:
        return data[offset:end].decode("ascii")
    except UnicodeDecodeError:
        return None


#: Structural ceilings (review of #355). Real executables stay far below
#: them; reaching one marks the file `tooComplex` and stops that loop.
MAX_LOAD_COMMANDS = 4096
MAX_SECTIONS = 1024
MAX_DYNAMIC_ENTRIES = 65536
MAX_SYMBOLS = 200_000
MAX_IMPORT_DESCRIPTORS = 1024
MAX_IMPORT_THUNKS = 200_000
_ELF64_SECTION_HEADER_SIZE = 64


def _macho(data: bytes, facts: NativeFacts, deadline: Deadline) -> None:
    header = _u("<IiiIIII", data, 0)
    if header is None:
        return
    _magic, _cpu, _sub, _filetype, ncmds, _sizeofcmds, _flags = header
    if ncmds > MAX_LOAD_COMMANDS:
        facts.too_complex = True
        ncmds = MAX_LOAD_COMMANDS
    offset = 32
    symtab = None
    for _ in range(ncmds):
        deadline.tick()
        command = _u("<II", data, offset)
        if command is None or command[1] < 8:
            return
        cmd, size = command
        if cmd in (0xC, 0x18 | 0x80000000, 0x1F | 0x80000000, 0x23):  # LC_LOAD_DYLIB, WEAK, REEXPORT, UPWARD
            name_offset = _u("<I", data, offset + 8)
            if name_offset is not None:
                name = _cstring(data, offset + name_offset[0])
                if name:
                    facts.libraries.add(name)
        elif cmd == 0x2:  # LC_SYMTAB
            symtab = _u("<IIII", data, offset + 8)
        elif cmd == 0x19:  # LC_SEGMENT_64: section names reveal UPX
            segment = data[offset + 8:offset + 24].split(b"\0", 1)[0]
            if segment.startswith(b"UPX"):
                facts.packer = "upx"
        offset += size
    if symtab is None:
        return
    symoff, nsyms, stroff, _strsize = symtab
    count = _bounded_count(nsyms, len(data) - symoff, 16, MAX_SYMBOLS, facts)
    for index in range(count):
        deadline.tick()
        entry = _u("<IBBHQ", data, symoff + index * 16)
        if entry is None:
            break
        strx, n_type, _sect, _desc, _value = entry
        if n_type & 0xE0:  # a debugging entry
            continue
        if (n_type & 0x0E) == 0 and (n_type & 0x01):  # N_UNDF | N_EXT: imported
            name = _cstring(data, stroff + strx)
            if name:
                facts.imports.add(name[1:] if name.startswith("_") else name)


def _bounded_count(declared: int, available_bytes: int, entry_size: int, ceiling: int, facts: NativeFacts) -> int:
    """How many entries to read: what the header declares, what the file can
    hold, and at most ``ceiling`` (reaching it marks the file too complex)."""
    count = min(max(declared, 0), max(available_bytes, 0) // entry_size)
    if count > ceiling:
        facts.too_complex = True
        count = ceiling
    return count


def _elf(data: bytes, facts: NativeFacts, deadline: Deadline) -> None:
    endian = "<" if data[5] == 1 else ">"
    header = _u(endian + "HHIQQQIHHHHHH", data, 16)
    if header is None:
        return
    _type, _machine, _version, _entry, _phoff, shoff, _flags, _ehsize, _phentsize, _phnum, shentsize, shnum, _shstrndx = header
    if shnum == 0:
        return
    if shentsize != _ELF64_SECTION_HEADER_SIZE:
        facts.too_complex = True
        return
    shnum = _bounded_count(shnum, len(data) - shoff, _ELF64_SECTION_HEADER_SIZE, MAX_SECTIONS, facts)
    sections = []
    for index in range(shnum):
        deadline.tick()
        section = _u(endian + "IIQQQQIIQQ", data, shoff + index * _ELF64_SECTION_HEADER_SIZE)
        if section is None:
            break
        sections.append(section)
    for section in sections:
        _name, sh_type, _flags, _addr, offset, size, link, _info, _align, entsize = section
        if sh_type == 6 and 0 <= link < len(sections):  # SHT_DYNAMIC
            strtab = sections[link][4]
            for index in range(_bounded_count(size // 16, len(data) - offset, 16, MAX_DYNAMIC_ENTRIES, facts)):
                deadline.tick()
                entry = _u(endian + "qQ", data, offset + index * 16)
                if entry is None or entry[0] == 0:
                    break
                if entry[0] == 1:  # DT_NEEDED
                    name = _cstring(data, strtab + entry[1])
                    if name:
                        facts.libraries.add(name)
        elif sh_type == 11 and entsize == 24 and 0 <= link < len(sections):  # SHT_DYNSYM
            strtab = sections[link][4]
            for index in range(1, _bounded_count(size // 24, len(data) - offset, 24, MAX_SYMBOLS, facts)):
                deadline.tick()
                symbol = _u(endian + "IBBHQQ", data, offset + index * 24)
                if symbol is None:
                    break
                st_name, _info, _other, shndx, _value, _size = symbol
                if shndx == 0 and st_name:
                    name = _cstring(data, strtab + st_name)
                    if name:
                        facts.imports.add(name.split("@", 1)[0])
    if b"UPX!" in data[:4096]:
        facts.packer = "upx"


def _pe(data: bytes, facts: NativeFacts, pe_offset: int, deadline: Deadline) -> None:
    file_header = _u("<HHIIIHH", data, pe_offset + 4)
    if file_header is None:
        return
    _machine, nsections, _ts, _sym, _nsym, optional_size, _chars = file_header
    optional = pe_offset + 24
    magic = _u("<H", data, optional)
    if magic is None or magic[0] != 0x20B:  # PE32+
        return
    import_rva = _u("<II", data, optional + 112 + 8)  # data directory 1: imports
    section_table = optional + optional_size
    # (start rva, end rva, raw pointer), sorted for a binary search; the PE
    # format allows at most 96 sections.
    ranges: list[tuple[int, int, int]] = []
    for index in range(min(nsections, 96)):
        section = _u("<8sIIIIIIHHI", data, section_table + index * 40)
        if section is None:
            break
        name, vsize, vaddr, rawsize, rawptr = section[:5]
        ranges.append((vaddr, vaddr + max(vsize, rawsize), rawptr))
        if name.rstrip(b"\0").startswith(b"UPX"):
            facts.packer = "upx"
    ranges.sort()
    starts = [start for start, _end, _raw in ranges]

    def offset_of(rva: int) -> int | None:
        position = bisect.bisect_right(starts, rva) - 1
        if position < 0:
            return None
        start, end, raw = ranges[position]
        return raw + (rva - start) if rva < end else None

    if import_rva is None or import_rva[0] == 0:
        return
    descriptor = offset_of(import_rva[0])
    thunks_left = MAX_IMPORT_THUNKS
    for _ in range(MAX_IMPORT_DESCRIPTORS):
        deadline.tick()
        if descriptor is None:
            return
        entry = _u("<IIIII", data, descriptor)
        if entry is None or entry == (0, 0, 0, 0, 0):
            return
        original_thunk, _ts, _chain, name_rva, first_thunk = entry
        name_offset = offset_of(name_rva)
        library = _cstring(data, name_offset) if name_offset is not None else None
        if library:
            facts.libraries.add(library)
        thunk = offset_of(original_thunk or first_thunk)
        while thunk is not None:
            deadline.tick()
            if thunks_left == 0:
                facts.too_complex = True
                return
            thunks_left -= 1
            value = _u("<Q", data, thunk)
            if value is None or value[0] == 0:
                break
            if not value[0] & (1 << 63):  # import by name
                hint = offset_of(value[0] & 0x7FFFFFFF)
                name = _cstring(data, hint + 2) if hint is not None else None
                if name:
                    facts.imports.add(name)
            thunk += 8
        descriptor += 20
    facts.too_complex = True  # more descriptors than MAX_IMPORT_DESCRIPTORS


def summarize_executable(path: str, data: bytes, deadline: Deadline = NO_DEADLINE) -> NativeFacts:
    if data[:4] == b"\xcf\xfa\xed\xfe":
        cpu = _u("<i", data, 4)
        facts = NativeFacts(path, "mach-o", _MACHO_ARCH.get(cpu[0] & 0xFFFFFFFF if cpu else 0, "unknown"))
        _macho(data, facts, deadline)
    elif data[:4] == b"\x7fELF" and len(data) > 20 and data[4] == 2:
        machine = _u(("<" if data[5] == 1 else ">") + "H", data, 18)
        facts = NativeFacts(path, "elf", _ELF_ARCH.get(machine[0] if machine else 0, "unknown"))
        _elf(data, facts, deadline)
    elif data[:2] == b"MZ":
        pe = _u("<I", data, 0x3C)
        pe_offset = pe[0] if pe else 0
        machine = _u("<H", data, pe_offset + 4) if data[pe_offset:pe_offset + 4] == b"PE\0\0" else None
        facts = NativeFacts(path, "pe", _PE_ARCH.get(machine[0] if machine else 0, "unknown"))
        if machine is not None:
            _pe(data, facts, pe_offset, deadline)
    else:
        facts = NativeFacts(path, "unknown", "unknown")
    for runtime, markers in EMBEDDED_RUNTIME_MARKERS:
        if any(marker in data for marker in markers):
            facts.embedded_runtime = runtime
            break
    # Strings are classified as they are found and never kept.
    for pattern, encoding in ((_ASCII_STRINGS, "ascii"), (_UTF16_STRINGS, "utf-16-le")):
        for match in pattern.finditer(data):
            deadline.tick()
            _classify(match.group().decode(encoding), facts)
    return facts


def _classify(text: str, facts: NativeFacts) -> None:
    for host in hosts_in(text):
        facts.hosts[host] = facts.hosts.get(host, 0) + 1
    for word in text.split():
        if CAPABILITY_ADDRESS_RE.fullmatch(word):
            facts.capabilities.add(word)
    parsed = command_like(text.strip())
    if parsed is not None:
        facts.commands.add(parsed)
