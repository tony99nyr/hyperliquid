"""Minimal Borsh + Anchor-event decoder for the Jupiter Perpetuals IDL.

No external deps (no @coral-xyz/anchor, no solana-py). Pure-Python so the whole
pipeline is offline-reproducible against cached raw transactions.

Anchor CPI event layout inside an inner instruction's data:
    [8 bytes: self-CPI event marker discriminator]
    [8 bytes: event discriminator = sha256("event:"+Name)[:8]]
    [borsh-serialized event fields]
We match the 2nd 8-byte window against known event discriminators.
"""
import hashlib
import json
import os
import struct

IDL_PATH = os.path.join(os.path.dirname(__file__), "jupiter-perpetuals-idl.json")

# --- pure-python base58 (Bitcoin alphabet) so the pipeline has no pip deps ---
_B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_B58_INDEX = {c: i for i, c in enumerate(_B58_ALPHABET)}


def b58encode(b: bytes) -> str:
    n = int.from_bytes(b, "big")
    out = ""
    while n > 0:
        n, r = divmod(n, 58)
        out = _B58_ALPHABET[r] + out
    pad = 0
    for ch in b:
        if ch == 0:
            pad += 1
        else:
            break
    return "1" * pad + out


def b58decode(s: str) -> bytes:
    n = 0
    for ch in s:
        n = n * 58 + _B58_INDEX[ch]
    full = n.to_bytes((n.bit_length() + 7) // 8, "big") if n > 0 else b""
    pad = 0
    for ch in s:
        if ch == "1":
            pad += 1
        else:
            break
    return b"\x00" * pad + full


def _disc(name):
    return hashlib.sha256(("event:" + name).encode()).digest()[:8]


class BorshReader:
    def __init__(self, buf):
        self.buf = buf
        self.off = 0

    def take(self, n):
        b = self.buf[self.off:self.off + n]
        if len(b) != n:
            raise ValueError("buffer underrun")
        self.off += n
        return b

    def u8(self):
        return self.take(1)[0]

    def bool(self):
        return self.take(1)[0] != 0

    def u64(self):
        return struct.unpack("<Q", self.take(8))[0]

    def i64(self):
        return struct.unpack("<q", self.take(8))[0]

    def pubkey(self):
        return b58encode(self.take(32))

    def option(self, inner):
        flag = self.take(1)[0]
        if flag == 0:
            return None
        return inner()


def _read_field(r, ftype):
    if isinstance(ftype, dict):
        if "option" in ftype:
            return r.option(lambda: _read_scalar(r, ftype["option"]))
        raise ValueError(f"unsupported composite type {ftype}")
    return _read_scalar(r, ftype)


def _read_scalar(r, t):
    if t == "u8":
        return r.u8()
    if t == "bool":
        return r.bool()
    if t == "u64":
        return r.u64()
    if t == "i64":
        return r.i64()
    if t == "publicKey":
        return r.pubkey()
    raise ValueError(f"unsupported scalar {t}")


class EventCoder:
    def __init__(self, idl_path=IDL_PATH):
        idl = json.load(open(idl_path))
        self.events = {}
        for e in idl["events"]:
            self.events[bytes(_disc(e["name"]))] = e

    def try_decode(self, data_bytes):
        """data_bytes = raw inner-instruction data (already base58-decoded).
        Returns (name, fields_dict) or None."""
        if len(data_bytes) < 16:
            return None
        # Skip the 8-byte self-CPI marker; next 8 bytes are the event discriminator.
        disc = data_bytes[8:16]
        ev = self.events.get(disc)
        if ev is None:
            return None
        r = BorshReader(data_bytes[16:])
        out = {}
        try:
            for f in ev["fields"]:
                out[f["name"]] = _read_field(r, f["type"])
        except ValueError:
            return None
        return ev["name"], out
