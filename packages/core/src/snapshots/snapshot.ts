export type Snapshot<S> = {
    aggregateName: string;
    aggregateId: string;
    aggregateVersion: number;
    createdAt: string;
    snapshotSchemaVersion: number;
    state: S;
  };