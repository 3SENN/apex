# TLS fixture for the smoke test

`key.pem` and `cert.pem` are a self-signed key and certificate (CN=Atelier smoke fixture, for 127.0.0.1 and
localhost, valid until 2036) for the offline smoke test only. `src/main/smokeServer.ts` serves its HTTPS fixture
pages on 127.0.0.1 with them, and the certificate interstitial checks rely on the certificate being untrusted.

This is not a secret: the key protects nothing, no browser or system trusts the certificate, and nothing outside the
smoke test uses either. Never use them for anything else.

To make a new pair:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -subj "/CN=Atelier smoke fixture" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" \
  -keyout tests/fixtures/tls/key.pem -out tests/fixtures/tls/cert.pem
```
