# askar #401 reproduction (Credo 0.7.0)

Minimal Credo 0.7.0 agent that opens an Askar Postgres store and reproduces
[openwallet-foundation/askar#401](https://github.com/openwallet-foundation/askar/issues/401):
`invalid peer certificate: BadSignature` on linux/arm64 when connecting to an
SSL Postgres (e.g. AWS RDS).

The published linux-aarch64 binary is miscompiled. Askar cross-compiles its
linux libraries with `cross`, whose image carries an old assembler (binutils
2.29.1) that generates broken aarch64 crypto in ring, so rustls rejects the
server certificate with `BadSignature`. Only the linux-aarch64 binary is
affected, so the repro must run in a linux/arm64 container. On macOS/arm64 askar
loads the darwin binary instead and the bug does not appear.

Stack: Credo `0.7.0` -> askar-nodejs `0.6.0` -> native askar `v0.5.0`, Node 24, pnpm 11.

## 1. Reproduce the bug

```bash
cd 401-repro
docker run --rm -it --platform linux/arm64 \
  -e POSTGRES_URL='postgres://USER:PASSWORD@HOST:5432/DBNAME' \
  -v "$PWD":/app -v /app/node_modules -w /app \
  node:24-bookworm bash -c '
    corepack enable && corepack prepare pnpm@11 --activate
    pnpm install
    node index.ts'

[... snip ...]

askar-nodejs native target : linux-arm64
opening askar postgres store: host=example.cluster-foobar.eu-west-1.rds.amazonaws.com:5432 db=test account=test (sslmode=prefer)

RESULT: FAIL
Error during call to 'onInitializeContext' method in module 'askar' for agent context 'default'. | Error opening store test: Error connecting to database pool
Caused by: error communicating with database: invalid peer certificate: BadSignature

>>> REPRODUCED #401: TLS `BadSignature` from the askar native binary (rustls/ring). <<<
```

Expected: `>>> REPRODUCED #401: TLS BadSignature from the askar native binary (rustls/ring). <<<`

Credo's Askar config exposes no `sslmode` option; the driver default `prefer` still
performs the TLS handshake against an SSL-required server, which is where it fails.

## 2. Build a working native library (`libaries_askar.so.patched`)

There is no source change. The release workflow cross-compiles the linux
libraries with `cross`, whose `manylinux2014-cross` image ships binutils 2.29.1.
That assembler miscompiles ring's aarch64 assembly (briansmith/ring#1728): the
`-D__ARM_ARCH=8` flag in `build.yml` lets ring compile, but the emitted crypto is
wrong and TLS signature checks fail. Rebuild the linux-aarch64 library from an
unmodified askar checkout in a newer image whose binutils assembles that code
correctly:

```bash
# run from the askar repo root, unmodified (no source change needed)
docker run --rm --platform linux/arm64 \
  -v "$PWD":/askar -w /askar \
  -e CARGO_TARGET_DIR=/ctarget \
  quay.io/pypa/manylinux2014_aarch64 bash -c '
    curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs \
      | sh -s -- -y --profile minimal --default-toolchain 1.86.0
    export PATH="$HOME/.cargo/bin:$PATH"
    cargo build --lib --release
    cp /ctarget/release/libaries_askar.so 401-repro/libaries_askar.so.patched'
```

Notes:

- `quay.io/pypa/manylinux2014_aarch64` ships binutils 2.35 and gcc 10.2.1, newer
  than the binutils 2.29.1 in askar's release `cross` image, but it still targets
  glibc 2.17, so the rebuilt library keeps manylinux2014 compatibility.
- The image is arm64-native, so on a linux/arm64 host it builds without qemu.
- The build keeps ring and drops the `-D__ARM_ARCH=8` workaround, because binutils
  2.35 assembles ring's aarch64 code correctly. The flag only works around the
  older assembler.
- `aws-lc-rs` is not the fix. The old release assembler cannot build it either,
  and with a newer assembler ring compiles correctly, so the crypto provider does
  not need to change.

## 3. Test with the patched library

Same as step 1, but overwrite the downloaded native lib with the patched one
before running:

```bash
cd 401-repro
docker run --rm -it --platform linux/arm64 \
  -e POSTGRES_URL='postgres://USER:PASSWORD@HOST:5432/DBNAME' \
  -v "$PWD":/app -v /app/node_modules -w /app \
  node:24-bookworm bash -c '
    corepack enable && corepack prepare pnpm@11 --activate
    pnpm install
    cp /app/libaries_askar.so.patched \
      node_modules/.pnpm/@openwallet-foundation+askar-nodejs@0.6.0/node_modules/@openwallet-foundation/askar-nodejs/native/libaries_askar.so
    node index.ts'
```

Expected: `RESULT: OK -- askar opened the Postgres store over TLS. #401 NOT reproduced.`
