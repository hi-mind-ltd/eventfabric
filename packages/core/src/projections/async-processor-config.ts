export type AsyncProcessorConfig =
  | { enabled: false }
  | { enabled: true; topic?: string | null };