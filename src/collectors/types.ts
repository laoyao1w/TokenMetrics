import type { CollectorBatch, CollectorEnvironment } from "../core/types.js";

export interface Collector {
  id: string;
  displayName: string;
  collect(environment?: Partial<CollectorEnvironment>): Promise<CollectorBatch>;
}
