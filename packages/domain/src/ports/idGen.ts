import type { Id } from '../entities/common';

/** id port:完整 UUIDv4(INV-04)。 */
export interface IdGen {
  next(): Id;
}
