import { createHash } from "node:crypto";
import { setSha256 } from "./hash.js";

/** Node.js crypto 实现（与历史行为完全一致）。 */
export function registerNodeSha256(): void {
  setSha256((input) => createHash("sha256").update(input).digest("hex"));
}