// Minimal Credo 0.7.0 reproduction for openwallet-foundation/askar#401.
//
// Credo's Askar Postgres config takes host/credentials/db-name as components and
// has NO sslmode option, so the driver uses its default (sslmode=prefer). Against
// an SSL-required server that still performs the TLS handshake, which runs a
// rustls certificate signature check. That check fails with `BadSignature` on the
// published linux/arm64 binary, whose bundled ring crypto is miscompiled by the
// release cross-compile toolchain; the x86_64 binary is unaffected.
//
// agent.initialize() -> AskarStoreManager.getInitializedStoreWithProfile()
//   -> Store.open({ uri })  (TLS connect happens here)
//   -> Store.provision()    (if the database does not exist yet)
//
// Run inside a linux/arm64 container so askar-nodejs downloads
// `library-linux-aarch64.tar.gz` (the affected binary). See README.md for usage.

import { Agent } from "@credo-ts/core";
import { AskarModule } from "@credo-ts/askar";
import { agentDependencies } from "@credo-ts/node";
import { askar } from "@openwallet-foundation/askar-nodejs";
import { registerAskar } from "@openwallet-foundation/askar-shared";

registerAskar({ askar });

const databaseUrl = process.env.POSTGRES_URL;
if (!databaseUrl) {
  console.error(
    "Set POSTGRES_URL, e.g. POSTGRES_URL=postgres://user:pass@host:5432/dbname",
  );
  process.exit(2);
}

const url = new URL(databaseUrl);
const account = decodeURIComponent(url.username);
const password = decodeURIComponent(url.password);
const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
// store id == postgres database name (also the default askar profile)
const storeId =
  process.env.STORE_ID ??
  (url.pathname.replace(/^\//, "") || "askar_401_repro");
const walletKey = process.env.WALLET_KEY ?? "askar-401-repro-key";

const sslmode = url.searchParams.get("sslmode");

console.log(`askar-nodejs native target : ${process.platform}-${process.arch}`);
console.log(
  `opening askar postgres store: host=${host} db=${storeId} account=${account} (sslmode=prefer)`,
);

const agent = new Agent({
  config: { label: "askar-401-repro" },
  dependencies: agentDependencies,
  modules: {
    askar: new AskarModule({
      askar,
      store: {
        id: storeId,
        key: walletKey,
        database: {
          type: "postgres",
          config: { host },
          // admin* let askar CREATE DATABASE if `storeId` does not exist yet
          credentials: {
            account,
            password,
            adminAccount: account,
            adminPassword: password,
          },
        },
      },
    }),
  },
});

try {
  await agent.initialize();
  console.log(
    "\nRESULT: OK -- askar opened the Postgres store over TLS. #401 NOT reproduced.",
  );
  await agent.shutdown();
  process.exit(0);
} catch (error) {
  const err = error as { message?: string; cause?: { message?: string } };
  const detail = `${err.message ?? ""} | ${err.cause?.message ?? ""}`;
  console.error("\nRESULT: FAIL");
  console.error(detail);
  if (/BadSignature|invalid peer certificate/i.test(detail)) {
    console.error(
      "\n>>> REPRODUCED #401: TLS `BadSignature` from the askar native binary (rustls/ring). <<<",
    );
  } else {
    console.error(
      "\n(NOT the #401 TLS bug -- the TLS handshake did not fail with BadSignature; check creds/host/db)",
    );
  }
  process.exit(1);
}
