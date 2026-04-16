import { Transaction } from "../types";
import { Snapshot } from "./snapshot";

export interface SnapshotStore<S, TTx extends Transaction = Transaction> {
    load(tx: TTx, aggregateName: string, aggregateId: string): Promise<Snapshot<S> | null>;
    save(tx: TTx, snapshot: Snapshot<S>): Promise<void>;
  }
  