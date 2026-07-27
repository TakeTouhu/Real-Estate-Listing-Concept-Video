import type { MalwareScanner, ScanVerdict } from "@app/domain";
import { assertNotProduction, type ProductionGuardOptions } from "./production-guard";

export type PassthroughMalwareScannerOptions = ProductionGuardOptions;

/**
 * Integration boundary for malware scanning. Phase 2 ships a pass-through
 * scanner that additionally detects the EICAR test string, so quarantine
 * behaviour is exercisable end-to-end. A real engine (ClamAV, vendor API)
 * replaces this class without touching domain code.
 *
 * NOT PRODUCTION-SAFE: construction throws under NODE_ENV=production.
 */
export class PassthroughMalwareScanner implements MalwareScanner {
  /** Standard EICAR anti-malware test signature. */
  private static readonly EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR";

  constructor(options: PassthroughMalwareScannerOptions = {}) {
    assertNotProduction(
      "PassthroughMalwareScanner",
      "it performs no real malware analysis and only recognises the EICAR test signature",
      "configure a real malware-scanning engine behind the MalwareScanner port",
      options,
    );
  }

  scan(data: Uint8Array): Promise<{ verdict: ScanVerdict; detail?: string }> {
    const head = Buffer.from(data.subarray(0, 1024)).toString("latin1");
    if (head.includes(PassthroughMalwareScanner.EICAR)) {
      return Promise.resolve({ verdict: "INFECTED", detail: "EICAR test signature detected" });
    }
    return Promise.resolve({ verdict: "CLEAN" });
  }
}
