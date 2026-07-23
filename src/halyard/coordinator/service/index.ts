import type { Backend } from "../ports.js";
import { ServiceHttpClient, type ServiceHttpClientOptions } from "./client.js";
import { ServiceRecordStore } from "./record-store.js";
import { ServiceLaunchStore } from "./launch-store.js";
import { ServiceProposalStore } from "./proposal-store.js";
import { ServiceLedgerStore } from "./ledger-store.js";
import { ServiceCanonStore } from "./canon-store.js";

export { ServiceHttpClient, ServiceHttpError } from "./client.js";
export type { ServiceHttpClientOptions } from "./client.js";

/** Assemble the service `Backend` from one shared HTTP client. */
export function makeServiceBackend(opts: ServiceHttpClientOptions): Backend {
  const client = new ServiceHttpClient(opts);
  return {
    records: new ServiceRecordStore(client),
    launches: new ServiceLaunchStore(client),
    proposals: new ServiceProposalStore(client),
    ledger: new ServiceLedgerStore(client),
    canon: new ServiceCanonStore(client),
  };
}
