/**
 * Public surface. The outbox, scheduler, flush adapters and lifecycle helpers
 * stay internal — a consumer needs one function and the types around it.
 */
export { useWriteBehind } from './useWriteBehind'
export type {
  WriteBehind,
  WriteBehindBaseOptions,
  WriteBehindBatchOutcome,
  WriteBehindBatchWriter,
  WriteBehindFailure,
  WriteBehindKey,
  WriteBehindOptions,
  WriteBehindRetryOptions,
  WriteBehindSource,
  WriteBehindWriter,
} from './types'
