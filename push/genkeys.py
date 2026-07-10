#!/usr/bin/env python3
"""Genera un par de claves VAPID para Web Push. Se ejecuta UNA sola vez,
a mano (`docker compose run --rm push python3 /app/push/genkeys.py`).

Imprime VAPID_PRIVATE_KEY (escalar privado crudo, base64url) y
VAPID_PUBLIC_KEY (punto público sin comprimir, base64url) — este último es
el formato que `PushManager.subscribe({applicationServerKey})` espera en
el navegador. Copia ambas líneas a `.env`.
"""
from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid02
from py_vapid.utils import b64urlencode, num_to_bytes


def main() -> None:
    vapid = Vapid02()
    vapid.generate_keys()

    private_value = vapid.private_key.private_numbers().private_value
    private_key = b64urlencode(num_to_bytes(private_value, 32))

    public_point = vapid.public_key.public_bytes(
        serialization.Encoding.X962,
        serialization.PublicFormat.UncompressedPoint,
    )
    public_key = b64urlencode(public_point)

    print(f"VAPID_PRIVATE_KEY={private_key}")
    print(f"VAPID_PUBLIC_KEY={public_key}")


if __name__ == "__main__":
    main()
