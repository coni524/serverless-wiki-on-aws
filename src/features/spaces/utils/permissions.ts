import type { Permission } from '@/types/api';

/** `write` and `admin` both allow editing; `read` does not. */
export function canWrite(permission: Permission): boolean {
  return permission === 'write' || permission === 'admin';
}
