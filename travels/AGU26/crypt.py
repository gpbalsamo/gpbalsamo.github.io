#!/usr/bin/env python3
"""Encrypt/decrypt the AGU26 trip data with the page access code.

  python3 crypt.py decrypt   # data.enc.json -> data.json (plaintext, git-ignored)
  python3 crypt.py encrypt   # data.json -> data.enc.json (commit this one)

The code is read from the AGU26_CODE environment variable, or prompted for.
Format: AES-256-GCM, key from PBKDF2-SHA256 (matches the WebCrypto code in index.html).
"""
import base64, getpass, json, os, sys
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

HERE = os.path.dirname(os.path.abspath(__file__))
PLAIN, ENC = os.path.join(HERE, "data.json"), os.path.join(HERE, "data.enc.json")
ITER = 600_000
b64e = lambda b: base64.b64encode(b).decode()
b64d = base64.b64decode


def key(code, salt, iterations):
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iterations)
    return kdf.derive(code.encode())


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("encrypt", "decrypt"):
        sys.exit(__doc__)
    code = os.environ.get("AGU26_CODE") or getpass.getpass("Access code: ")
    if sys.argv[1] == "encrypt":
        data = open(PLAIN, "rb").read()
        json.loads(data)  # refuse to encrypt invalid JSON
        salt, iv = os.urandom(16), os.urandom(12)
        ct = AESGCM(key(code, salt, ITER)).encrypt(iv, data, None)
        out = {"v": 1, "kdf": "PBKDF2-SHA256", "iter": ITER, "salt": b64e(salt), "iv": b64e(iv), "ct": b64e(ct)}
        json.dump(out, open(ENC, "w"))
        print("wrote", ENC)
    else:
        E = json.load(open(ENC))
        data = AESGCM(key(code, b64d(E["salt"]), E["iter"])).decrypt(b64d(E["iv"]), b64d(E["ct"]), None)
        open(PLAIN, "wb").write(data)
        print("wrote", PLAIN, "(do not commit)")


if __name__ == "__main__":
    main()
